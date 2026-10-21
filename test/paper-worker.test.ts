import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {at,day,FIVE,type Candle} from '../src/model.js';
import {fixtureCandles,mockCalendar,MOCK_DATE as date} from '../src/mock.js';
import {CandleStore,SessionRecorder} from '../src/recorder.js';
import {recorderMock} from '../src/recorder-mock.js';
import {PaperLedger,paperDefaults,type PaperConfig} from '../src/paper.js';
import {PaperSessionWorker,paperCalendar,loadPaperConfig} from '../src/paper-worker.js';
import type {Provider} from '../src/dhan.js';
const items=(await recorderMock(date).instruments()).items;
const calendar=paperCalendar(JSON.parse(readFileSync('deploy/lightsail/calendar-paper-2026.json','utf8')));
function config():PaperConfig{return {...paperDefaults(calendar),mode:'approximate-research',acceptScheduledCalendarForResearch:true,acceptStartLabelsForResearch:true};}
const baseFixture=fixtureCandles();
const fixture=[...baseFixture,...baseFixture.filter(c=>day(c.start)===date).map(c=>({...c,start:c.start+86400000}))];
function harness(cfg=config(),evaluationDate=date) {
  const dir=mkdtempSync(join(tmpdir(),'nse-worker-'));let now=at(evaluationDate,'09:05'),tailMissing=false,revision=false,failHistory=false;
  const calls:{id:string;session:string}[]=[];
  const provider:Provider={source:'synthetic integration (not market data)',async instruments(){return{items,fetchedAt:now};},async quote(){throw new Error('not used');},async candles(id,from,to){
    const session=day(Date.parse(from));calls.push({id,session});if(failHistory&&session<date)throw new Error('DHAN_HTTP_429');
    const candles=fixture.filter(c=>c.start>Date.parse(from)&&c.start<Date.parse(to)).map(c=>({...c}));
    return {source:this.source,candles:candles.filter(c=>!(tailMissing&&day(c.start)===date&&c.start>=at(date,'15:15'))).map(c=>revision&&c.start===at(date,'09:40')?{...c,high:112}:c),fetchedAt:now,candleStartVerified:false,missing:[]};
  }};
  let store=new CandleStore(join(dir,'candles.sqlite')),ledger=new PaperLedger(join(dir,'paper.sqlite'),cfg);
  const make=()=>new PaperSessionWorker(new SessionRecorder(store,provider,items,evaluationDate,'mock',10),ledger,()=>now);
  let worker=make();
  return {dir,calls,provider,get store(){return store;},get ledger(){return ledger;},get worker(){return worker;},
    setTime(t:string,ms=10_000){now=at(evaluationDate,t)+ms;},get now(){return now;},setTail(){tailMissing=true;},setRevision(){revision=true;},setFailure(){failHistory=true;},
    seed(){for(const session of calendar.sessions.filter(d=>d<date).slice(-20))for(const i of items)store.save(session,i,fixture.filter(c=>day(c.start)===session),at(date,'09:00'),{source:provider.source,candleStartVerified:false,missing:[]});},
    restart(next=cfg){store.close();ledger.close();store=new CandleStore(join(dir,'candles.sqlite'));ledger=new PaperLedger(join(dir,'paper.sqlite'),next);worker=make();},
    close(){store.close();ledger.close();rmSync(dir,{recursive:true,force:true});}};
}
test('bounded shared backfill obtains exactly prior 20 sessions for both symbols before signals',async()=>{
 const h=harness();try{
  for(let n=0;n<20;n++){const report=await h.worker.poll();assert.ok(report.paper.backfill.requestsThisPoll<=2);}
  const r=await h.worker.backfill(h.now);assert.equal(r.status,'complete');assert.equal(r.previousSessions.length,20);assert.equal(h.calls.length,40);
  assert.ok(h.calls.every(c=>c.session<date));assert.equal(r.previousSessions.at(-1),'2026-10-19');
  h.restart();assert.equal((await h.worker.backfill(h.now)).requestsThisPoll,0);assert.equal(h.calls.length,40);
 }finally{h.close();}
});
test('backfill failures have durable bounded retry budgets and specific missing slots',async()=>{
 const h=harness();try{h.setFailure();for(let n=0;n<3;n++)await h.worker.backfill(h.now);h.restart();for(let n=0;n<40;n++)await h.worker.backfill(h.now);
 const r=await h.worker.backfill(h.now);assert.ok(h.calls.length<=80);assert.equal(r.requestsThisPoll,0);assert.equal(r.missing.length,40);assert.equal(r.missing[0]!.error,'DHAN_HTTP_429');assert.equal(r.missing[0]!.slots.length,18);
 }finally{h.close();}
});
test('strict/default calendar keeps evidence gates and does not fabricate weekday history',async()=>{
 const cfg=paperDefaults(calendar),h=harness(cfg);try{h.setTime('09:35');const r=await h.worker.poll();assert.equal(r.paper.backfill.status,'calendar_evidence_unverified');assert.equal(r.paper.backfill.requestsThisPoll,0);assert.ok(r.paper.states.every(s=>s.entry===null&&s.status==='blocked'));assert.ok(r.paper.states[0]!.reasons.includes('timestamp_aligned_exact_session_vwap_unavailable'));
 }finally{h.close();}
});
test('end-to-end full synthetic session survives restart and repeated polls with one fill per symbol',async()=>{
 const h=harness();try{h.seed();h.setTime('09:30');await h.worker.poll();h.setTime('09:35');let r=await h.worker.poll();assert.ok(r.paper.states.every(s=>s.status==='pending-entry'));
 h.restart();h.setTime('09:40');r=await h.worker.poll();assert.ok(r.paper.states.every(s=>s.status==='open'&&s.entry===103));
 const events=r.paper.events.length;r=await h.worker.poll();assert.equal(r.paper.events.length,events);
 for(let t=at(date,'09:45');t<=at(date,'15:20');t+=FIVE){const hhmm=new Date(t+330*60000).toISOString().slice(11,16);h.setTime(hhmm);r=await h.worker.poll();}
 assert.ok(r.paper.states.every(s=>s.status==='closed'&&s.exitReason==='forced_15:15'&&s.grossPnl===0&&s.netPnl===null));
 assert.equal(r.paper.events.filter(e=>e.kind==='open').length,2);assert.equal(r.paper.events.filter(e=>e.kind==='closed').length,2);assert.equal(r.paper.exactQualification,false);
 }finally{h.close();}
});
test('missing final three slots retains unknown outcomes after full session and restart',async()=>{
 const h=harness();try{h.seed();h.setTail();for(let t=at(date,'09:30');t<=at(date,'15:30');t+=FIVE){h.setTime(new Date(t+330*60000).toISOString().slice(11,16));await h.worker.poll();}
 h.restart();h.setTime('15:35');const r=await h.worker.poll();assert.ok(r.instruments.every(i=>i.missingSlots.length===3&&i.storedCandles===72));assert.ok(r.paper.states.every(s=>s.status==='closed'&&s.unknownOutcome&&s.exit===null&&s.grossPnl===null&&s.netPnl===null));
 }finally{h.close();}
});
test('existing positions retain risk management when mode, calendar and entry config are blocked',async()=>{
 const h=harness();try{h.seed();h.setTime('09:35');await h.worker.poll();h.setTime('09:40');await h.worker.poll();
 const strict=paperDefaults({...calendar,sessions:[date],coverageFrom:date});h.restart(strict);h.setTime('09:45');h.setRevision();const r=await h.worker.poll();
 const positions=r.paper.states.filter(s=>s.entry!==null);assert.equal(positions.length,2);assert.ok(positions.every(s=>s.status==='closed'&&s.exit===111&&s.grossPnl===8));assert.ok(r.paper.events.some(e=>e.kind==='new_entries_blocked_risk_continues'));
 assert.ok(r.paper.states.filter(s=>s.mode==='strict').every(s=>s.entry===null));
 }finally{h.close();}
});
test('recorder revisions are reconstructed across ledger downtime without improved fills',async()=>{
 const h=harness();try{h.seed();h.setTime('09:35');await h.worker.poll();h.setTime('09:40');await h.worker.poll();h.setTime('09:45');await h.worker.poll();
 h.setTime('09:45',20_000);h.setRevision();await new SessionRecorder(h.store,h.provider,items,date,'mock').poll(h.now);
 h.restart();h.setTime('09:45',30_000);const r=await h.worker.poll();assert.ok(r.paper.states.every(s=>s.status==='open'&&s.exit===null));assert.ok(r.paper.revisions.length===2);
 }finally{h.close();}
});
test('research calendar parser refuses duplicate dates, unsupported actual-verification claims and uncovered sessions',()=>{
 const raw=JSON.parse(readFileSync('deploy/lightsail/calendar-paper-2026.json','utf8'));
 assert.equal(paperCalendar(raw).independentlyVerified,false);
 assert.throws(()=>paperCalendar({...raw,kind:'verified_regular_sessions'}));
 assert.throws(()=>paperCalendar({...raw,sessions:[date,date]}));
 assert.throws(()=>paperCalendar({...raw,validFrom:date}));
});
test('runtime configuration is strict by default and research requires explicit honest assumptions',async()=>{
 const env={PAPER_CALENDAR_PATH:'deploy/lightsail/calendar-paper-2026.json'};
 const cfg=await loadPaperConfig(env);assert.equal(cfg!.mode,'strict');assert.equal(cfg!.quantity,1);assert.equal(cfg!.timestampSemanticsVerified,false);assert.equal(cfg!.feesPerSide,null);
 const research=await loadPaperConfig({...env,PAPER_MODE:'approximate-research',PAPER_ACCEPT_START_LABELS:'true',PAPER_ACCEPT_SCHEDULED_CALENDAR:'true'});assert.equal(research!.timestampSemanticsVerified,false);assert.equal(research!.calendar.independentlyVerified,false);
 await assert.rejects(()=>loadPaperConfig({...env,PAPER_ACCEPT_START_LABELS:'yes'}));
});
test('legacy-store upgrade refreshes bounded historical baseline provenance without relabeling original observations',async()=>{
 const evaluationDate='2026-10-22',h=harness(config(),evaluationDate);
 try {
  // Reproduce pre-paper SQLite: complete morning data exists, but no batch provenance table at all.
  for(const session of ['2026-10-19','2026-10-21'])for(const instrument of items)h.store.save(session,instrument,
    fixture.filter(c=>day(c.start)===session).map(c=>c.start===at('2026-10-19','09:30')?{...c,volume:999}:c),at(session,'15:35'));
  h.store.db.exec('DROP TABLE candle_batches');h.restart();
  h.worker.ingest(h.now);
  const originals=h.ledger.db.prepare('SELECT symbol,start,fingerprint,observed_at,body FROM paper_observations ORDER BY rowid').all();
  assert.ok(originals.length>0);assert.ok(originals.every(o=>JSON.parse(String(o.body)).issues.includes('recorder_batch_provenance_unavailable')));
  const first=await h.worker.backfill(h.now);assert.equal(first.requestsThisPoll,2);assert.ok(h.calls.every(c=>c.session==='2026-10-21'));
  assert.ok(first.missing.some(m=>m.session==='2026-10-19'&&m.unprovenancedSlots.length===18));
  for(let n=0;n<19;n++)await h.worker.backfill(h.now);
  h.worker.ingest(h.now);assert.equal(h.calls.length,40);assert.equal((await h.worker.backfill(h.now)).status,'complete');
  const after=h.ledger.db.prepare('SELECT symbol,start,fingerprint,observed_at,body FROM paper_observations ORDER BY rowid LIMIT ?').all(originals.length);assert.deepEqual(after,originals);
  const baseline=h.ledger.baselines(evaluationDate,'TCS',h.now).find(o=>o.candle.start===at('2026-10-19','09:30'))!;
  assert.equal(baseline.candle.volume,100);assert.match(baseline.source,/historical baseline refresh/);assert.equal(baseline.observedAt,h.now);
  assert.equal(h.ledger.baselines(evaluationDate,'TCS',h.now-1).length,0);
  assert.equal(h.ledger.config.calendar.independentlyVerified,false);assert.equal(h.ledger.config.timestampSemanticsVerified,false);
  h.restart();h.setTime('09:35');const report=await h.worker.poll();assert.ok(report.paper.states.every(s=>s.status==='pending-entry'));
  assert.match(report.paper.baselinePolicy,/separate from original execution/);assert.ok(report.paper.baselineProvenance.length===2);
  assert.ok(report.paper.events.filter(e=>e.kind==='research_signal').every(e=>JSON.parse(String(e.body)).baselineObservations.length===20));
 }finally{h.close();}
});
