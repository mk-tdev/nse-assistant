import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {StrategyLabStore} from './strategy-lab-store.js';
import {labStrategies} from './strategy-registry.js';
import {day} from './model.js';
import {freshQuote,valuePosition,type QuoteRow} from './paper-valuation.js';
import {summarizeOverview} from './strategy-overview.js';
const policy='First WAIT/SKIP per technical candidate; prospective observed quotes only. Ten shares and the same price, freshness, stop/2R target, 15:10 exit and cost rules as approved trades. Unlimited independent opportunities, not a capital-constrained portfolio. Repeated reviews are deduplicated; later filled approvals are shown separately. Genuine quote gaps remain unknown.';
export function initializeShadows(store:StrategyLabStore,now=Date.now()){
 store.db.exec(`CREATE TABLE IF NOT EXISTS shadow_meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS shadow_origins(candidate_id TEXT PRIMARY KEY,decision_id TEXT,session TEXT,symbol TEXT,action TEXT,decided_at INTEGER,run_id TEXT,reason TEXT);`);
 store.db.prepare('INSERT OR IGNORE INTO shadow_meta VALUES(?,?)').run('enabled_since',String(now));
}
export function updateShadows(agentDb:DatabaseSync,shadow:StrategyLabStore,quotes:QuoteRow[],now=Date.now()){
 const enabled=Number(shadow.db.prepare("SELECT value FROM shadow_meta WHERE key='enabled_since'").get()!.value);
 const decisions=agentDb.prepare("SELECT * FROM agent_decisions WHERE observed_at>=? AND json_extract(body,'$.mode')='live' AND json_extract(body,'$.action') IN ('wait','skip') ORDER BY observed_at,id").all(enabled);
 for(const r of decisions){const id=String(r.candidate_id);if(shadow.db.prepare('SELECT 1 FROM shadow_origins WHERE candidate_id=?').get(id))continue;const b=JSON.parse(String(r.body)),c=b.originalCandidate;if(!c||c.session!==r.session||c.symbol!==r.symbol)continue;
  const run='live/'+r.session+'/'+createHash('sha256').update(id).digest('hex').slice(0,24),action=String(b.action),cfg={...labStrategies[1]!,id:'agent-shadow-'+action+'-10-v1',name:'Agent '+action+' shadow / 10 shares',enabled:true,maxExtension:1,signalWindow:{start:'09:30',end:'14:30'}};
  // Same database transaction protects origin and plan creation across restarts.
  shadow.db.exec('BEGIN IMMEDIATE');try{shadow.consider(run,cfg,{...c,decidedAt:Number(r.observed_at),source:'Prospective shadow of agent '+action,setupEvidence:{shadowDecisionId:r.id,originalCandidate:c,decision:action}},null,[],now,'observed-quote');shadow.db.prepare('INSERT INTO shadow_origins VALUES(?,?,?,?,?,?,?,?)').run(id,String(r.id),String(r.session),String(r.symbol),action,Number(r.observed_at),run,b.reason);shadow.db.exec('COMMIT');}catch(e){shadow.db.exec('ROLLBACK');throw e;}
 }
 // Include every pending/open run, not just the latest 100 runs. Old sessions close unknown.
 for(const r of shadow.db.prepare("SELECT DISTINCT run_id,session FROM lab_positions WHERE json_extract(body,'$.status') IN ('open','pending-entry')").all())shadow.applyQuotes(String(r.run_id),String(r.session)===day(now)?quotes:[],now);
}
export function shadowView(agentDir:string,session:string,quotes:QuoteRow[],approved:any[],now=Date.now()){
 const file=join(agentDir,'shadow','strategy-lab.sqlite');if(!existsSync(file))return {policy,enabledSince:null,rows:[],summary:{tracked:0,missedWinners:0,avoidedLosses:0,laterApproved:0,unresolved:0,noFill:0,pending:0,open:0,missedProfit:0,avoidedLoss:0}};
 const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500;');const enabled=db.prepare("SELECT value FROM shadow_meta WHERE key='enabled_since'").get();const rows=db.prepare('SELECT o.*,p.body AS position_body FROM shadow_origins o LEFT JOIN lab_positions p ON p.run_id=o.run_id WHERE o.session=? ORDER BY o.decided_at DESC').all(session).map(r=>{
  const p=r.position_body?JSON.parse(String(r.position_body)):null,q=session===day(now)?quotes.find(q=>q.symbol===r.symbol):undefined,mark=freshQuote(q,now);const value=p?.entry!==null&&p?valuePosition(p,q,now):null;
  const actual=approved.find(p=>p.candidate?.id===r.candidate_id&&p.entry!==null),closedKnown=p?.status==='closed'&&!p.unknownOutcome&&Number.isFinite(p.netPnl),actualKnown=actual?.status==='closed'&&!actual.unknownOutcome&&Number.isFinite(actual.netPnl);
  const classification=actual?'later_approved':p?.unknownOutcome?'unresolved':closedKnown?(p.netPnl>0?'missed_winner':p.netPnl<0?'avoided_loss':'flat'):p?.status==='skipped'?'no_fill':p?.status==='pending-entry'?'pending':'open';
  return {candidateId:r.candidate_id,decisionId:r.decision_id,symbol:r.symbol,action:r.action,decidedAt:r.decided_at,reason:r.reason,status:p?.status??'unavailable',quantity:p?.quantity??10,entry:p?.entry??null,entryAt:p?.entryAt??null,stop:p?.stop??null,target:p?.target??null,exit:p?.exit??null,exitAt:p?.exitAt??null,exitReason:p?.exitReason??null,unknownOutcome:p?.unknownOutcome??false,reasons:p?.reasons??[],grossPnl:p?.status==='closed'?p.grossPnl:value?.grossPnl??null,netPnl:p?.status==='closed'?p.netPnl:value?.estimatedNetPnl??null,costs:p?.status==='closed'?p.costs:value?.costs??null,quote:{price:mark?.price??null,current:Boolean(mark)},classification,approvedPositionId:actual?.id??null,approvedNetPnl:actualKnown?actual.netPnl:null,approvedMinusShadowNet:actualKnown&&closedKnown?Math.round((actual.netPnl-p.netPnl)*100)/100:null,session};
 });
 const entered=rows.filter(r=>r.entry!==null),missed=rows.filter(r=>r.classification==='missed_winner'),avoided=rows.filter(r=>r.classification==='avoided_loss');return {policy,enabledSince:enabled?new Date(Number(enabled.value)).toISOString():null,rows,summary:{tracked:rows.length,missedWinners:missed.length,avoidedLosses:avoided.length,laterApproved:rows.filter(r=>r.approvedPositionId).length,unresolved:rows.filter(r=>r.unknownOutcome).length,noFill:rows.filter(r=>r.status==='skipped').length,pending:rows.filter(r=>r.status==='pending-entry').length,open:rows.filter(r=>r.status==='open').length,missedProfit:Math.round(missed.reduce((n,r)=>n+r.netPnl,0)*100)/100,avoidedLoss:Math.round(avoided.reduce((n,r)=>n-r.netPnl,0)*100)/100,wait:summarizeOverview(entered.filter(r=>r.action==='wait'),now),skip:summarizeOverview(entered.filter(r=>r.action==='skip'),now)}};
 }finally{db.close();}
}
