import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { at, day, FIVE, minute, validCandle, validDate, type Candle } from './model.js';
import { relativeVolume, vwap } from './analysis.js';

export type PaperMode = 'strict' | 'approximate-research';
export type PaperCalendar = {
  source: string;
  coverageFrom: string;
  coverageTo: string;
  // Must enumerate every session in coverage, including holiday exclusions.
  sessions: string[];
  independentlyVerified: boolean;
};
export type PaperConfig = {
  exitTime?: '15:10'|'15:15';
  variant?: 'range-hold'|'range-failure-exit'|'agent-recovery';
  mode: PaperMode;
  quantity: number;
  feesPerSide: number | null;
  slippageBps: number | null;
  maxObservationDelayMs: number;
  calendar: PaperCalendar;
  acceptScheduledCalendarForResearch: boolean;
  acceptStartLabelsForResearch: boolean;
  timestampSemanticsVerified: boolean;
};
export const paperDefaults = (calendar: PaperCalendar): PaperConfig => ({
  mode: 'strict', quantity: 1, feesPerSide: null, slippageBps: null,
  maxObservationDelayMs: 60_000, calendar,
  acceptScheduledCalendarForResearch: false, acceptStartLabelsForResearch: false,
  timestampSemanticsVerified: false,
});
export type Observation = { candle: Candle; observedAt: number; source: string; sourceTime: number; issues: string[] };
export type PaperState = {
  id: string; symbol: string; session: string; strategy: string; mode: PaperMode;
  status: 'blocked' | 'no-signal' | 'pending-entry' | 'open' | 'closed';
  reasons: string[]; signal: number | null; entryAt: number | null; entry: number | null;
  stop: number | null; target: number | null; exitAt: number | null; exit: number | null;
  exitReason: string | null; grossPnl: number | null; netPnl: number | null;
  invalidatedAt?:number;
  terms?: { feesPerSide:number|null; slippageBps:number|null };
  quantity: number; updatedAt: number; cursor: number; unknownOutcome: boolean;
};
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const strategy = 'orb-long-v1';

/** Immutable first-observation ledger. No broker dependency or order API. */
export class PaperLedger {
  readonly db: DatabaseSync;
  readonly configHash: string;
  constructor(path: string, readonly config: PaperConfig) {
    if (config.exitTime!==undefined&&!['15:10','15:15'].includes(config.exitTime) || !['strict','approximate-research'].includes(config.mode) || !Number.isSafeInteger(config.quantity) || config.quantity < 1 ||
      !Number.isFinite(config.maxObservationDelayMs) || config.maxObservationDelayMs < 0 ||
      !validDate(config.calendar.coverageFrom) || !validDate(config.calendar.coverageTo) || config.calendar.coverageFrom>config.calendar.coverageTo ||
      config.calendar.sessions.some(d=>!validDate(d)||d<config.calendar.coverageFrom||d>config.calendar.coverageTo) ||
      [config.feesPerSide,config.slippageBps].some(x=>x!==null && (!Number.isFinite(x) || x<0))) throw new Error('INVALID_PAPER_CONFIG');
    this.configHash=hash(config);
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS paper_observations (
        symbol TEXT NOT NULL, start INTEGER NOT NULL, fingerprint TEXT NOT NULL, observed_at INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(symbol,start,fingerprint));
      CREATE TABLE IF NOT EXISTS paper_baselines (
        evaluation_session TEXT NOT NULL,symbol TEXT NOT NULL,start INTEGER NOT NULL,fingerprint TEXT NOT NULL,observed_at INTEGER NOT NULL,
        body TEXT NOT NULL,PRIMARY KEY(evaluation_session,symbol,start,observed_at,fingerprint));
      CREATE TABLE IF NOT EXISTS paper_states (id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_events (
        id INTEGER PRIMARY KEY, state_id TEXT NOT NULL, event_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL, source_at INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(state_id,event_key));`);
  }
  close() { this.db.close(); }
  observe(symbol: string, o: Observation) {
    if (!symbol || !Number.isFinite(o.observedAt) || !Number.isFinite(o.sourceTime) || o.sourceTime>o.observedAt ||
      !Number.isFinite(o.candle.start)) throw new Error('INVALID_OBSERVATION_TIMES');
    // Future/incomplete bars are not admitted. They may be observed again after completion.
    if (o.candle.start+FIVE>o.observedAt) return;
    const fingerprint=hash({candle:o.candle,source:o.source,issues:o.issues});
    this.db.prepare('INSERT OR IGNORE INTO paper_observations VALUES (?,?,?,?,?)')
      .run(symbol,o.candle.start,fingerprint,o.observedAt,JSON.stringify(o));
  }
  observeBaseline(evaluationSession:string,symbol:string,o:Observation) {
    if(!validDate(evaluationSession)||day(o.candle.start)>=evaluationSession||!validCandle(o.candle)||
      o.candle.start+FIVE>o.observedAt||o.sourceTime>o.observedAt||!Number.isFinite(o.observedAt))throw new Error('INVALID_BASELINE_OBSERVATION');
    const fingerprint=hash({candle:o.candle,source:o.source,issues:o.issues});
    this.db.prepare('INSERT OR IGNORE INTO paper_baselines VALUES(?,?,?,?,?,?)')
      .run(evaluationSession,symbol,o.candle.start,fingerprint,o.observedAt,JSON.stringify(o));
  }
  baselines(session:string,symbol:string,now:number):Observation[] {
    const rows=this.db.prepare(`SELECT body FROM (SELECT body,ROW_NUMBER() OVER(PARTITION BY start ORDER BY observed_at DESC,rowid DESC) AS n
      FROM paper_baselines WHERE evaluation_session=? AND symbol=? AND observed_at<=?) WHERE n=1`).all(session,symbol,now) as {body:string}[];
    return rows.map(r=>JSON.parse(r.body));
  }
  private observations(symbol: string, now: number): Observation[] {
    // Freeze the earliest observed version, even if a correction later looks better.
    const rows=this.db.prepare(`SELECT body FROM (
      SELECT body, ROW_NUMBER() OVER (PARTITION BY start ORDER BY rowid) AS n
      FROM paper_observations WHERE symbol=? AND observed_at<=?) WHERE n=1`).all(symbol,now) as {body:string}[];
    return rows.map(r=>JSON.parse(r.body) as Observation).sort((a,b)=>a.candle.start-b.candle.start);
  }
  private event(s: PaperState, key: string, now: number, source: number|null, kind: string, body: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO paper_events(state_id,event_key,observed_at,source_at,kind,body) VALUES (?,?,?,?,?,?)')
      .run(s.id,key,now,source,kind,JSON.stringify(body));
  }
  list(): PaperState[] {
    return (this.db.prepare('SELECT body FROM paper_states ORDER BY id').all() as {body:string}[]).map(r=>JSON.parse(r.body));
  }
  events(id: string) { return this.db.prepare('SELECT * FROM paper_events WHERE state_id=? ORDER BY id').all(id); }
  revisions(symbol: string) {
    return this.db.prepare('SELECT start,COUNT(*) AS versions FROM paper_observations WHERE symbol=? GROUP BY start HAVING COUNT(*)>1').all(symbol);
  }
  tick(symbol: string, session: string, now: number): PaperState {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.advance(symbol,session,now);
      this.db.exec('COMMIT'); return result;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  tickExisting(id:string,now:number):PaperState {
    const row=this.db.prepare('SELECT body FROM paper_states WHERE id=?').get(id) as {body:string}|undefined;
    if(!row)throw new Error('PAPER_STATE_NOT_FOUND');
    const s:PaperState=JSON.parse(row.body);
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=this.advance(s.symbol,s.session,now,id);this.db.exec('COMMIT');return result;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  protectiveExit(id:string,evidence:{price:number;sourceTime:number;observedAt:number;reason:string},now:number){
    if(this.config.variant!=='agent-recovery'||!Number.isFinite(evidence.price)||evidence.price<=0||evidence.sourceTime>evidence.observedAt||evidence.observedAt>now||now-evidence.sourceTime>this.config.maxObservationDelayMs)throw Error('PAPER_INVALID_PROTECTIVE_EVIDENCE');
    const s=this.list().find(s=>s.id===id);if(!s||s.status!=='open')return false;
    this.db.exec('BEGIN IMMEDIATE');try{s.status='closed';s.exit=evidence.price;s.exitAt=evidence.sourceTime;s.exitReason='agent_protective_observed_price_unknown_path';s.unknownOutcome=true;s.grossPnl=null;s.netPnl=null;s.updatedAt=now;s.reasons=['gap_path_unresolved',evidence.reason];
    this.event(s,'agent-protective-exit',now,evidence.sourceTime,'agent_protective_exit',{evidence,execution:'protective paper mark at observed completed close; not executable fill; historical stop path unresolved'});
    this.db.prepare('UPDATE paper_states SET body=? WHERE id=?').run(JSON.stringify(s),id);this.db.exec('COMMIT');return true;}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  snapshot(session:string,compact=false) {
    const states=this.list().filter(s=>s.session===session);
    return {simulatedOnly:true,exactQualification:false,mode:this.config.mode,observedAt:null as string|null,
      assumptions:{calendar:this.config.calendar,timestampSemanticsVerified:this.config.timestampSemanticsVerified,
        acceptStartLabelsForResearch:this.config.acceptStartLabelsForResearch,
        acceptScheduledCalendarForResearch:this.config.acceptScheduledCalendarForResearch,
        vwapMethod:'HLC3 completed-bar approximation in research mode only',quantity:this.config.quantity,
        plannedExitTimeIST:this.config.exitTime??'15:15',plannedExitConfirmationIST:this.config.exitTime==='15:10'?'15:15':'15:20',plannedExitPrice:'planned candle open, admitted only after that candle completes',
        feesPerSide:this.config.feesPerSide,slippageBps:this.config.slippageBps,maxObservationDelayMs:this.config.maxObservationDelayMs},
      baselineProvenance:this.db.prepare('SELECT evaluation_session,symbol,COUNT(*) AS observations,MAX(observed_at) AS last_observed_at FROM paper_baselines WHERE evaluation_session=? GROUP BY evaluation_session,symbol').all(session),
      baselinePolicy:'Fresh historical REST observations are separate from original execution observations; never exact verification',
      states,events:states.flatMap(s=>this.events(s.id)).sort((a,b)=>Number(a.id)-Number(b.id)).slice(compact?-200:-2000).map(e=>{if(!compact)return e;const body=JSON.parse(String(e.body));const {baselineObservations,calendar,previous20,...rest}=body;return {...e,body:JSON.stringify({...rest,...(baselineObservations?{baselineObservationCount:baselineObservations.length}:{}),fullEvidence:'SQLite audit export'})};}),
      revisions:[...new Set(states.map(s=>s.symbol))].flatMap(symbol=>this.revisions(symbol).map(r=>({symbol,...r}))),
      eventsLimit:compact?200:2000,fullAuditExport:'node dist/paper-export.js /data/paper.sqlite'};
  }
  private advance(symbol: string, session: string, now: number, existingId?:string): PaperState {
    if (!validDate(session) || !Number.isFinite(now) || (!existingId && day(now)!==session)) throw new Error('TICK_REQUIRES_CURRENT_SESSION');
    const strategyName=this.config.variant?`${strategy}/${this.config.variant}`:strategy;
    const id=existingId??`${symbol}/${session}/${strategyName}/${this.config.mode}`;
    const saved=this.db.prepare('SELECT config_hash,body FROM paper_states WHERE id=?').get(id) as {config_hash:string;body:string}|undefined;
    const changed=Boolean(saved && saved.config_hash!==this.configHash);
    const s: PaperState=saved?JSON.parse(saved.body):{
      id,symbol,session,strategy:strategyName,mode:this.config.mode,status:'blocked',reasons:[],signal:null,
      entryAt:null,entry:null,stop:null,target:null,exitAt:null,exit:null,exitReason:null,
      grossPnl:null,netPnl:null,terms:{feesPerSide:this.config.feesPerSide,slippageBps:this.config.slippageBps},quantity:this.config.quantity,updatedAt:now,cursor:at(session,'09:30')-FIVE,unknownOutcome:false,
    };
    if(now<s.updatedAt) throw new Error('NON_MONOTONIC_PAPER_CLOCK');
    const persist=()=>{
      s.updatedAt=now;
      this.db.prepare('INSERT INTO paper_states VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(id,saved?.config_hash??this.configHash,JSON.stringify(s));return s;
    };
    const block=(reasons:string[])=>{
      const unique=[...new Set(reasons)].sort();
      this.event(s,`block/${s.cursor}/${hash(unique)}`,now,null,'blocked',{reasons:unique});
      s.reasons=unique;if(s.status!=='open' && s.status!=='pending-entry' && s.status!=='closed')s.status='blocked';
      return persist();
    };
    if(s.status==='closed') return persist();
    const cfg=this.config, cal=cfg.calendar, research=cfg.mode==='approximate-research';
    const plannedExitTime=cfg.exitTime??'15:15',plannedExit=at(session,plannedExitTime),plannedExitComplete=plannedExit+FIVE;
    const gates:string[]=[];
    if(changed)gates.push('configuration_changed_for_existing_session');
    if(!saved && this.list().some(other=>other.symbol===symbol&&other.session===session&&other.id!==id&&other.signal!==null))
      gates.push('another_mode_consumed_symbol_session');
    if(day(now)!==session)gates.push('session_has_ended');
    if(!research)gates.push('timestamp_aligned_exact_session_vwap_unavailable');
    if(!cfg.timestampSemanticsVerified && !(research&&cfg.acceptStartLabelsForResearch))gates.push('unverified_candle_timestamp_semantics');
    if(!cal.independentlyVerified && !(research&&cfg.acceptScheduledCalendarForResearch))gates.push('unverified_calendar');
    if(!cal.source || !cal.sessions.includes(session) || cal.coverageTo<session)gates.push('session_outside_calendar_coverage');
    const previous=[...new Set(cal.sessions.filter(d=>d<session))].sort().slice(-20);
    if(previous.length!==20 || !previous[0] || cal.coverageFrom>previous[0] || new Set(cal.sessions).size!==cal.sessions.length)
      gates.push('missing_verified_coverage_for_previous_20_sessions');
    if(gates.length && s.status!=='open') {
      if(s.status==='pending-entry') {s.status='closed';s.exitReason='entry_gates_blocked';this.event(s,'entry-gates-blocked',now,null,'entry_rejected',{gates});}
      return block(gates);
    }
    if(gates.length) {s.reasons=gates;this.event(s,`risk-continues/${hash(gates)}`,now,null,'new_entries_blocked_risk_continues',{gates});}
    const all=this.observations(symbol,now);
    const baselineByStart=new Map(all.filter(o=>day(o.candle.start)<session).map(o=>[o.candle.start,o]));
    for(const o of this.baselines(session,symbol,now))baselineByStart.set(o.candle.start,o);
    const history=[...baselineByStart.values()];
    const current=all.filter(o=>day(o.candle.start)===session&&minute(o.candle.start)>=555&&minute(o.candle.start)<930);
    const byStart=new Map(current.map(o=>[o.candle.start,o]));
    const bars=current.map(o=>o.candle);
    const bad=(o:Observation)=>!validCandle(o.candle)||o.candle.volume===null||o.issues.length>0;
    const range=current.filter(o=>o.candle.start<at(session,'09:30'));
    if(s.status!=='open' && (now<at(session,'09:30')||range.length!==3||range.some(bad)))return block(['opening_range_incomplete_or_invalid']);
    const high=Math.max(...range.map(o=>o.candle.high)), low=Math.min(...range.map(o=>o.candle.low));
    const end=Math.min(Math.floor(now/FIVE)*FIVE,at(session,'15:30'));
    // Process strictly in slot order. A missing slot creates irreversible observation uncertainty
    // for an open position; later backfill is retained but cannot improve its fill.
    for(let t=s.cursor+FIVE;t<end;t+=FIVE){
      const o=byStart.get(t);
      if(!o || (s.status==='open' ? !validCandle(o.candle)||o.issues.some(x=>x!=='historical_volume_missing') : bad(o)) || (s.status==='open'&&o.observedAt>t+FIVE+cfg.maxObservationDelayMs)) {
        if(!o && now<=t+FIVE+cfg.maxObservationDelayMs) return block([`awaiting_completed_candle/${new Date(t).toISOString()}`]);
        if(s.status==='open') {
          s.unknownOutcome=true;s.exitReason='missing_or_invalid_exit_path';
          if(now>=plannedExitComplete) {s.status='closed';s.exitReason='unresolved_exit_data';}
          this.event(s,`unknown/${t}`,now,t,'unknown_outcome',{missingSlot:t});
        }
        if(s.status==='pending-entry' && now>t+FIVE+cfg.maxObservationDelayMs){
          s.status='closed';s.exitReason='entry_observation_unavailable';
          this.event(s,`entry-unavailable/${t}`,now,t,'entry_rejected',{reason:s.exitReason});
        }
        if(s.status==='closed') this.event(s,`unresolved/${t}`,now,t,'closed',{...s});
        return block([`missing_or_invalid_candle/${new Date(t).toISOString()}`]);
      }
      const c=o.candle;
      if(s.status==='open') {
        if(s.unknownOutcome) {
          // Never establish an exit from a later, revised or backfilled path.
          if(now>=plannedExitComplete) {s.status='closed';s.exitReason='unresolved_exit_data';this.event(s,'unknown-final',now,null,'closed',{...s});s.cursor=t;break;}
          s.cursor=t;continue;
        }
        let exit:number|null=null, reason:string|null=null, exitAt=t+FIVE;
        if(t===plannedExit){exit=c.open;reason='forced_'+plannedExitTime;exitAt=t;}
        else if(t>plannedExit) {s.unknownOutcome=true;reason='missing_forced_exit';}
        else if(c.open<=s.stop!){exit=c.open;reason='gap_stop';exitAt=t;}
        else if(c.open>=s.target!){exit=s.target;reason='gap_target_capped';exitAt=t;}
        else if(cfg.variant==='range-failure-exit'&&s.invalidatedAt!==undefined&&t>=s.invalidatedAt){exit=c.open;reason='range_failure_next_open';exitAt=t;}
        else if(c.low<=s.stop!){exit=s.stop;reason=c.high>=s.target!?'stop_first_ambiguous':'stop';}
        else if(c.high>=s.target!){exit=s.target;reason='target';}
        if(reason){
          s.status='closed';s.exit=exit;s.exitAt=exit===null?null:exitAt;s.exitReason=reason;
          if(exit!==null) {
            s.grossPnl=(exit-s.entry!)*s.quantity;
            const terms=s.terms;
            if(terms&&terms.feesPerSide!==null&&terms.slippageBps!==null)
              s.netPnl=s.grossPnl-2*terms.feesPerSide-(exit+s.entry!)*s.quantity*terms.slippageBps/10_000;
          }
          this.event(s,`exit/${t}`,now,t,'closed',{...s,observation:o,execution:'completed-bar hypothetical; not executable live price'});
          s.cursor=t;break;
        }
        if(cfg.variant==='range-failure-exit'&&c.close<high)s.invalidatedAt=t+FIVE;
      } else if(s.status==='pending-entry') {
        if(t!==s.signal!+FIVE || o.observedAt-(t+FIVE)>cfg.maxObservationDelayMs || now-(t+FIVE)>cfg.maxObservationDelayMs){
          s.status='closed';s.exitReason='entry_observation_too_late';s.reasons=['entry_observation_too_late'];
          this.event(s,`entry-rejected/${t}`,now,t,'entry_rejected',{observation:o});s.cursor=t;break;
        }
        if(c.open<=s.stop!){s.status='closed';s.exitReason='entry_gap_at_or_below_stop';s.cursor=t;this.event(s,`entry-gap/${t}`,now,t,'entry_rejected',{observation:o,reason:s.exitReason});break;}
        s.status='open';s.entryAt=t;s.entry=c.open;s.target=c.open+2*(c.open-s.stop!);
        this.event(s,`entry/${t}`,now,t,'open',{...s,observation:o,execution:'next completed candle open; hypothetical earlier source time',delayMs:now-t});
        // Revisit entry bar for stop/target; this is within the same transaction.
        t-=FIVE;continue;
      } else if(t+FIVE<=at(session,'11:00')) {
        if(o.observedAt-(t+FIVE)>cfg.maxObservationDelayMs || now-(t+FIVE)>cfg.maxObservationDelayMs){
          s.cursor=t;s.status='blocked';s.reasons=['signal_observed_too_late'];this.event(s,`late/${t}`,now,t,'blocked',{reason:'signal_observed_too_late'});continue;
        }
        const prefix=bars.filter(b=>b.start<=t);
        for(let p=at(session,'09:15');p<=t;p+=FIVE)if(!byStart.has(p))return block(['missing_signal_prefix']);
        if(current.filter(x=>x.candle.start<=t).some(bad))return block(['invalid_signal_prefix']);
        const rv=relativeVolume(c,history.map(o=>o.candle),previous);
        if(rv.missing)return block([`missing_prior_20_same_slot_volume/${t}`]);
        // Prior baseline observations must themselves be valid, with visible provenance.
        if(history.some(h=>previous.includes(day(h.candle.start))&&minute(h.candle.start)===minute(t)&&bad(h)))return block(['invalid_baseline']);
        const vw=vwap(prefix);
        if(vw===null)return block(['undefined_approximate_vwap']);
        s.status='no-signal';s.reasons=[];
        let qualifies=c.close>high&&c.close>vw&&rv.ratio!>=1.5;
        if(cfg.variant==='range-hold'){const prev=byStart.get(t-FIVE)?.candle;const prevVwap=vwap(prefix.filter(c=>c.start<t));const prevRv=prev?relativeVolume(prev,history.map(o=>o.candle),previous):null;qualifies=Boolean(prev&&prev.start>=at(session,'09:30')&&prevVwap!==null&&prev.close>high&&prev.close>prevVwap&&prevRv?.ratio!==null&&(prevRv?.ratio??0)>=1.5&&c.close>high&&c.close>vw);}
        this.event(s,`decision/${t}`,now,t+FIVE,qualifies?'research_signal':'no_signal',{
          observation:o,high,low,vwap:vw,vwapMethod:'HLC3 bar approximation',relativeVolume:rv,
          previous20:previous,calendar:cal,exactQualification:false,configHash:this.configHash,
          baselineObservations:history.filter(h=>previous.includes(day(h.candle.start))&&minute(h.candle.start)===minute(t)),
        });
        if(qualifies){s.status='pending-entry';s.signal=t;s.stop=low;}
      }
      s.cursor=t;
    }
    if(s.status==='open'&&now>=plannedExitComplete&&!byStart.has(plannedExit)){
      s.unknownOutcome=true;s.reasons=['missing_forced_exit_bar'];
    }
    return persist();
  }
}
