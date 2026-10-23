import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {at,FIVE,type Candle,type Instrument,type Batch} from '../src/model.js';
import type {Provider} from '../src/dhan.js';
import {CandleStore} from '../src/recorder.js';
import {ControlStore} from '../src/paper-control-store.js';
import {prepare} from '../src/prepare-watchlists.js';

const date='2027-06-01'; // far enough past "today" that the real-clock freeze-window check never trips in CI.
const previous=Array.from({length:20},(_,i)=>{const d=new Date(Date.parse(date+'T00:00:00Z'));d.setUTCDate(d.getUTCDate()-(20-i));return d.toISOString().slice(0,10);}).sort();
const reliance:Instrument={securityId:'500325',symbol:'RELIANCE',name:'Reliance Industries',exchangeSegment:'NSE_EQ',instrument:'EQUITY'};
const alwaysFailFetch:typeof fetch=async()=>{throw Error('network disabled in this test');};
function neverCalledProvider():Provider{
 return {source:'synthetic-watchlist-test',
  async instruments(){return {items:[reliance],fetchedAt:Date.now()};},
  async quote(){throw Error('quotes are not used by prepare()');},
  async candles(){throw Error('provider.candles must not be called once history is already stored');}};
}
/** Thin morning-window history: 18 slots/day, well below the liquidity floor on purpose. */
function seedThinHistory(dir:string){
 const store=new CandleStore(join(dir,'candles.sqlite'));
 try{for(const d of previous){
  const bars:Candle[]=Array.from({length:18},(_,i)=>({start:at(d,'09:30')+i*FIVE,open:10,high:10.5,low:9.5,close:10,volume:100}));
  store.save(d,reliance,bars,at(d,'15:35'),{source:'synthetic',candleStartVerified:true,missing:[]});
 }}finally{store.close();}
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'nse-watchlist-dir-')),controlDir=mkdtempSync(join(tmpdir(),'nse-watchlist-control-')),calendarDir=mkdtempSync(join(tmpdir(),'nse-watchlist-cal-'));
 const calendarPath=join(calendarDir,'calendar.json');
 writeFileSync(calendarPath,JSON.stringify({source:'synthetic test calendar',kind:'scheduled_regular_sessions',validFrom:previous[0],validThrough:date,sessions:[...previous,date]}));
 seedThinHistory(dir);
 return {dir,controlDir,env:{PAPER_CALENDAR_PATH:calendarPath},close(){rmSync(dir,{recursive:true,force:true});rmSync(controlDir,{recursive:true,force:true});rmSync(calendarDir,{recursive:true,force:true});}};
}

test('an operator-submitted symbol is accepted ahead of auto-screened candidates and bypasses the liquidity floor; an unresolvable one is rejected and the request is finished',async()=>{
 const x=setup();
 try{
  const queue=new ControlStore(x.controlDir),requestId=randomUUID();
  queue.enqueue(requestId,'custom-watchlist-update',{requestId,symbols:['RELIANCE','BADTICKER']});
  queue.close();
  await prepare(date,x.dir,x.controlDir,neverCalledProvider(),x.env,alwaysFailFetch);
  const w=JSON.parse(readFileSync(join(x.dir,`${date}.watchlists.json`),'utf8'));
  const accepted=w.accepted.find((a:any)=>a.symbol==='RELIANCE');
  assert.ok(accepted,'RELIANCE should be accepted despite thin volume/turnover');
  assert.deepEqual(accepted.sources,['custom']);
  assert.ok(accepted.medianObservedTurnover<10_000_000,'fixture deliberately stays under the auto-screener floor');
  assert.equal(w.rejected.find((r:any)=>r.symbol==='BADTICKER')?.reason,'not_uniquely_mapped_NSE_EQ_equity');
  const result=new ControlStore(x.controlDir);
  try{
   const row=result.get(requestId)!;
   assert.equal(row.status,'completed');
   assert.deepEqual(row.result.symbols.sort((a:any,b:any)=>a.symbol.localeCompare(b.symbol)),[
    {symbol:'BADTICKER',status:'rejected',reason:'not_uniquely_mapped_NSE_EQ_equity'},
    {symbol:'RELIANCE',status:'accepted',reason:null},
   ]);
  }finally{result.close();}
 }finally{x.close();}
});

test('a newer custom-watchlist submission supersedes an older still-pending one instead of merging both',async()=>{
 const x=setup();
 try{
  const queue=new ControlStore(x.controlDir),olderId=randomUUID(),newerId=randomUUID();
  queue.enqueue(olderId,'custom-watchlist-update',{requestId:olderId,symbols:['BADTICKER']},Date.now()-5000);
  queue.enqueue(newerId,'custom-watchlist-update',{requestId:newerId,symbols:['RELIANCE']},Date.now());
  queue.close();
  await prepare(date,x.dir,x.controlDir,neverCalledProvider(),x.env,alwaysFailFetch);
  const w=JSON.parse(readFileSync(join(x.dir,`${date}.watchlists.json`),'utf8'));
  assert.ok(w.accepted.some((a:any)=>a.symbol==='RELIANCE'));
  assert.equal(w.candidates.some((c:any)=>c.symbol==='BADTICKER'),false,'the superseded request must not contribute a candidate');
  const result=new ControlStore(x.controlDir);
  try{
   assert.equal(result.get(olderId)!.status,'completed');
   assert.deepEqual(result.get(olderId)!.result,{status:'superseded_by_newer_request'});
   assert.equal(result.get(newerId)!.result.symbols[0].status,'accepted');
  }finally{result.close();}
 }finally{x.close();}
});
