import {scanUniverse} from './scanner.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { at, day, FIVE, minute, validCandle, validDate, type Candle } from './model.js';
import { PaperLedger, paperDefaults, type PaperCalendar, type PaperConfig } from './paper.js';
import { SessionRecorder, safeRecorderError, type SessionReport } from './recorder.js';

const calendarSchema=z.object({source:z.string().min(1),kind:z.enum(['scheduled_regular_sessions','verified_regular_sessions']),
  validFrom:z.string().refine(validDate),validThrough:z.string().refine(validDate),sessions:z.array(z.string().refine(validDate)),
  verificationEvidence:z.string().min(1).optional()});
export function paperCalendar(raw:unknown):PaperCalendar {
  const c=calendarSchema.parse(raw);
  if(c.validFrom>c.validThrough || new Set(c.sessions).size!==c.sessions.length || c.sessions.some(d=>d<c.validFrom||d>c.validThrough) ||
    (c.kind==='verified_regular_sessions'&&!c.verificationEvidence))throw new Error('PAPER_INVALID_CALENDAR');
  return {source:c.source+(c.verificationEvidence?`; evidence: ${c.verificationEvidence}`:''),coverageFrom:c.validFrom,coverageTo:c.validThrough,sessions:c.sessions,
    independentlyVerified:c.kind==='verified_regular_sessions'};
}
function bool(value:string|undefined, fallback=false) {
  if(value===undefined)return fallback;
  if(value!=='true'&&value!=='false')throw new Error('PAPER_INVALID_BOOLEAN');return value==='true';
}
export async function loadPaperConfig(env:NodeJS.ProcessEnv=process.env):Promise<PaperConfig|null> {
  if(!bool(env.PAPER_ENABLED,true))return null;
  const calendar=paperCalendar(JSON.parse(await readFile(env.PAPER_CALENDAR_PATH??new URL('../deploy/lightsail/calendar-paper-2026.json',import.meta.url),'utf8')));
  const mode=env.PAPER_MODE??'strict';if(mode!=='strict'&&mode!=='approximate-research')throw new Error('PAPER_INVALID_MODE');
  const exitTime=env.PAPER_EXIT_TIME_IST===undefined?undefined:z.enum(['15:10','15:15']).parse(env.PAPER_EXIT_TIME_IST);
  const nullable=(v:string|undefined)=>v===undefined||v===''?null:Number(v);
  return {...paperDefaults(calendar),...(exitTime?{exitTime}:{}),mode,quantity:Number(env.PAPER_QUANTITY??1),feesPerSide:nullable(env.PAPER_FEES_PER_SIDE),
    slippageBps:nullable(env.PAPER_SLIPPAGE_BPS),maxObservationDelayMs:Number(env.PAPER_MAX_OBSERVATION_DELAY_SECONDS??60)*1000,
    acceptScheduledCalendarForResearch:bool(env.PAPER_ACCEPT_SCHEDULED_CALENDAR),acceptStartLabelsForResearch:bool(env.PAPER_ACCEPT_START_LABELS),
    timestampSemanticsVerified:bool(env.DHAN_CANDLE_START_VERIFIED)};
}
export type BackfillReport={status:string;calendarSource:string;previousSessions:string[];requestsThisPoll:number;maxRequestsPerPoll:number;maxAttemptsPerSymbolSession:number;missing:{symbol:string;session:string;slots:string[];unprovenancedSlots:string[];attempts:number;error:string|null}[]};
export type PaperReport=ReturnType<PaperLedger['snapshot']>&{backfill:BackfillReport;errors:string[];scanner:ReturnType<typeof scanUniverse>};
export type CombinedReport=SessionReport&{paper:PaperReport};

/** Runs inside the recorder's singleton process, using its provider, store and REST limiter. */
export class PaperSessionWorker {
  private historyIngestedThrough=0;
  constructor(readonly recorder:SessionRecorder,readonly ledger:PaperLedger,readonly clock=Date.now,readonly maxBackfillPerPoll=2) {
    if(!Number.isInteger(maxBackfillPerPoll)||maxBackfillPerPoll<0||maxBackfillPerPoll>4)throw new Error('PAPER_INVALID_BACKFILL_BOUND');
    recorder.store.db.exec(`CREATE TABLE IF NOT EXISTS paper_backfill (
      evaluation_session TEXT NOT NULL,symbol TEXT NOT NULL,history_session TEXT NOT NULL,attempts INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,error TEXT,PRIMARY KEY(evaluation_session,symbol,history_session));`);
  }
  private missingSlots(session:string,id:string) {
    const cs=this.recorder.store.candles(session,id);
    const missing:string[]=[],unprovenanced:string[]=[];
    // Only confirmation slots are needed for the morning volume baseline. Missing tails remain in session quality.
    for(let t=at(session,'09:30');t<at(session,'11:00');t+=FIVE){
      const c=cs.find(c=>c.start===t);if(!c||!validCandle(c)||c.volume===null)missing.push(new Date(t).toISOString());
      else {
        const provenance=this.recorder.store.db.prepare(`SELECT b.body FROM candles c JOIN candle_batches b ON
          b.session=c.session AND b.security_id=c.security_id AND b.observed_at=c.last_observed_at
          WHERE c.session=? AND c.security_id=? AND c.source_epoch_ms=?`).get(session,id,t);
        if(!provenance)unprovenanced.push(new Date(t).toISOString());
      }
    }return {slots:[...new Set([...missing,...unprovenanced])],unprovenancedSlots:unprovenanced};
  }
  async backfill(now:number):Promise<BackfillReport> {
    const cfg=this.ledger.config,c=cfg.calendar,date=this.recorder.date;
    const previous=[...new Set(c.sessions.filter(d=>d<date))].sort().slice(-20);
    const r:BackfillReport={status:'complete',calendarSource:c.source,previousSessions:previous,requestsThisPoll:0,maxRequestsPerPoll:this.maxBackfillPerPoll,
      maxAttemptsPerSymbolSession:2,missing:[]};
    const allowed=c.independentlyVerified||(cfg.mode==='approximate-research'&&cfg.acceptScheduledCalendarForResearch);
    if(previous.length!==20||!previous[0]||c.coverageFrom>previous[0]||date>c.coverageTo||!c.sessions.includes(date))r.status='calendar_previous_20_coverage_missing';
    else if(!allowed)r.status='calendar_evidence_unverified';
    for(const session of [...previous].reverse())for(const instrument of this.recorder.instruments){
      let readiness=this.missingSlots(session,instrument.securityId),slots=readiness.slots;
      const row=this.recorder.store.db.prepare('SELECT attempts,error FROM paper_backfill WHERE evaluation_session=? AND symbol=? AND history_session=?')
        .get(date,instrument.symbol,session) as {attempts:number;error:string|null}|undefined;
      let attempts=row?.attempts??0,error=row?.error??null;
      if(slots.length && r.status!=='calendar_previous_20_coverage_missing' && allowed && attempts<2 && r.requestsThisPoll<this.maxBackfillPerPoll && now>=at(date,'09:05') && now<at(date,'11:00')) {
        // Reserve before network I/O: restart/crash cannot reset the per-session request budget.
        attempts++;r.requestsThisPoll++;
        this.recorder.store.db.prepare(`INSERT INTO paper_backfill VALUES(?,?,?,?,?,NULL)
          ON CONFLICT(evaluation_session,symbol,history_session) DO UPDATE SET attempts=excluded.attempts,observed_at=excluded.observed_at,error=NULL`)
          .run(date,instrument.symbol,session,attempts,now);
        try {
          const batch=await this.recorder.provider.candles(instrument.securityId,new Date(at(session,'09:15')-1000).toISOString(),new Date(at(session,'15:30')).toISOString());
          if(batch.candles.some((b,i)=>!validCandle(b)||i>0&&b.start<=batch.candles[i-1]!.start))throw new Error('RECORDER_INVALID_OR_DUPLICATE_CANDLES');
          const cs=batch.candles.filter(b=>day(b.start)===session&&b.start>=at(session,'09:15')&&b.start<at(session,'15:30')&&b.start+FIVE<=now);
          this.recorder.store.save(session,instrument,cs,batch.fetchedAt,batch);
          readiness=this.missingSlots(session,instrument.securityId);slots=readiness.slots;error=slots.length?'PAPER_HISTORY_SLOTS_MISSING':null;
        }catch(e){error=safeRecorderError(e);}
        this.recorder.store.db.prepare('UPDATE paper_backfill SET error=? WHERE evaluation_session=? AND symbol=? AND history_session=?').run(error,date,instrument.symbol,session);
      }
      if(slots.length)r.missing.push({symbol:instrument.symbol,session,slots,unprovenancedSlots:readiness.unprovenancedSlots,attempts,error});
    }
    if(r.status==='complete'&&r.missing.length)r.status='missing_baseline_slots';return r;
  }
  ingest(now:number) {
    const db=this.recorder.store.db;
    const ids=this.recorder.instruments.map(i=>i.securityId);
    const rows=ids.length?db.prepare(`SELECT * FROM candles WHERE (session>=? OR last_observed_at>=?) AND security_id IN (${ids.map(()=>'?').join(',')}) ORDER BY first_observed_at,source_epoch_ms`).all(this.recorder.date,this.historyIngestedThrough,...ids):[];
    this.ledger.db.exec('BEGIN IMMEDIATE');
    try {
    for(const row of rows){
      const start=Number(row.source_epoch_ms),observed=Number(row.first_observed_at);
      if(start+FIVE>now||observed>now)continue;
      const revisions=db.prepare('SELECT * FROM revisions WHERE session=? AND security_id=? AND source_epoch_ms=? ORDER BY id').all(row.session!,row.security_id!,start);
      const current:Candle={start,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:row.volume===null?null:Number(row.volume)};
      // If restarted after recorder revisions, reconstruct original rather than relabel latest as the first observation.
      const original:Candle=revisions.length?JSON.parse(String(revisions[0]!.previous_json)):current;
      const admit=(candle:Candle,time:number)=>{
        if(time>now)return;
        const batch=db.prepare('SELECT body FROM candle_batches WHERE session=? AND security_id=? AND observed_at=?').get(row.session!,row.security_id!,time);
        const provenance=batch?JSON.parse(String(batch.body)):null;
        this.ledger.observe(String(row.symbol),{candle,observedAt:time,sourceTime:candle.start+FIVE,
          source:provenance?.source??'persisted recorder; batch provenance unavailable',issues:provenance?[...provenance.missing.filter((issue:string)=>issue!=='historical_volume_missing'),...(candle.volume===null?['historical_volume_missing']:[])]:['recorder_batch_provenance_unavailable']});
      };
      admit(original,observed);
      const latestObserved=Number(row.last_observed_at);
      if(String(row.session)<this.recorder.date && latestObserved<=now && minute(start)>=570&&minute(start)<660) {
        const batch=db.prepare('SELECT body FROM candle_batches WHERE session=? AND security_id=? AND observed_at=?').get(row.session!,row.security_id!,latestObserved);
        if(batch){const provenance=JSON.parse(String(batch.body));this.ledger.observeBaseline(this.recorder.date,String(row.symbol),{
          candle:current,observedAt:latestObserved,sourceTime:start+FIVE,source:provenance.source+'; historical baseline refresh (not original live observation)',
          issues:[...provenance.missing.filter((issue:string)=>issue!=='historical_volume_missing'),...(current.volume===null?['historical_volume_missing']:[])]});}
      }
      for(const rev of revisions)admit(JSON.parse(String(rev.replacement_json)),Number(rev.observed_at));
    }
    this.ledger.db.exec('COMMIT');
    this.historyIngestedThrough=now;
    } catch(error) {this.ledger.db.exec('ROLLBACK');throw error;}
  }
  async poll(input?:SessionReport,compact=false):Promise<CombinedReport> {
    const report=input??await this.recorder.poll(this.clock());
    const errors:string[]=[];
    let backfill:BackfillReport;
    try {backfill=await this.backfill(this.clock());}
    catch {errors.push('paper_backfill_storage_error');backfill={status:'backfill_failed',calendarSource:this.ledger.config.calendar.source,previousSessions:[],requestsThisPoll:0,maxRequestsPerPoll:this.maxBackfillPerPoll,maxAttemptsPerSymbolSession:2,missing:[]};}
    let now=this.clock();let ingested=true;
    try {this.ingest(now);}catch{ingested=false;errors.push('paper_ingestion_error');}
    // Manage every previously open position before evaluating current-session new-entry gates.
    for(const state of this.ledger.list().filter(s=>s.status==='open'||s.status==='pending-entry')) {
      try{this.ledger.tickExisting(state.id,this.clock());}catch{errors.push(`paper_risk_state_error/${state.symbol}/${state.session}`);}
    }
    for(const instrument of ingested?this.recorder.instruments:[]) {
      try{this.ledger.tick(instrument.symbol,this.recorder.date,this.clock());}catch{errors.push(`paper_evaluation_error/${instrument.symbol}`);}
    }
    now=this.clock();
    const snapshot=this.ledger.snapshot(this.recorder.date,compact);
    const paper={...snapshot,observedAt:new Date(now).toISOString(),backfill,errors,scanner:scanUniverse(this.recorder,this.ledger,report,now)};
    const combined={...report,paper};if(!compact)this.recorder.store.saveReport(combined);return combined;
  }
}
