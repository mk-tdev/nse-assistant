import assert from 'node:assert/strict';
import {collectQuotes} from '../src/quote-recorder.js';
const paths:string[]=[];
const fixture:typeof fetch=async(url,init)=>{assert.equal(String(url),'https://api.dhan.co/v2/marketfeed/quote');const body=JSON.parse(String(init?.body));assert.deepEqual(body,{NSE_EQ:[999001],MCX_COMM:[571445,483080]});paths.push(new URL(String(url)).pathname);return fetch('http://127.0.0.1:4900/dhan/v2/marketfeed/quote',{...init,headers:{...init?.headers,'x-paper-console-fixture':'mcx'}});};
const result=await collectQuotes([{symbol:'MOCK_EQ',securityId:'999001'},{symbol:'GOLDM-2026-11-05',securityId:'571445',exchangeSegment:'MCX_COMM'},{symbol:'SILVERM-2026-11-30',securityId:'483080',exchangeSegment:'MCX_COMM'}],{DHAN_CLIENT_ID:'synthetic',DHAN_ACCESS_TOKEN:'synthetic'},fixture);
assert.equal(result.length,3);assert.equal(result[0]!.lastPrice,103);assert.equal(result[1]!.lastPrice,150000);assert.equal(result[2]!.lastPrice,150000);assert.ok(result.every(r=>'sourceTimestampVerified' in r&&r.sourceTimestampVerified===false));console.log(JSON.stringify({passed:true,network:'loopback_only',paths,rows:result.length,credentials:'synthetic'}));
