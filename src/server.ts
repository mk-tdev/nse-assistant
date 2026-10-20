import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { analyze } from './analysis.js';
import { DhanProvider, redact, type Provider } from './dhan.js';
import { at, FIVE, metadata, validDate, type Calendar } from './model.js';
import { MockProvider, mockCalendar, MOCK_AS_OF, MOCK_DATE } from './mock.js';
const dateSchema=z.string().refine(validDate,'Use a real YYYY-MM-DD date');
const idSchema=z.string().regex(/^\d{1,12}$/);
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
export function createServer(provider:Provider,calendar:Calendar,mock=false){
  const server=new McpServer({name:'dhan-read-only-market-data',version:'0.1.0'});
  const wrap=(fn:()=>Promise<unknown>)=>fn().then(data=>({content:[{type:'text' as const,text:JSON.stringify(data)}]})).catch(error=>{
    // Never return third-party bodies, arbitrary exception messages, headers, or credentials.
    const message=error instanceof Error&&/^(DHAN_[A-Z_0-9]+|UNKNOWN_[A-Z_]+|INVALID_[A-Z_0-9]+|LOCAL_[A-Z_]+)$/.test(error.message)?error.message:'DATA_UNAVAILABLE_OR_INVALID';
    return {isError:true,content:[{type:'text' as const,text:JSON.stringify({status:'error',code:message,source:provider.source,timeZone:'Asia/Kolkata',missingData:['requested_data_unavailable'],validSignal:false})}]};
  });
  server.registerTool('instrument_lookup',{description:'Find NSE EQ-series cash equities by symbol/name or exact security ID. Never guess an ID. Mock results are synthetic.',inputSchema:z.object({query:z.string().trim().min(1).max(100),limit:z.number().int().min(1).max(50).default(10)}),annotations},({query,limit})=>wrap(async()=>{
    const master=await provider.instruments(),q=query.toUpperCase();const matches=master.items.filter(i=>i.securityId===query||i.symbol.toUpperCase().includes(q)||i.name.toUpperCase().includes(q));
    return {source:provider.source,timeZone:'Asia/Kolkata',fetchedAt:new Date(master.fetchedAt).toISOString(),freshness:mock?'mock_only':Date.now()-master.fetchedAt>3_600_000?'stale':'retrieved_recently_source_revision_unknown',missingData:[],totalMatches:matches.length,items:matches.slice(0,limit)};
  }));
  server.registerTool('timestamped_quote',{description:'Read-only Dhan snapshot with exchange trade timestamp when verified; retrieval time alone never proves freshness. No candle construction.',inputSchema:z.object({securityId:idSchema}),annotations},({securityId})=>wrap(()=>provider.quote(securityId)));
  server.registerTool('historical_five_minute_candles',{description:'NSE equity five-minute OHLCV for one regular session; incomplete bars excluded and missing slots reported. Historical freshness is relative to requested as-of, not a live signal.',inputSchema:z.object({securityId:idSchema,date:dateSchema}),annotations},({securityId,date})=>wrap(async()=>{
    const now=mock?MOCK_AS_OF:Date.now(),asOf=Math.min(now,at(date,'15:30'));
    if(at(date,'09:15')>now)throw new Error('INVALID_FUTURE_SESSION');
    const batch=await provider.candles(securityId,new Date(at(date,'09:15')).toISOString(),new Date(at(date,'15:30')).toISOString());
    const candles=batch.candles.filter(c=>c.start+FIVE<=asOf),missingSlots:string[]=[];
    for(let t=at(date,'09:15');t+FIVE<=asOf;t+=FIVE)if(!candles.some(c=>c.start===t))missingSlots.push(new Date(t).toISOString());
    return {...metadata(batch,asOf,date),mode:mock?'mock':'historical_data',missingData:[...metadata(batch,asOf,date).missingData,...missingSlots.map(t=>`missing_slot:${t}`)],incompleteBarsExcluded:batch.candles.length-candles.length,candles:candles.map(c=>({...c,start:new Date(c.start).toISOString(),end:new Date(c.start+FIVE).toISOString()}))};
  }));
  server.registerTool('opening_range_breakout_analysis',{description:'Read-only analysis from 2026-10-21. Exact strategy qualification remains unverified without timestamp-aligned exact session VWAP; validSignal and currentSignal are always false. A separate approximateAnalysis contains at most one hypothetical long trade. 09:15–09:30 IST range, completed five-minute close above high and explicitly approximate bar VWAP, >=1.5x prior 20-session same-slot median volume. Signal close <=11:00, next candle entry, OR-low stop, 2R target, 15:15 exit. Blocks missing/stale data; replay is never a current signal.',inputSchema:z.object({securityId:idSchema,date:dateSchema,asOf:z.iso.datetime({offset:true}).optional()}),annotations},({securityId,date,asOf})=>wrap(async()=>{
    const now=mock?MOCK_AS_OF:Date.now(),evaluation=asOf?Date.parse(asOf):now;
    if(evaluation>now)throw new Error('INVALID_FUTURE_AS_OF');
    const previous=calendar.sessions.filter(d=>d<date).sort().slice(-20);
    const from=previous[0]??date;
    const batch=await provider.candles(securityId,new Date(at(from,'09:15')).toISOString(),new Date(Math.min(evaluation,at(date,'15:30'))).toISOString());
    const result=analyze(batch,calendar,date,evaluation);
    return {...result,mode:mock?'mock':asOf?'historical_replay':'paper_analysis',currentSignal:false,liveConnected:!mock,mockReferenceDate:mock?MOCK_DATE:undefined};
  }));
  return server;
}
export async function configuredServer(){
  const mode=process.env.DHAN_MODE??'mock';
  if(mode==='mock')return createServer(new MockProvider(),mockCalendar,true);
  if(mode!=='live')throw new Error('INVALID_DHAN_MODE');
  let calendar:Calendar={source:'not configured',verified:false,sessions:[]};
  if(process.env.DHAN_CALENDAR_PATH){
    calendar=z.object({source:z.string().min(1),verified:z.boolean(),sessions:z.array(dateSchema)}).parse(JSON.parse(await readFile(process.env.DHAN_CALENDAR_PATH,'utf8')));
    if(new Set(calendar.sessions).size!==calendar.sessions.length)throw new Error('INVALID_DUPLICATE_CALENDAR_SESSION');
  }
  return createServer(new DhanProvider({clientId:process.env.DHAN_CLIENT_ID??'',token:process.env.DHAN_ACCESS_TOKEN??'',candleStartVerified:process.env.DHAN_CANDLE_START_VERIFIED==='true',quoteTimezoneVerified:process.env.DHAN_QUOTE_TIMEZONE_VERIFIED==='true'}),calendar);
}
export function logFailure(){ process.stderr.write(redact('Server startup failed. Check local configuration; secrets and exception details omitted.')+'\n'); }
