import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CandleStore,SessionRecorder,resolveWatchlist} from '../src/recorder.js';
import {recorderMock} from '../src/recorder-mock.js';
import {at,FIVE} from '../src/model.js';
import type {Provider} from '../src/dhan.js';
const date='2026-10-21';
const base=()=>recorderMock(date);
test('recorder persists across restart, deduplicates, excludes incomplete bars, and audits revisions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nse-recorder-')),path=join(dir,'candles.sqlite');
 let store=new CandleStore(path);
 try{
  const provider=base(),items=resolveWatchlist((await provider.instruments()).items);
  let recorder=new SessionRecorder(store,provider,items,date,'mock',0);
  const first=await recorder.poll(at(date,'09:27'));
  assert.equal(first.instruments[0]!.storedCandles,2);assert.equal(first.instruments[0]!.excludedIncomplete,73);assert.equal(first.instruments[0]!.expectedCandles,2);
  store.close();store=new CandleStore(path);recorder=new SessionRecorder(store,provider,items,date,'mock',0);
  const repeated=await recorder.poll(at(date,'09:27'));assert.equal(repeated.instruments[0]!.newCandles,0);assert.equal(store.candles(date,'1333').length,2);
  const revised:Provider={...provider,async candles(...args){const b=await provider.candles(...args);b.candles[0]!.close=100.5;return b;}};
  const update=await new SessionRecorder(store,revised,items,date,'mock',0).poll(at(date,'09:27'));
  assert.equal(update.instruments[0]!.revisedCandles,1);assert.equal(store.candles(date,'1333')[0]!.close,100.5);
  assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM revisions').get()!.n),2);
  assert.equal(store.latestReport(date)!.instruments[0]!.revisedCandles,1);
  assert.throws(()=>new SessionRecorder(store,provider,items,date,'live'),/STORE_MODE_MISMATCH/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('quality names the missing opening and final slots, null volume, and failed fetch without losing observations',async()=>{
 const store=new CandleStore(':memory:');try{
  const provider=base(),items=resolveWatchlist((await provider.instruments()).items);
  const gapped:Provider={...provider,async candles(...args){const b=await provider.candles(...args);b.candles=b.candles.slice(1,72);b.candles[1]!.volume=null;return b;}};
  const result=await new SessionRecorder(store,gapped,items,date,'mock',0).poll(at(date,'15:35'));
  const q=result.instruments[0]!;assert.equal(q.status,'missing_data');assert.equal(q.expectedCandles,75);assert.equal(q.missingSlots.length,4);assert.equal(q.missingSlots[0],new Date(at(date,'09:15')).toISOString());assert.equal(q.missingVolumeSlots.length,1);assert.equal(q.lagSeconds,900);
  const failed:Provider={...provider,async candles(){throw new Error('opaque-secret-do-not-echo');}};
  const failure=await new SessionRecorder(store,failed,items,date,'mock',0).poll(at(date,'15:36'));
  assert.equal(failure.instruments[0]!.status,'fetch_error');assert.equal(failure.instruments[0]!.storedCandles,71);assert.equal(failure.instruments[0]!.error,'RECORDER_FETCH_OR_SCHEMA_ERROR');assert.ok(!JSON.stringify(failure).includes('opaque-secret'));
 }finally{store.close();}
});
test('before open does not fetch; settlement grace does not demand an undelivered just-completed slot',async()=>{
 const store=new CandleStore(':memory:');try{
  const provider=base(),items=resolveWatchlist((await provider.instruments()).items);let calls=0;
  const p:Provider={...provider,async candles(...args){calls++;return provider.candles(...args);}};
  const recorder=new SessionRecorder(store,p,items,date,'mock',10);
  assert.equal((await recorder.poll(at(date,'09:10'))).instruments[0]!.status,'waiting');assert.equal(calls,0);
  assert.equal((await recorder.poll(at(date,'09:20')+5000)).instruments[0]!.expectedCandles,0);assert.equal(calls,0);
  const report=await recorder.poll(at(date,'09:20')+11000);assert.equal(report.instruments[0]!.expectedCandles,1);assert.equal(calls,2);assert.equal(report.strategyEnabled,false);assert.equal(report.calendarVerified,false);
 }finally{store.close();}
});
test('duplicate/invalid batches are rejected and mapping requires unique NSE cash equities',async()=>{
 const provider=base(),items=resolveWatchlist((await provider.instruments()).items);
 assert.throws(()=>resolveWatchlist([items[0]!]),/MAPPING_FAILED/);
 assert.throws(()=>resolveWatchlist([...items,{...items[0]!,securityId:'123'}]),/MAPPING_FAILED/);
 const duplicate:Provider={...provider,async candles(...args){const b=await provider.candles(...args);b.candles.splice(1,0,b.candles[0]!);return b;}};
 const store=new CandleStore(':memory:');try{
  const report=await new SessionRecorder(store,duplicate,items,date,'mock').poll(at(date,'10:00'));
  assert.equal(report.instruments[0]!.status,'fetch_error');assert.equal(report.instruments[0]!.storedCandles,0);assert.equal(report.instruments[0]!.error,'RECORDER_INVALID_OR_DUPLICATE_CANDLES');
 }finally{store.close();}
});
