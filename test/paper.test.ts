import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperLedger, paperDefaults, type PaperConfig } from '../src/paper.js';
import { at, day, FIVE, type Candle } from '../src/model.js';
import { mockCalendar, fixtureCandles, MOCK_DATE as date } from '../src/mock.js';
const config=():PaperConfig=>({...paperDefaults({source:'synthetic sessions',coverageFrom:mockCalendar.sessions[0]!,coverageTo:date,sessions:mockCalendar.sessions,independentlyVerified:false}),mode:'approximate-research',acceptStartLabelsForResearch:true,acceptScheduledCalendarForResearch:true});
const open=()=>new PaperLedger(':memory:',config());
function seed(l:PaperLedger){for(const c of fixtureCandles().filter(c=>day(c.start)<date))l.observe('TCS',{candle:c,observedAt:at(date,'09:00'),sourceTime:at(date,'09:00'),source:'synthetic baseline',issues:[]});}
function bar(time:string,patch:Partial<Candle>={}) {return {...fixtureCandles().find(c=>c.start===at(date,time))!,...patch};}
function observe(l:PaperLedger,time:string,patch:Partial<Candle>={},delay=0){const candle=bar(time,patch),now=candle.start+FIVE+delay;l.observe('TCS',{candle,observedAt:now,sourceTime:now,source:'synthetic',issues:[]});return now;}
function signal(l:PaperLedger) {seed(l);observe(l,'09:15');observe(l,'09:20');observe(l,'09:25');let n=observe(l,'09:30');return l.tick('TCS',date,n);}
function entry(l:PaperLedger){signal(l);const n=observe(l,'09:35');return l.tick('TCS',date,n);}
test('explicit research progresses durably with gross known and unconfigured net unknown',()=>{const l=open();assert.equal(signal(l).status,'pending-entry');const n=observe(l,'09:35');assert.equal(l.tick('TCS',date,n).status,'open');const t=observe(l,'09:40',{high:112});const s=l.tick('TCS',date,t);assert.equal(s.status,'closed');assert.equal(s.exit,111);assert.equal(s.grossPnl,8);assert.equal(s.netPnl,null);l.close();});
test('strict remains blocked even with verified start semantics and calendar',()=>{const c=config();c.mode='strict';c.timestampSemanticsVerified=true;c.calendar.independentlyVerified=true;const l=new PaperLedger(':memory:',c);const s=signal(l);assert.equal(s.status,'blocked');assert.ok(s.reasons.includes('timestamp_aligned_exact_session_vwap_unavailable'));assert.equal(s.entry,null);l.close();});
test('research must explicitly accept both unverified assumptions',()=>{for(const key of ['acceptStartLabelsForResearch','acceptScheduledCalendarForResearch'] as const){const c=config();c[key]=false;const l=new PaperLedger(':memory:',c);assert.equal(signal(l).status,'blocked');l.close();}});
test('calendar coverage cannot be inferred from observed weekdays',()=>{const c=config();c.calendar.coverageFrom=date;c.calendar.sessions=[date];const l=new PaperLedger(':memory:',c);assert.ok(signal(l).reasons.includes('missing_verified_coverage_for_previous_20_sessions'));l.close();});
test('missing most recent prior-session volume does not substitute an older session',()=>{const l=open();seed(l);const prior=mockCalendar.sessions.filter(d=>d<date).at(-1)!;l.db.prepare('DELETE FROM paper_observations WHERE start=?').run(at(prior,'09:30'));for(const t of ['09:15','09:20','09:25','09:30'])observe(l,t);const s=l.tick('TCS',date,at(date,'09:35'));assert.equal(s.status,'blocked');assert.ok(s.reasons.some(r=>r.startsWith('missing_prior_20')));l.close();});
test('incomplete/future candle is ignored; out of order arrival cannot improve processed prices',()=>{const l=open();signal(l);const c=bar('09:35',{open:999,high:1000,low:900,close:999});l.observe('TCS',{candle:c,observedAt:c.start,sourceTime:c.start,source:'future',issues:[]});assert.equal(l.tick('TCS',date,c.start).status,'pending-entry');const n=observe(l,'09:35');assert.equal(l.tick('TCS',date,n).entry,103);l.close();});
test('revision is audited but does not replace original signal or fill',()=>{const l=open();entry(l);observe(l,'09:35',{open:100,low:100},30_000);const s=l.tick('TCS',date,at(date,'09:40')+30_000);assert.equal(s.entry,103);assert.equal(l.revisions('TCS').length,1);l.close();});
test('restart and duplicate ticks never duplicate decisions or fills',()=>{const dir=mkdtempSync(join(tmpdir(),'paper-')),path=join(dir,'paper.sqlite');let l=new PaperLedger(path,config());const s=entry(l),n=l.events(s.id).length;l.close();l=new PaperLedger(path,config());observe(l,'09:35');assert.equal(l.tick('TCS',date,at(date,'09:40')).entry,103);assert.equal(l.events(s.id).length,n);l.close();rmSync(dir,{recursive:true});});
test('same-bar stop/target ambiguity is stop first, gap stop uses worse open',()=>{for(const [patch,price,reason] of [[{low:98,high:112},99,'stop_first_ambiguous'],[{open:97,low:96,high:112},97,'gap_stop']] as const){const l=open();entry(l);const n=observe(l,'09:40',patch);const s=l.tick('TCS',date,n);assert.equal(s.exit,price);assert.equal(s.exitReason,reason);l.close();}});
test('stale signal cannot be filled retroactively',()=>{const l=open();seed(l);for(const t of ['09:15','09:20','09:25'])observe(l,t);const now=observe(l,'09:30',{},120_000);const s=l.tick('TCS',date,now);assert.equal(s.signal,null);assert.equal(s.status,'blocked');l.close();});
test('missing exit path remains unknown after late history arrives',()=>{const l=open();entry(l);const s=l.tick('TCS',date,at(date,'09:46')+1);assert.equal(s.unknownOutcome,true);observe(l,'09:40',{high:112},120_000);const later=l.tick('TCS',date,at(date,'15:20'));assert.equal(later.status,'closed');assert.equal(later.exit,null);assert.equal(later.grossPnl,null);assert.equal(later.netPnl,null);l.close();});
test('forced exit requires the actual 15:15 bar and keeps missing price unknown',()=>{for(const missing of [false,true]){const l=open();entry(l);for(let t=at(date,'09:40');t<at(date,'15:15');t+=FIVE){const c: Candle={start:t,open:103,high:104,low:102,close:103,volume:100};l.observe('TCS',{candle:c,observedAt:t+FIVE,sourceTime:t+FIVE,source:'synthetic',issues:[]});l.tick('TCS',date,t+FIVE);}if(!missing)observe(l,'15:15',{open:104,low:103,high:105,close:104});const s=l.tick('TCS',date,at(date,missing?'15:21':'15:20')+(missing?1:0));assert.equal(s.status,'closed');assert.equal(s.exit,missing?null:104);assert.equal(s.grossPnl,missing?null:1);l.close();}});
test('configured fees and slippage produce a disclosed modeled net',()=>{const c=config();c.feesPerSide=1;c.slippageBps=10;const l=new PaperLedger(':memory:',c);entry(l);const n=observe(l,'09:40',{high:112});const s=l.tick('TCS',date,n);assert.equal(s.netPnl,8-2-(103+111)*10/10000);l.close();});
test('an earlier timestamp on a later correction cannot rewrite first arrival',()=>{const l=open();entry(l);observe(l,'09:40',{high:104},30_000);const c=bar('09:40',{high:112});l.observe('TCS',{candle:c,observedAt:c.start+FIVE,sourceTime:c.start+FIVE,source:'revision',issues:[]});const s=l.tick('TCS',date,at(date,'09:45')+30_000);assert.equal(s.status,'open');assert.equal(s.exit,null);l.close();});
test('out of order bars are consumed in source slot order',()=>{const l=open();seed(l);for(const t of ['09:25','09:15','09:20','09:30'])observe(l,t);assert.equal(l.tick('TCS',date,at(date,'09:35')).status,'pending-entry');l.close();});
test('invalid and explicitly partial candles block signal',()=>{for(const issues of [[],['partial']]){const l=open();seed(l);for(const t of ['09:15','09:20','09:25'])observe(l,t);const c=bar('09:30',issues.length?{}:{high:1});l.observe('TCS',{candle:c,observedAt:c.start+FIVE,sourceTime:c.start+FIVE,source:'synthetic',issues});const s=l.tick('TCS',date,c.start+FIVE);assert.equal(s.status,'blocked');assert.equal(s.signal,null);l.close();}});
test('missing or stale next candle cancels without inventing entry or PnL',()=>{for(const missing of [true,false]){const l=open();signal(l);if(!missing)observe(l,'09:35',{},120_000);const s=l.tick('TCS',date,at(date,'09:42'));assert.equal(s.status,'closed');assert.equal(s.entry,null);assert.equal(s.grossPnl,null);l.close();}});
test('pending entry gap through stop records rejection',()=>{const l=open();signal(l);const n=observe(l,'09:35',{open:98,low:97});const s=l.tick('TCS',date,n);assert.equal(s.exitReason,'entry_gap_at_or_below_stop');assert.equal(s.entry,null);assert.ok(l.events(s.id).some(e=>e.kind==='entry_rejected'));l.close();});
test('gap above target never improves fill past target',()=>{const l=open();entry(l);const n=observe(l,'09:40',{open:113,high:114,low:112,close:113});const s=l.tick('TCS',date,n);assert.equal(s.exit,111);assert.equal(s.exitReason,'gap_target_capped');l.close();});
test('a missing opening bar blocks qualification',()=>{const l=open();seed(l);l.db.prepare('DELETE FROM paper_observations WHERE start=?').run(at(date,'09:20'));observe(l,'09:15');observe(l,'09:25');observe(l,'09:30');assert.equal(l.tick('TCS',date,at(date,'09:35')).status,'blocked');l.close();});
test('completed-price delivery grace does not prematurely make an open position unknown',()=>{
 const l=open();entry(l);let s=l.tick('TCS',date,at(date,'09:45'));assert.equal(s.status,'open');assert.equal(s.unknownOutcome,false);assert.ok(s.reasons[0]!.startsWith('awaiting_completed_candle'));
 const n=observe(l,'09:40',{high:112},30_000);s=l.tick('TCS',date,n);assert.equal(s.status,'closed');assert.equal(s.exit,111);assert.equal(s.unknownOutcome,false);l.close();
});
test('volume-only block cannot disable price stop management on an existing position',()=>{
 const l=open();entry(l);l.config.calendar.independentlyVerified=false;l.config.acceptScheduledCalendarForResearch=false;
 const n=observe(l,'09:40',{low:98,volume:null});const s=l.tick('TCS',date,n);assert.equal(s.status,'closed');assert.equal(s.exit,99);assert.equal(s.grossPnl,-4);l.close();
});

test('15:10 planned exit is shared by variants and confirmed only at 15:15, without missing tail bars',()=>{
 for(const variant of [undefined,'range-hold','range-failure-exit','agent-recovery'] as const){
  const c={...config(),exitTime:'15:10' as const,...(variant?{variant}:{})};const l=new PaperLedger(':memory:',c);seed(l);
  let current:ReturnType<PaperLedger['tick']>|undefined;
  for(let t=at(date,'09:15');t<at(date,'15:10');t+=FIVE){
   const candle=t<at(date,'09:40')?bar(new Date(t+330*60000).toISOString().slice(11,16)):{start:t,open:104,high:105,low:103,close:104,volume:100};
   l.observe('TCS',{candle,observedAt:t+FIVE,sourceTime:t+FIVE,source:'synthetic',issues:[]});current=l.tick('TCS',date,t+FIVE);
  }
  assert.equal(current!.status,'open');assert.equal(l.tick('TCS',date,at(date,'15:14')).exit,null);
  const candle={start:at(date,'15:10'),open:104,high:120,low:90,close:104,volume:100};
  l.observe('TCS',{candle,observedAt:at(date,'15:14'),sourceTime:at(date,'15:14'),source:'incomplete',issues:[]});assert.equal(l.tick('TCS',date,at(date,'15:14')).exit,null);
  l.observe('TCS',{candle,observedAt:at(date,'15:15')+10000,sourceTime:at(date,'15:15'),source:'completed',issues:[]});
  const done=l.tick('TCS',date,at(date,'15:15')+10000);assert.equal(done.status,'closed');assert.equal(done.exit,104);assert.equal(done.exitAt,at(date,'15:10'));assert.equal(done.exitReason,'forced_15:10');assert.equal(done.unknownOutcome,false);assert.equal(done.grossPnl,104-done.entry!);
  const count=l.events(done.id).length;assert.equal(l.tick('TCS',date,at(date,'15:35')).exit,104);assert.equal(l.events(done.id).length,count);assert.equal(l.snapshot(date).assumptions.plannedExitTimeIST,'15:10');l.close();
 }
});
test('missing or earlier missing exit path cannot be repaired by choosing an earlier planned exit',()=>{
 for(const missingAt of ['09:40','15:10']){const l=new PaperLedger(':memory:',{...config(),exitTime:'15:10'});entry(l);
  for(let t=at(date,'09:40');t<=at(date,'15:10');t+=FIVE){if(t!==at(date,missingAt)){const candle={start:t,open:103,high:104,low:102,close:103,volume:100};l.observe('TCS',{candle,observedAt:t+FIVE,sourceTime:t+FIVE,source:'synthetic',issues:[]});}l.tick('TCS',date,t+FIVE+10000);}
  const done=l.tick('TCS',date,at(date,'15:16')+1);assert.equal(done.status,'closed');assert.equal(done.exit,null);assert.equal(done.grossPnl,null);assert.equal(done.unknownOutcome,true);l.close();
 }
});
test('planned exit rejects unsupported time and leaves legacy hashes unchanged when omitted',()=>{
 assert.throws(()=>new PaperLedger(':memory:',{...config(),exitTime:'15:25' as never}),/INVALID_PAPER_CONFIG/);
 const l=open();assert.equal(l.snapshot(date).assumptions.plannedExitTimeIST,'15:15');assert.equal('exitTime' in l.config,false);l.close();
});
