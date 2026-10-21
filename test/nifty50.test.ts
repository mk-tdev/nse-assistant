import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseUniverse,loadUniverse} from '../src/universe.js';
import {resolveWatchlist,CandleStore,SessionRecorder} from '../src/recorder.js';
import {PaperLedger,paperDefaults} from '../src/paper.js';
import {PaperSessionWorker,paperCalendar} from '../src/paper-worker.js';
import {fixtureCandles,MOCK_DATE as date} from '../src/mock.js';
import {at,day,type Instrument} from '../src/model.js';
import type {Provider} from '../src/dhan.js';
const raw=JSON.parse(readFileSync('deploy/lightsail/nifty50-2026-10-21.json','utf8'));
const universe=parseUniverse(raw,'2026-10-22');
const items:Instrument[]=universe.constituents.map((c,n)=>({symbol:c.symbol,securityId:String(10000+n),name:c.name,exchangeSegment:'NSE_EQ',instrument:'EQUITY'}));
test('official universe is exactly fifty, current and uniquely mapped; invalid universe never falls back',async()=>{
 assert.equal(universe.constituents.length,50);assert.ok(universe.constituents.some(c=>c.symbol==='BSE'));assert.ok(!universe.constituents.some(c=>c.symbol==='WIPRO'));
 assert.equal(resolveWatchlist(items,universe.constituents.map(c=>c.symbol)).length,50);
 assert.throws(()=>parseUniverse({...raw,constituents:raw.constituents.slice(1)},'2026-10-22'));
 assert.throws(()=>parseUniverse({...raw,constituents:raw.constituents.map(()=>raw.constituents[0])},'2026-10-22'));
 assert.throws(()=>parseUniverse(raw,'2026-11-01'));assert.throws(()=>parseUniverse(raw,'2026-10-20'));
 assert.throws(()=>resolveWatchlist(items.slice(1),universe.constituents.map(c=>c.symbol)));
 assert.throws(()=>resolveWatchlist(items.map(i=>({...i,securityId:'1'})),universe.constituents.map(c=>c.symbol)));
 await assert.rejects(()=>loadUniverse('2026-10-22',{RECORDER_UNIVERSE:'invalid'}));
 await assert.rejects(()=>loadUniverse('2026-10-22',{RECORDER_UNIVERSE:'nifty50',RECORDER_UNIVERSE_PATH:'/missing.json'}));
});
test('all fifty equities get durable independent signals, fills and restart-safe scanner rows; one fetch failure stays isolated',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nifty50-')),calendar=paperCalendar(JSON.parse(readFileSync('deploy/lightsail/calendar-paper-2026.json','utf8')));
 const config={...paperDefaults(calendar),mode:'approximate-research' as const,acceptScheduledCalendarForResearch:true,acceptStartLabelsForResearch:true};
 const fixture=fixtureCandles();let now=at(date,'09:35')+10_000,failed='';
 const calls:string[]=[];
 const provider:Provider={source:'synthetic fifty-stock test',async instruments(){return {items,fetchedAt:now};},async quote(){throw Error('no quote or orders');},async candles(id,from,to){calls.push(id);if(id===failed)throw Error('DHAN_HTTP_429');return {source:this.source,candles:fixture.filter(c=>c.start>Date.parse(from)&&c.start<Date.parse(to)),fetchedAt:now,candleStartVerified:false,missing:[]};}};
 let store=new CandleStore(join(dir,'candles.sqlite')),ledger=new PaperLedger(join(dir,'paper.sqlite'),config);
 const make=()=>new PaperSessionWorker(new SessionRecorder(store,provider,items,date,'mock',10,{...universe,snapshotDate:date}),ledger,()=>now,0);
 try{
  for(const session of calendar.sessions.filter(d=>d<date).slice(-20))for(const i of items)store.save(session,i,fixture.filter(c=>day(c.start)===session&&c.start>=at(session,'09:30')&&c.start<at(session,'11:00')),at(date,'09:00'),{source:provider.source,candleStartVerified:false,missing:[]});
  let worker=make(),r=await worker.poll();assert.equal(r.paper.scanner.rows.length,50);assert.equal(r.paper.scanner.evaluatedStocks,50);assert.equal(r.paper.scanner.counts['pending-entry'],50);assert.equal(calls.length,50);
  store.close();ledger.close();store=new CandleStore(join(dir,'candles.sqlite'));ledger=new PaperLedger(join(dir,'paper.sqlite'),config);worker=make();
  now=at(date,'09:40')+10_000;r=await worker.poll();assert.equal(r.paper.scanner.counts.open,50);assert.equal(r.paper.events.filter(e=>e.kind==='open').length,50);
  r=await worker.poll();assert.equal(r.paper.events.filter(e=>e.kind==='open').length,50);
  now=at(date,'09:45')+10_000;failed=items[0]!.securityId;r=await worker.poll();assert.equal(r.instruments.filter(i=>i.error==='DHAN_HTTP_429').length,1);assert.equal(r.paper.scanner.rows.filter(i=>i.fetchError==='DHAN_HTTP_429').length,1);assert.equal(r.paper.scanner.rows.length,50);assert.deepEqual(r.paper.errors,[]);assert.equal(r.paper.simulatedOnly,true);
 }finally{store.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('slow bulk ingestion cannot bypass the sixty-second signal freshness gate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nifty50-clock-')),calendar=paperCalendar(JSON.parse(readFileSync('deploy/lightsail/calendar-paper-2026.json','utf8')));
 const config={...paperDefaults(calendar),mode:'approximate-research' as const,acceptScheduledCalendarForResearch:true,acceptStartLabelsForResearch:true};
 const fixture=fixtureCandles();let now=at(date,'09:35')+10_000;
 const provider:Provider={source:'synthetic delayed ingestion',async instruments(){return {items:[items[0]!],fetchedAt:now};},async quote(){throw Error('no orders');},async candles(id,from,to){return {source:this.source,candles:fixture.filter(c=>c.start>Date.parse(from)&&c.start<Date.parse(to)),fetchedAt:now,candleStartVerified:false,missing:[]};}};
 const store=new CandleStore(join(dir,'candles.sqlite')),ledger=new PaperLedger(join(dir,'paper.sqlite'),config);
 try{
  for(const session of calendar.sessions.filter(d=>d<date).slice(-20))store.save(session,items[0]!,fixture.filter(c=>day(c.start)===session),at(date,'09:00'),{source:provider.source,candleStartVerified:false,missing:[]});
  const worker=new PaperSessionWorker(new SessionRecorder(store,provider,[items[0]!],date,'mock'),ledger,()=>now,0);
  const ingest=worker.ingest.bind(worker);worker.ingest=t=>{ingest(t);now+=120_000;};
  const r=await worker.poll();assert.equal(r.paper.states[0]!.signal,null);assert.equal(r.paper.states[0]!.entry,null);assert.equal(r.paper.states[0]!.status,'blocked');assert.ok(r.paper.states[0]!.reasons.includes('signal_observed_too_late'));assert.equal(r.paper.observedAt,new Date(now).toISOString());
 }finally{store.close();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
