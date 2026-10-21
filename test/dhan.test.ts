import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DhanProvider,ENDPOINTS,parseCandles,redact,type Fetcher} from '../src/dhan.js';
const fixture=async(name:string)=>readFile(new URL(`../fixtures/${name}`,import.meta.url),'utf8');
const config={clientId:'fixture-client',token:'fixture-token',candleStartVerified:true,quoteTimezoneVerified:false};
test('parallel array length, chronological order, OHLC and missing volume validation',async()=>{
 const raw=JSON.parse(await fixture('candles.json'));
 assert.equal(parseCandles(raw,0,'fixture',true).candles.length,3);
 assert.throws(()=>parseCandles({...raw,close:[1]},0,'fixture',true));
 assert.throws(()=>parseCandles({...raw,timestamp:[...raw.timestamp].reverse()},0,'fixture',true));
 assert.throws(()=>parseCandles({...raw,low:[999,999,999]},0,'fixture',true));
 delete raw.volume;const result=parseCandles(raw,0,'fixture',true);assert.equal(result.candles[0]?.volume,null);assert.deepEqual(result.missing,['historical_volume_missing']);
});
test('adapter only calls allowlisted URLs, resolves instrument, redacts auth on public CSV',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const fetcher:Fetcher=async(input,init)=>{
 const url=String(input);calls.push({url,init:init!});
 assert.ok(Object.values(ENDPOINTS).some(e=>e.url===url));assert.equal(init?.redirect,'error');assert.ok(init?.signal);
 return new Response(await fixture(url.endsWith('.csv')?'instruments.csv':url.endsWith('quote')?'quote.json':'candles.json'),{status:200});
 };
 const p=new DhanProvider(config,fetcher);assert.equal((await p.instruments()).items[0]?.name,'Synthetic Equity, Limited');
 const quote=await p.quote('999001');assert.equal(quote.freshness,'unknown');assert.equal(quote.sourceTimestamp,null);
 const publicHeaders=calls[0]!.init.headers as Record<string,string>;assert.equal(publicHeaders['access-token'],undefined);
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{NSE_EQ:[999001]});
 assert.equal((calls[1]!.init.headers as Record<string,string>)['access-token'],'fixture-token');
 await assert.rejects(()=>p.quote('1'),/UNKNOWN_NSE/);
 assert.equal(calls.length,2);
});
test('upstream errors and transport errors do not echo secrets or third-party body',async()=>{
 const p=new DhanProvider(config,async()=>new Response('secret fixture-token',{status:401}));await assert.rejects(()=>p.instruments(),/^Error: DHAN_HTTP_401$/);
 const q=new DhanProvider(config,async()=>{throw new Error('fixture-token');});await assert.rejects(()=>q.instruments(),/^Error: DHAN_REQUEST_FAILED$/);
});
test('no placeholder credentials; history date ranges bounded',async()=>{
 assert.throws(()=>new DhanProvider({...config,token:'REPLACE_WITH_TOKEN'}));
 const p=new DhanProvider(config,async()=>{throw Error('must not fetch');});
 await assert.rejects(()=>p.candles('999001','2026-01-01','2026-10-01'),/MAX_90_DAYS/);
});
test('log redaction removes provided secrets, headers and JWT-shaped tokens',()=>{
 const r=redact({'access-token':'ABC','client-id':'xyz',authorization:'BearerSecret',message:'fixture-token eyJabc.abc.def'},['fixture-token']);
 for(const s of ['ABC','xyz','BearerSecret','fixture-token','eyJabc'])assert.equal(r.includes(s),false);
});
test('verified quote trade time distinguishes stale from unknown and reports missing fields',async()=>{
 const stamp=new Date(Date.now()-120_000+330*60_000).toISOString();
 const ddmmyyyy=`${stamp.slice(8,10)}/${stamp.slice(5,7)}/${stamp.slice(0,4)} ${stamp.slice(11,19)}`;
 const fetcher:Fetcher=async(input)=>new Response(String(input).endsWith('.csv')?await fixture('instruments.csv'):JSON.stringify({status:'success',data:{NSE_EQ:{'999001':{last_price:103,last_trade_time:ddmmyyyy}}}}));
 const p=new DhanProvider({...config,quoteTimezoneVerified:true},fetcher);
 const q=await p.quote('999001');assert.equal(q.freshness,'stale');assert.equal(q.sourceTimeZone,'Asia/Kolkata');assert.ok((q.ageMs as number)>=120_000);assert.deepEqual(q.missingData,['volume','broker_session_vwap']);
});
test('redaction removes opaque bearer tokens including whitespace-delimited values',()=>{
 for(const value of [{authorization:'Bearer opaque-token'},'Authorization: Bearer opaque-token','access-token="opaque-token with spaces"']){
 const result=redact(value);assert.equal(result.includes('opaque-token'),false);assert.equal(result.includes('with spaces'),false);
 }
 assert.equal(Object.isFrozen(ENDPOINTS),true);for(const endpoint of Object.values(ENDPOINTS))assert.equal(Object.isFrozen(endpoint),true);
});
test('detailed master uses underlying trading symbol instead of the company-name column',async()=>{
 const csv='EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,SERIES\nNSE,E,1333,EQUITY,HDFCBANK,HDFC BANK LTD,HDFC Bank,EQ\nNSE,E,11536,EQUITY,TCS,TATA CONSULTANCY SERV LT,Tata Consultancy Services,EQ\n';
 const p=new DhanProvider(config,async()=>new Response(csv));
 assert.deepEqual((await p.instruments()).items.map(i=>i.symbol),['HDFCBANK','TCS']);
});
