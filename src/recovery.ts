import {DatabaseSync} from 'node:sqlite';
import {hash} from './watchlists.js';
import {FIVE,validCandle,type Batch,type Candle,type Instrument} from './model.js';
import type {Provider} from './dhan.js';
import {safeRecorderError,type CandleStore,type SessionReport} from './recorder.js';
import type {PaperLedger} from './paper.js';
export function aggregateMinutes(batch:Batch,start:number,now:number):Candle|null{
 const bars=batch.candles.filter(c=>c.start>=start&&c.start<start+FIVE).sort((a,b)=>a.start-b.start);
 if(start%FIVE||start+FIVE>now||batch.fetchedAt>now||bars.length!==5||bars.some((c,i)=>c.start!==start+i*60_000||!validCandle({...c,start})||c.volume===null))return null;
 return {start,open:bars[0]!.open,high:Math.max(...bars.map(c=>c.high)),low:Math.min(...bars.map(c=>c.low)),close:bars[4]!.close,volume:bars.reduce((v,c)=>v+c.volume!,0)};
}
export type RecoveryCase={id:string;symbol:string;gapStart:number;actionOptions:('wait_recovery'|'block_new_entries'|'protective_paper_exit'|'continue_monitoring')[];evidence:{id:string;kind:string;body:unknown}[];positionId:string|null;mark:{price:number;sourceTime:number;observedAt:number}|null};
export class RecoveryAgent{
 readonly db:DatabaseSync;
 constructor(path:string,readonly store:CandleStore,readonly provider:Provider,readonly instruments:Instrument[],readonly date:string,readonly ledger:PaperLedger,readonly clock=Date.now){
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA temp_store=MEMORY;
   CREATE TABLE IF NOT EXISTS recoveries(session TEXT,symbol TEXT,start INTEGER,attempts INTEGER,attempted_at INTEGER,status TEXT,body TEXT,error TEXT,PRIMARY KEY(session,symbol,start));
   CREATE TABLE IF NOT EXISTS recovery_decisions(id TEXT PRIMARY KEY,session TEXT,observed_at INTEGER,body TEXT);`);
 }
 close(){this.db.close();}
 async recover(report:SessionReport,maxRequests=2){
  let requests=0;const now=this.clock();const openSymbols=new Set(this.ledger.list().filter(s=>s.status==='open').map(s=>s.symbol));
  const gaps=report.instruments.flatMap(i=>i.missingSlots.map(slot=>({symbol:i.symbol,start:Date.parse(slot)}))).sort((a,b)=>Number(openSymbols.has(b.symbol))-Number(openSymbols.has(a.symbol))||b.start-a.start||a.symbol.localeCompare(b.symbol));
  for(const gap of gaps){if(requests>=maxRequests)break;if(gap.start+FIVE+15000>now)continue;
   const row=this.db.prepare('SELECT * FROM recoveries WHERE session=? AND symbol=? AND start=?').get(this.date,gap.symbol,gap.start);if(row?.status==='recovered'||Number(row?.attempts??0)>=2||Number(row?.attempted_at??0)+15000>now)continue;
   const instrument=this.instruments.find(i=>i.symbol===gap.symbol);if(!instrument)continue;const attempt=Number(row?.attempts??0)+1;
   this.db.prepare(`INSERT INTO recoveries VALUES(?,?,?,?,?,'pending',NULL,NULL) ON CONFLICT(session,symbol,start) DO UPDATE SET attempts=excluded.attempts,attempted_at=excluded.attempted_at,status='pending'`).run(this.date,gap.symbol,gap.start,attempt,now);requests++;
   let candle:Candle|null=null,source='',error:string|null=null,fetchedAt=now;
   try{const from=new Date(gap.start-1000).toISOString(),to=new Date(gap.start+FIVE).toISOString();let batch:Batch;
    if(attempt===1){batch=await this.provider.candles(instrument.securityId,from,to);candle=batch.candles.find(c=>c.start===gap.start)??null;if(candle&&(!validCandle(candle)||candle.volume===null))candle=null;source='five-minute REST retry';}
    else{if(!this.provider.minuteCandles)throw Error('RECORDER_MINUTE_RECOVERY_UNAVAILABLE');batch=await this.provider.minuteCandles(instrument.securityId,from,to);candle=aggregateMinutes(batch,gap.start,this.clock());source='aggregation of five complete one-minute REST candles';}
    fetchedAt=batch.fetchedAt;if(fetchedAt>this.clock()||fetchedAt<gap.start+FIVE)candle=null;
    if(!candle)error='RECORDER_RECOVERY_INCOMPLETE';
   }catch(e){error=safeRecorderError(e);}
   const body=candle?{candle,observedAt:fetchedAt,sourceTime:candle.start+FIVE,source:'Dhan REST v2; '+source+'; provisional start labels',issues:[]}:null;
   this.db.prepare('UPDATE recoveries SET status=?,body=?,error=? WHERE session=? AND symbol=? AND start=?').run(body?'recovered':'unresolved',body?JSON.stringify(body):null,error,this.date,gap.symbol,gap.start);
   if(!body&&attempt===1&&requests<maxRequests&&this.provider.minuteCandles){
    requests++;this.db.prepare("UPDATE recoveries SET attempts=2,attempted_at=?,status='pending' WHERE session=? AND symbol=? AND start=?").run(this.clock(),this.date,gap.symbol,gap.start);
    let rebuilt:Candle|null=null,minuteError:string|null=null,minuteTime=this.clock();
    try{const batch=await this.provider.minuteCandles(instrument.securityId,new Date(gap.start-1000).toISOString(),new Date(gap.start+FIVE).toISOString());minuteTime=batch.fetchedAt;rebuilt=aggregateMinutes(batch,gap.start,this.clock());if(!rebuilt)minuteError='RECORDER_RECOVERY_INCOMPLETE';}catch(e){minuteError=safeRecorderError(e);}
    const recovered=rebuilt?{candle:rebuilt,observedAt:minuteTime,sourceTime:rebuilt.start+FIVE,source:'Dhan REST v2; aggregation of five complete one-minute REST candles; provisional start labels',issues:[]}:null;
    this.db.prepare('UPDATE recoveries SET status=?,body=?,error=? WHERE session=? AND symbol=? AND start=?').run(recovered?'recovered':'unresolved',recovered?JSON.stringify(recovered):null,minuteError,this.date,gap.symbol,gap.start);
   }

  }
  return {requestsThisPoll:requests,maxRequestsPerPoll:maxRequests,records:this.records()};
 }
 records(){return this.db.prepare('SELECT symbol,start,attempts,attempted_at,status,body,error FROM recoveries WHERE session=? ORDER BY start,symbol').all(this.date);}
 ingest(){for(const row of this.records())if(row.status==='recovered'&&row.body)this.ledger.observe(String(row.symbol),JSON.parse(String(row.body)));}
 cases(report:SessionReport):RecoveryCase[]{
  const now=this.clock(),states=this.ledger.list(),cases:RecoveryCase[]=[];
  for(const instrument of report.instruments){
   const gaps=instrument.missingSlots.map(Date.parse).filter(start=>start+FIVE+60_000<now);if(!gaps.length)continue;
   const gapStart=gaps.find(start=>this.db.prepare('SELECT status FROM recoveries WHERE session=? AND symbol=? AND start=?').get(this.date,instrument.symbol,start)?.status!=='recovered');if(gapStart===undefined)continue;
   const position=states.find(s=>s.symbol===instrument.symbol&&s.session===this.date&&s.status==='open');
   const latest=this.store.candles(this.date,instrument.securityId).filter(c=>validCandle(c)&&c.start+FIVE<=now).at(-1);
   const observed=latest?this.store.db.prepare('SELECT last_observed_at FROM candles WHERE session=? AND security_id=? AND source_epoch_ms=?').get(this.date,instrument.securityId,latest.start):null;
   const mark=latest&&latest.start>gapStart&&now-(latest.start+FIVE)<=60_000&&Number(observed?.last_observed_at)<=now?{price:latest.close,sourceTime:latest.start+FIVE,observedAt:Number(observed!.last_observed_at)}:null;
   const actionOptions:RecoveryCase['actionOptions']=position?(mark?['wait_recovery','protective_paper_exit','continue_monitoring']:['wait_recovery','continue_monitoring']):['wait_recovery','block_new_entries'];
   const evidence=[{id:'gap',kind:'missing_candle',body:{start:gapStart,ageMs:now-gapStart-FIVE,recovery:this.records().find(r=>r.symbol===instrument.symbol&&Number(r.start)===gapStart)??null}},{id:'latest',kind:'observed_completed_close',body:mark},{id:'position',kind:'simulated_position',body:position?{id:position.id,entry:position.entry,stop:position.stop,target:position.target,unknownOutcome:position.unknownOutcome}:null}];
   const c:RecoveryCase={id:hash({session:this.date,symbol:instrument.symbol,gapStart,markSourceTime:mark?.sourceTime??null,position:position?.id??null}),symbol:instrument.symbol,gapStart,actionOptions,evidence,positionId:position?.id??null,mark};cases.push(c);
   const decision={caseId:c.id,symbol:c.symbol,action:position?'continue_monitoring':'block_new_entries',reason:position?'Manage existing risk; missing historical path remains unresolved. Await recovery or fresh evidence for a separately marked protective paper action.':'Required candle is absent; do not infer a new entry.',evidence,simulatedOnly:true};
   this.db.prepare('INSERT OR IGNORE INTO recovery_decisions VALUES(?,?,?,?)').run(c.id,this.date,now,JSON.stringify(decision));
  }
  return cases.sort((a,b)=>Number(Boolean(b.positionId))-Number(Boolean(a.positionId)));
 }
 apply(c:RecoveryCase,action:string,now=this.clock()){
  if(!c.actionOptions.includes(action as never))return false;
  if(action==='protective_paper_exit'&&c.positionId&&c.mark){if(now-c.mark.sourceTime>60_000||c.mark.observedAt>now){this.db.prepare('INSERT OR IGNORE INTO recovery_decisions VALUES(?,?,?,?)').run(c.id+'/rejected',this.date,now,JSON.stringify({caseId:c.id,action,applied:false,reason:'evidence_became_stale_while_review_pending'}));return false;}const applied=this.ledger.protectiveExit(c.positionId,{...c.mark,reason:'LLM-reviewed missing-path protective paper action'},now);if(applied)this.db.prepare('INSERT OR IGNORE INTO recovery_decisions VALUES(?,?,?,?)').run(c.id+'/protective',this.date,now,JSON.stringify({caseId:c.id,action,mark:c.mark,unknownOutcome:true,grossPnl:null}));return applied;}
  return false;
 }
 snapshot(){return {policy:'evidence-policy-v1',simulatedOnly:true,baselineModified:false,recoveries:this.records(),decisions:this.db.prepare('SELECT observed_at,body FROM recovery_decisions WHERE session=? ORDER BY observed_at DESC LIMIT 100').all(this.date)};}
}
