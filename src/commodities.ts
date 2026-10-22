import {parse} from 'csv-parse/sync';
import {day,at,FIVE,validDate,validCandle,type Candle} from './model.js';
import {parseCandles} from './dhan.js';
export type CommodityContract={symbol:string;securityId:string;name:string;underlying:'GOLDM'|'SILVERM';exchangeSegment:'MCX_COMM';instrument:'FUTCOM';expiry:string;apiLotSize:number;multiplier:number;tickSize:number;tradingUnit:string;quotationUnit:string};
const specs={GOLDM:{multiplier:10,tradingUnit:'100 grams / lot',quotationUnit:'INR per 10 grams'},SILVERM:{multiplier:5,tradingUnit:'5 kg / lot',quotationUnit:'INR per kg'}} as const;
export function selectCommodityContracts(csv:string,date:string){
 if(!validDate(date))throw Error('MCX_INVALID_DATE');
 const rows=parse(csv,{columns:true,skip_empty_lines:true,bom:true}) as Record<string,string>[];
 return (['GOLDM','SILVERM'] as const).map(underlying=>{
  // Seven-day buffer avoids intentionally opening a new simulation in the delivery/expiry window.
  const cutoff=new Date(Date.parse(date)+7*86400000).toISOString().slice(0,10);
  const matches=rows.filter(r=>r.EXCH_ID==='MCX'&&r.SEGMENT==='M'&&r.INSTRUMENT==='FUTCOM'&&r.UNDERLYING_SYMBOL===underlying&&validDate(r.SM_EXPIRY_DATE??'')&&r.SM_EXPIRY_DATE!>cutoff&&/^\d+$/.test(r.SECURITY_ID??'')&&Number(r.LOT_SIZE)===1&&Number(r.TICK_SIZE)>0).sort((a,b)=>a.SM_EXPIRY_DATE!.localeCompare(b.SM_EXPIRY_DATE!));
  const r=matches[0];if(!r||matches.filter(x=>x.SM_EXPIRY_DATE===r.SM_EXPIRY_DATE).length!==1)throw Error('MCX_CONTRACT_MAPPING_UNAVAILABLE');
  return {symbol:underlying+'-'+r.SM_EXPIRY_DATE,underlying,securityId:r.SECURITY_ID!,name:r.DISPLAY_NAME!,exchangeSegment:'MCX_COMM' as const,instrument:'FUTCOM' as const,expiry:r.SM_EXPIRY_DATE!,apiLotSize:1,tickSize:Number(r.TICK_SIZE)/100,...specs[underlying]};
 });
}
export async function fetchCommodityMaster(date:string,fetcher:typeof fetch=fetch){
 const res=await fetcher('https://images.dhan.co/api-data/api-scrip-master-detailed.csv',{redirect:'error',signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error('MCX_MASTER_HTTP_'+res.status);return selectCommodityContracts(await res.text(),date);
}
export function commodityHours(now:number){const date=day(now),weekday=new Date(date).getUTCDay();return weekday!==0&&weekday!==6&&now>=at(date,'09:00')&&now<at(date,'23:30');}
export async function commodityCandles(c:CommodityContract,date:string,env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch,now=Date.now()){
 if(!env.DHAN_ACCESS_TOKEN||!env.DHAN_CLIENT_ID)throw Error('MCX_CREDENTIALS_MISSING');
 const start=at(date,'09:00'),end=Math.min(at(date,'23:30'),Math.floor((now-10000)/FIVE)*FIVE);if(end<=start)return [];
 const local=(t:number)=>new Date(t+330*60000).toISOString().slice(0,19).replace('T',' ');
 const res=await fetcher('https://api.dhan.co/v2/charts/intraday',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','access-token':env.DHAN_ACCESS_TOKEN,'client-id':env.DHAN_CLIENT_ID},body:JSON.stringify({securityId:c.securityId,exchangeSegment:'MCX_COMM',instrument:'FUTCOM',interval:'5',oi:false,fromDate:local(start-1000),toDate:local(end)})});
 if(!res.ok)throw Error('DHAN_HTTP_'+res.status);const batch=parseCandles(await res.json(),Date.now(),'Dhan REST MCX futures',false);
 return batch.candles.filter(b=>validCandle(b)&&b.start>=start&&b.start+FIVE<=end&&day(b.start)===date) as Candle[];
}
