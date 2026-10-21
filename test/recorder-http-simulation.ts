// Actual recorder and adapter against loopback HTTP, using synthetic credentials only.
import assert from 'node:assert/strict';
import {CandleStore,SessionRecorder,resolveWatchlist} from '../src/recorder.js';
import {DhanProvider,ENDPOINTS,type Fetcher} from '../src/dhan.js';
import {at} from '../src/model.js';
let scenario='normal';const seen:string[]=[];
const transport:Fetcher=async(input,init)=>{
 const original=String(input);assert.ok(Object.values(ENDPOINTS).some(e=>e.url===original));
 const url=new URL(original);seen.push(url.pathname);
 if(url.pathname.endsWith('/intraday'))assert.match(JSON.parse(String(init?.body)).fromDate,/09:14:59$/);
 return fetch(`http://127.0.0.1:4900/dhan${url.pathname}`,{...init,headers:{...init?.headers,'x-recorder-fixture':scenario}});
};
const provider=new DhanProvider({clientId:'fixture-client',token:'fixture-token',candleStartVerified:false,quoteTimezoneVerified:false},transport);
const items=resolveWatchlist((await provider.instruments()).items),store=new CandleStore(':memory:');
const recorder=new SessionRecorder(store,provider,items,'2026-10-21','mock',0);
try{
 let r=await recorder.poll(at('2026-10-21','09:27'));assert.equal(r.instruments[0]!.storedCandles,2);assert.equal(r.instruments[0]!.excludedIncomplete,1);
 r=await recorder.poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.status==='complete'&&i.storedCandles===75));
 r=await recorder.poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.newCandles===0));
 for(const status of ['500','429','401']){scenario=status;r=await recorder.poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.status==='fetch_error'&&i.error===`DHAN_HTTP_${status}`&&i.storedCandles===75));}
 for(const mode of ['duplicate','invalid']){scenario=mode;r=await recorder.poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.status==='fetch_error'&&i.storedCandles===75));}
 scenario='revised';r=await recorder.poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.revisedCandles===1&&i.status==='complete'));
 const empty=new CandleStore(':memory:');try{scenario='gap';r=await new SessionRecorder(empty,provider,items,'2026-10-21','mock',0).poll(at('2026-10-21','15:35'));assert.ok(r.instruments.every(i=>i.status==='missing_data'&&i.missingSlots.length===3));}finally{empty.close();}
 assert.ok(seen.includes('/api-data/api-scrip-master-detailed.csv'));assert.ok(seen.includes('/v2/charts/intraday'));
 console.log(JSON.stringify({status:'passed',network:'loopback_only',credentials:'synthetic',scenarios:['completed','incomplete','repeat','500','429','401','duplicate','invalid','revision','missing_tail'],requests:seen.length}));
}finally{store.close();}
