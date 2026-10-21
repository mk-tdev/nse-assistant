import {join} from 'node:path';
import {PaperLedger,type PaperConfig} from './paper.js';
import {PaperSessionWorker} from './paper-worker.js';
import {SessionRecorder,type CandleStore,type SessionReport} from './recorder.js';
import type {Instrument} from './model.js';
import type {Provider} from './dhan.js';
import {scanUniverse} from './scanner.js';
import {RecoveryAgent} from './recovery.js';
import {Reviewer} from './reviewer.js';
import type {Watchlists} from './watchlists.js';
export class ResearchCoordinator{
 readonly cohorts:{name:string;ledger:PaperLedger;worker:PaperSessionWorker;instruments:Instrument[]}[]=[];
 readonly recovery:RecoveryAgent;readonly reviewer:Reviewer;
 constructor(readonly store:CandleStore,readonly provider:Provider,readonly all:Instrument[],extras:Instrument[],readonly date:string,readonly mode:'live'|'mock',config:PaperConfig,readonly dir:string,readonly watchlists:Watchlists|null,readonly watchlistError:string|null,readonly clock=Date.now){
  if(config.mode!=='approximate-research')throw Error('RESEARCH_REQUIRES_EXPLICIT_APPROXIMATE_MODE');
  for(const [name,variant,instruments] of [['screener-orb',undefined,extras],['range-hold','range-hold',all],['range-failure-exit','range-failure-exit',all],['agent-recovery','agent-recovery',all]] as const){
   const cfg={...config,...(variant?{variant}: {})};const ledger=new PaperLedger(join(dir,`paper-${name}.sqlite`),cfg);const recorder=new SessionRecorder(store,provider,[...instruments],date,mode);
   this.cohorts.push({name,ledger,worker:new PaperSessionWorker(recorder,ledger,clock,0),instruments:[...instruments]});
  }
  this.recovery=new RecoveryAgent(join(dir,'research.sqlite'),store,provider,all,date,this.cohorts.find(c=>c.name==='agent-recovery')!.ledger,clock);
  this.reviewer=new Reviewer(this.recovery.db,date,(c,d)=>{this.recovery.apply(c,d.action,this.clock());},clock);
 }
 async poll(report:SessionReport){
  const errors:string[]=[];try{await this.recovery.recover(report);}catch{errors.push('recovery_failed');}
  this.recovery.ingest();
  for(const cohort of this.cohorts){try{cohort.worker.ingest(this.clock());
   for(const s of cohort.ledger.list().filter(s=>s.status==='open'||s.status==='pending-entry'))cohort.ledger.tickExisting(s.id,this.clock());
   for(const i of cohort.instruments)cohort.ledger.tick(i.symbol,this.date,this.clock());
  }catch{errors.push('cohort_evaluation_failed/'+cohort.name);}}
  try{this.reviewer.submit(this.recovery.cases(report));}catch{errors.push('review_submission_failed');}
  return this.snapshot(report,errors);
 }
 snapshot(report:SessionReport,errors:string[]=[]){
  return {simulatedOnly:true,baseline:'Nifty50 orb-long-v1 entry rules; raw observations and shared configured planned exit',observedAt:new Date(this.clock()).toISOString(),watchlists:this.watchlists,watchlistError:this.watchlistError,selection:'Independent comparison ledgers; do not sum cohorts as one portfolio',cohorts:this.cohorts.map(c=>({name:c.name,symbols:c.instruments.map(i=>i.symbol),...c.ledger.snapshot(this.date,true),scanner:{...scanUniverse(c.worker.recorder,c.ledger,report,this.clock()),universe:c.name}})),recovery:this.recovery.snapshot(),reviewer:this.reviewer.snapshot(),errors};
 }
 async close(){await this.reviewer.close();for(const c of this.cohorts)c.ledger.close();this.recovery.close();}
}
