import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {at,FIVE,day,validCandle} from './model.js';
import type {Candidate} from './strategy-selection.js';
import {firstStrategyCandidate,SESSION_BARS} from './setup-signals.js';
import type {StrategyLabStore} from './strategy-lab-store.js';
import type {LabStrategy} from './strategy-registry.js';
import type {Observation} from './paper.js';
/** A new decision can only consume immutable completed observations already delivered now. */
export function middayDecisions(dir:string,store:StrategyLabStore,cfg:LabStrategy,session:string,symbols:string[],calendar:string[],now:number):Candidate[]{
 if(!cfg.signalWindow)return [];
 const start=Math.floor((now-10000)/FIVE)*FIVE-FIVE,end=start+FIVE;
 if(start<at(session,cfg.signalWindow.start)||end>at(session,cfg.signalWindow.end))return [];
 const previous=calendar.filter(d=>d<session).sort().slice(-20),out:Candidate[]=[];
 const saved=store.db.prepare('SELECT body FROM lab_signal_decisions WHERE strategy_id=? AND session=? AND symbol=? AND signal_start=?');
 const insert=store.db.prepare('INSERT OR IGNORE INTO lab_signal_decisions VALUES(?,?,?,?,?,?)');
 const candleDb=new DatabaseSync(join(dir,'candles.sqlite'),{readOnly:true});candleDb.exec('PRAGMA busy_timeout=1500;PRAGMA temp_store=MEMORY;');
 const dbs=['paper.sqlite','paper-screener-orb.sqlite'].filter(file=>existsSync(join(dir,file))).map(file=>new DatabaseSync(join(dir,file),{readOnly:true}));
 try{for(const symbol of symbols){const prior=saved.get(cfg.id,session,symbol,start);if(prior){const v=JSON.parse(String(prior.body));if(v.candidate)out.push(v.candidate);continue;}
  let current:Observation[]=[],history:Observation[]=[];
  for(const db of dbs){db.exec('PRAGMA busy_timeout=1500;PRAGMA temp_store=MEMORY;');
   const cs=db.prepare('SELECT body FROM (SELECT body,ROW_NUMBER() OVER(PARTITION BY start ORDER BY rowid) AS n FROM paper_observations WHERE symbol=? AND start>=? AND start<=? AND observed_at<=?) WHERE n=1').all(symbol,at(session,'09:15'),start,now).map(r=>JSON.parse(String(r.body)) as Observation);
   if(cs.length>current.length)current=cs;
  }
  // The legacy ledger freezes only morning baseline slots. Midday freezes its own
  // prior-20 same-slot history, reconstructing versions available at this decision.
  // ema-pullback needs a gap-free continuous series instead of same-slot samples, so it
  // fetches every candle of each prior session rather than a handful of matching times.
  const bySession=cfg.setup==='ema-pullback',slotsPerDay=bySession?SESSION_BARS:cfg.setup==='breakout-retest'?4:1;
  const slots=bySession?[]:Array.from({length:slotsPerDay},(_,i)=>new Date(start-i*FIVE+19800000).toISOString().slice(11,16)),epochs=bySession?[]:previous.flatMap(date=>slots.map(slot=>at(date,slot)));history=[];
  // Fail closed cheaply before reconstructing large baseline batches. Missing tails
  // cannot be silently treated as a no-signal or filled with invented EMA inputs.
  if(bySession){
   const metadata=previous.length?candleDb.prepare('SELECT session,source_epoch_ms FROM candles WHERE symbol=? AND session IN ('+previous.map(()=>'?').join(',')+') AND first_observed_at<=? ORDER BY source_epoch_ms').all(symbol,...previous,now):[];
   const counts=previous.map(date=>{const rows=metadata.filter(r=>r.session===date);return {session:date,bars:rows.length,complete:rows.length===SESSION_BARS&&rows.every((r,i)=>Number(r.source_epoch_ms)===at(date,'09:15')+i*FIVE)};});
   if(previous.length!==20||counts.some(c=>!c.complete)){
    if(now-end<=60000)continue;
    insert.run(cfg.id,session,symbol,start,now,JSON.stringify({candidate:null,reason:'ema_prior20_full_session_history_missing',observedAt:now,signalStart:start,setup:cfg.setup,requiredBarsPerSession:SESSION_BARS,historyCoverage:counts}));continue;
   }
  }
  const batchCache=new Map<string,any>();
  const reconstruct=(row:any)=>{
   const revision=candleDb.prepare('SELECT previous_json FROM revisions WHERE session=? AND security_id=? AND source_epoch_ms=? AND observed_at>? ORDER BY observed_at,id LIMIT 1').get(row.session!,row.security_id!,row.source_epoch_ms!,now);
   const last=candleDb.prepare('SELECT MAX(observed_at) t FROM revisions WHERE session=? AND security_id=? AND source_epoch_ms=? AND observed_at<=?').get(row.session!,row.security_id!,row.source_epoch_ms!,now);
   const observedAt=Number(row.last_observed_at)<=now?Number(row.last_observed_at):Number(last?.t??row.first_observed_at);
   const candle=revision?JSON.parse(String(revision.previous_json)):{start:Number(row.source_epoch_ms),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:row.volume===null?null:Number(row.volume)};
   const key=String(row.session)+'/'+String(row.security_id)+'/'+observedAt;if(!batchCache.has(key)){const batch=candleDb.prepare('SELECT body FROM candle_batches WHERE session=? AND security_id=? AND observed_at=?').get(row.session!,row.security_id!,observedAt);batchCache.set(key,batch?JSON.parse(String(batch.body)):null);}const provenance=batchCache.get(key);
   history.push({candle,observedAt,sourceTime:candle.start+FIVE,source:provenance?.source??'unavailable',issues:provenance?(provenance.missing??[]).filter((v:string)=>v!=='historical_volume_missing'):['baseline_batch_provenance_unavailable']});
  };
  if(bySession){if(previous.length)for(const row of candleDb.prepare('SELECT * FROM candles WHERE symbol=? AND session IN ('+previous.map(()=>'?').join(',')+') AND first_observed_at<=?').all(symbol,...previous,now))reconstruct(row);}
  else if(epochs.length)for(const row of candleDb.prepare('SELECT * FROM candles WHERE symbol=? AND source_epoch_ms IN ('+epochs.map(()=>'?').join(',')+') AND first_observed_at<=?').all(symbol,...epochs,now))reconstruct(row);
  const latest=current.find(o=>o.candle.start===start),bad=(o:Observation)=>!validCandle(o.candle)||o.candle.volume===null||o.issues.length>0||o.sourceTime>o.observedAt||o.observedAt>now;
  let reason='no_qualifying_breakout';let candidate:Candidate|null=null;
  if(!latest){if(now-end<=60000)continue;reason='completed_observation_missing_before_deadline';}
  else if(now-end>60000||latest.observedAt-end>60000)reason='completed_observation_too_late';
  else if(current.length!==(start-at(session,'09:15'))/FIVE+1||history.length!==previous.length*slotsPerDay||previous.length!==20){if(now-end<=60000)continue;reason='missing_prefix_or_prior20_baseline';}
  else if(current.some(bad)||history.some(bad))reason='invalid_observation_or_baseline';
  else{const t=new Date(start+19800000).toISOString().slice(11,16),e=new Date(end+19800000).toISOString().slice(11,16);candidate=firstStrategyCandidate(cfg,symbol,session,current.map(o=>o.candle),history.map(o=>o.candle),previous,0,{start:t,end:e});
   if(candidate){candidate={...candidate,id:`${cfg.id}/${session}/${symbol}/${start}`,decidedAt:now,source:'Immutable paper observations and as-of baseline snapshot; actual midday engine decision time'};reason='research_signal';}}
  const evidence={candidate,reason,observedAt:now,signalStart:start,latestObservation:latest??null,openingObservations:current.filter(o=>o.candle.start<at(session,'09:30')),prefixObservations:current,baselineObservations:history,window:cfg.signalWindow,setup:cfg.setup??'opening-range'};
  insert.run(cfg.id,session,symbol,start,now,JSON.stringify(evidence));if(candidate)out.push(candidate);
 }}finally{for(const db of dbs)db.close();candleDb.close();}return out;
}
export function middayReplayCandidates(store:StrategyLabStore,cfg:LabStrategy,session:string){const rows=store.db.prepare('SELECT body FROM lab_signal_decisions WHERE strategy_id=? AND session=? ORDER BY observed_at,symbol').all(cfg.id,session);return {available:rows.length>0,candidates:rows.map(r=>JSON.parse(String(r.body)).candidate).filter((c):c is Candidate=>Boolean(c))};}
