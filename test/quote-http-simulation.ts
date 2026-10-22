import assert from 'node:assert/strict';
import {collectQuotes} from '../src/quote-recorder.js';
let count=0;
const transport=(status?:string):typeof fetch=>async(input,init)=>{assert.equal(String(input),'https://api.dhan.co/v2/marketfeed/quote');assert.deepEqual(JSON.parse(String(init?.body)),{NSE_EQ:[999001]});count++;return fetch('http://127.0.0.1:4900/dhan/v2/marketfeed/quote',{...init,headers:{...init?.headers,...(status?{'x-mock-response-code':status}:{})}});};
const env={DHAN_CLIENT_ID:'synthetic-client',DHAN_ACCESS_TOKEN:'synthetic-token'},items=[{symbol:'MOCK_EQ',securityId:'999001'}];
const rows=await collectQuotes(items,env,transport());assert.equal(rows[0]!.lastPrice,103);assert.equal(rows[0]!.sourceTimestampVerified,false);
for(const code of ['401','429'])await assert.rejects(()=>collectQuotes(items,env,transport(code)),new RegExp('DHAN_HTTP_'+code));
console.log(JSON.stringify({passed:true,network:'loopback_only',requests:count,scenarios:['quote','401','429'],credentials:'synthetic'}));
