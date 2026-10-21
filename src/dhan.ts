import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { day, TZ, validCandle, type Batch, type Candle, type Instrument } from './model.js';
export const ENDPOINTS = Object.freeze({ instruments: Object.freeze({ method:'GET',url:'https://images.dhan.co/api-data/api-scrip-master-detailed.csv' }), quote:Object.freeze({method:'POST',url:'https://api.dhan.co/v2/marketfeed/quote'}), candles:Object.freeze({method:'POST',url:'https://api.dhan.co/v2/charts/intraday'}) });
export type Fetcher = typeof fetch;
export interface Provider {
  source: string;
  instruments(): Promise<{items:Instrument[];fetchedAt:number}>;
  quote(id:string): Promise<Record<string,unknown>>;
  candles(id:string,from:string,to:string): Promise<Batch>;
}
export function redact(value: unknown, secrets: string[] = []): string {
  let s = typeof value==='string'?value:(JSON.stringify(value)??String(value));
  for(const secret of secrets.filter(Boolean)) s=s.split(secret).join('[REDACTED]');
  return s.replace(/((?:access[-_]?token|authorization|client[-_]?id|app[-_]?secret|api[-_]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)/gi,'$1"[REDACTED]"').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED]');
}
export function parseCandles(raw: unknown, fetchedAt:number, source:string, verified:boolean): Batch {
  const obj=z.object({timestamp:z.array(z.number().int().nonnegative()),open:z.array(z.number()),high:z.array(z.number()),low:z.array(z.number()),close:z.array(z.number()),volume:z.array(z.number().nonnegative().nullable()).optional()}).parse(raw);
  const n=obj.timestamp.length;
  if ([obj.open,obj.high,obj.low,obj.close,...(obj.volume?[obj.volume]:[])].some(a=>a.length!==n)) throw new Error('DHAN_INVALID_PARALLEL_ARRAY_LENGTHS');
  const candles: Candle[]=obj.timestamp.map((t,i)=>({start:t*1000,open:obj.open[i]!,high:obj.high[i]!,low:obj.low[i]!,close:obj.close[i]!,volume:obj.volume?.[i]??null}));
  if(candles.some((c,i)=>!validCandle(c) || i>0 && c.start<=candles[i-1]!.start)) throw new Error('DHAN_INVALID_CANDLE_ORDER_OR_OHLC');
  return { candles,fetchedAt,source,candleStartVerified:verified,missing:obj.volume?.every(v=>v!==null)?[]:['historical_volume_missing'] };
}
class Gate {
  private tail=Promise.resolve(); private next=0; private count=0; private date='';
  constructor(private spacing:number,private daily:number){}
  run<T>(fn:()=>Promise<T>):Promise<T> {
    const task=this.tail.then(async()=>{
      const today=new Date().toISOString().slice(0,10); if(this.date!==today){this.date=today;this.count=0;}
      if(this.count>=this.daily)throw new Error('LOCAL_DAILY_DATA_LIMIT');
      while(performance.now()<this.next) await new Promise(r=>setTimeout(r,Math.ceil(this.next-performance.now())));
      this.next=performance.now()+this.spacing;this.count++;
      return fn();
    }); this.tail=task.then(()=>{},()=>{});return task;
  }
}
// Shared across instances in this process. Multiple processes require a shared limiter before live use.
const quoteGate=new Gate(1000,100000),historyGate=new Gate(200,100000);
export class DhanProvider implements Provider {
  source='Dhan REST v2'; private master?:{items:Instrument[];fetchedAt:number};
  constructor(private config:{clientId:string;token:string;candleStartVerified:boolean;quoteTimezoneVerified:boolean},private fetcher:Fetcher=fetch) {
    if(!config.clientId || !config.token || /REPLACE|PLACEHOLDER/i.test(config.clientId+config.token))throw new Error('LIVE_CREDENTIALS_NOT_CONFIGURED');
  }
  private async request(key:keyof typeof ENDPOINTS,body?:unknown):Promise<Response>{
    const endpoint=ENDPOINTS[key];
    // No caller-controlled URL, path, method, auth endpoint, or redirects.
    try {
      const response=await this.fetcher(endpoint.url,{method:endpoint.method,redirect:'error',signal:AbortSignal.timeout(10_000),headers:key==='instruments'?{accept:'text/csv'}:{'Content-Type':'application/json','access-token':this.config.token,'client-id':this.config.clientId},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok)throw new Error(`DHAN_HTTP_${response.status}`);
      return response;
    } catch(error) { throw new Error(error instanceof Error && /^DHAN_HTTP_\d+$/.test(error.message)?error.message:'DHAN_REQUEST_FAILED'); }
  }
  async instruments(){
    if(this.master && Date.now()-this.master.fetchedAt<3_600_000)return this.master;
    const response=await this.request('instruments');
    const rows=parse(await response.text(),{columns:true,skip_empty_lines:true,bom:true}) as Record<string,string>[];
    const items:Instrument[]=rows.filter(r=>r.EXCH_ID==='NSE' && r.SEGMENT==='E' && r.INSTRUMENT==='EQUITY' && r.SERIES==='EQ').map(r=>({securityId:r.SECURITY_ID??'',symbol:r.UNDERLYING_SYMBOL||r.SYMBOL_NAME||'',name:r.DISPLAY_NAME??'',exchangeSegment:'NSE_EQ',instrument:'EQUITY'}));
    if(!items.length || items.some(i=>!/^\d+$/.test(i.securityId)||!i.symbol))throw new Error('DHAN_INVALID_INSTRUMENT_MASTER');
    return this.master={items,fetchedAt:Date.now()};
  }
  private async resolve(id:string){if(!(await this.instruments()).items.some(i=>i.securityId===id))throw new Error('UNKNOWN_NSE_EQUITY_SECURITY_ID');}
  async quote(id:string){
    await this.resolve(id);
    return quoteGate.run(async()=>{
      const raw=await (await this.request('quote',{NSE_EQ:[Number(id)]})).json() as {status?:string;data?:{NSE_EQ?:Record<string,unknown>}};
      if(raw.status!=='success')throw new Error('DHAN_QUOTE_UNSUCCESSFUL');
      const q=z.object({last_price:z.number().positive(),last_trade_time:z.string().optional(),volume:z.number().nonnegative().optional(),average_price:z.number().optional()}).parse(raw.data?.NSE_EQ?.[id]);
      const fetchedAt=Date.now(); let tradeTime:number|null=null;
      // Docs show DD/MM/YYYY HH:mm:ss, but timezone is not explicit. Require operator verification.
      if(this.config.quoteTimezoneVerified && q.last_trade_time){
        const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(q.last_trade_time);
        if(m){const iso=`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`;const t=Date.parse(iso);if(Number.isFinite(t)&&day(t)===`${m[3]}-${m[2]}-${m[1]}`&&t<=fetchedAt&&fetchedAt-t<365*86400000)tradeTime=t;}
      }
      const age=tradeTime===null?null:fetchedAt-tradeTime;
      return {securityId:id,lastPrice:q.last_price,brokerSessionVwap:q.average_price&&q.average_price>0?q.average_price:null,volume:q.volume??null,source:this.source,timeZone:TZ,sourceTimeZone:this.config.quoteTimezoneVerified?TZ:'unverified',fetchedAt:new Date(fetchedAt).toISOString(),sourceTimestamp:tradeTime===null?null:new Date(tradeTime).toISOString(),rawSourceTimestamp:q.last_trade_time??null,freshness:age===null?'unknown':age>60_000?'stale':'fresh',ageMs:age,missingData:[...(tradeTime===null?['verified_quote_timestamp']:[]),...(q.volume===undefined?['volume']:[]),...(!q.average_price||q.average_price<=0?['broker_session_vwap']:[])]};
    });
  }
  async candles(id:string,from:string,to:string){
    if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>90*86400000)throw new Error('INVALID_HISTORY_RANGE_MAX_90_DAYS');
    await this.resolve(id);
    const local=(s:string)=>new Date(Date.parse(s)+330*60000).toISOString().slice(0,19).replace('T',' ');
    return historyGate.run(async()=>{
      const raw=await (await this.request('candles',{securityId:id,exchangeSegment:'NSE_EQ',instrument:'EQUITY',interval:'5',oi:false,fromDate:local(from),toDate:local(to)})).json();
      const batch=parseCandles(raw,Date.now(),this.source,this.config.candleStartVerified);
      batch.candles=batch.candles.filter(c=>c.start>=Date.parse(from)&&c.start<Date.parse(to));
      return batch;
    });
  }
}
