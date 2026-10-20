// Explicit developer-only HTTP fixture probe. Never used by the stdio server.
import assert from 'node:assert/strict';
import {DhanProvider,ENDPOINTS,type Fetcher} from '../src/dhan.js';
const seen:string[]=[];
const transport=(status?:string):Fetcher=>async(input,init)=>{
 const original=String(input);assert.ok(Object.values(ENDPOINTS).some(e=>e.url===original));
 const url=new URL(original);seen.push(url.pathname);
 // Fixed loopback mapping, never read credentials/environment or accept an arbitrary destination.
 return fetch(`http://127.0.0.1:4900/dhan${url.pathname}`,{...init,headers:{...init?.headers,...(status?{'x-mock-response-code':status}:{})}});
};
const config={clientId:'fixture-client',token:'fixture-token',candleStartVerified:true,quoteTimezoneVerified:false};
const p=new DhanProvider(config,transport());
assert.equal((await p.instruments()).items[0]?.securityId,'999001');
assert.equal((await p.quote('999001')).lastPrice,103);
const batch=await p.candles('999001','2026-10-21T09:15:00+05:30','2026-10-21T09:30:00+05:30');assert.equal(batch.candles.length,3);
for(const status of ['401','429']){const q=new DhanProvider(config,transport(status));await assert.rejects(()=>q.quote('999001'),new RegExp(`DHAN_HTTP_${status}`));}
assert.ok(seen.includes('/v2/charts/intraday'));
process.stdout.write(JSON.stringify({status:'passed',network:'loopback_only',credentials:'synthetic',requests:seen})+'\n');
