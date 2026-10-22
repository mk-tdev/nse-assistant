import {readFile,writeFile,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ControlStore,cohortFiles,exitSchema,entrySchema} from './paper-control-store.js';
import {PaperLedger,type PaperConfig} from './paper.js';
import {loadPaperConfig} from './paper-worker.js';
import {freshQuote,type QuoteRow} from './paper-valuation.js';
import {day,at} from './model.js';
import type {CommodityContract} from './commodities.js';
export function storedStates(dir:string,file:string,session?:string){
 if(!existsSync(join(dir,file)))return [];
 const db=new DatabaseSync(join(dir,file),{readOnly:true});try{db.exec('PRAGMA busy_timeout=1500;');return db.prepare('SELECT body FROM paper_states').all().map(r=>JSON.parse(String(r.body))).filter(s=>!session||s.session===session);}finally{db.close();}
}
export function exitTargets(dir:string,store:ControlStore,input:ReturnType<typeof exitSchema.parse>){
 const targets:{cohort:string;id:string;symbol:string}[]=[];
 for(const [cohort,file] of Object.entries(cohortFiles))if(input.scope==='all'||input.cohort===cohort)for(const s of storedStates(dir,file,input.session))if(['open','pending-entry'].includes(s.status)&&(input.scope!=='position'||input.positionId===s.id))targets.push({cohort,id:s.id,symbol:s.symbol});
 if(input.scope==='all'||input.cohort==='mcx-manual')for(const s of store.positions())if(s.status==='open'&&(input.scope!=='position'||input.positionId===s.id))targets.push({cohort:'mcx-manual',id:s.id,symbol:s.symbol});
 return targets;
}
export async function processCommands(dir:string,store:ControlStore,config:PaperConfig,now=Date.now()){
 let quoteFile:{rows:QuoteRow[];sessionDate:string}={rows:[],sessionDate:day(now)},contracts:CommodityContract[]=[];
 try{quoteFile=JSON.parse(await readFile(join(dir,'quotes.json'),'utf8'));}catch{}
 try{contracts=JSON.parse(await readFile(join(dir,'commodities.json'),'utf8')).contracts??[];}catch{}
 for(const row of store.pending()){
  const id=String(row.id),created=Number(row.created_at),body=JSON.parse(String(row.body));
  if(now-created>90000){store.finish(id,{status:'expired',reason:'No eligible post-request quote arrived within 90 seconds',results:row.result?JSON.parse(String(row.result)).results??[]:[]});continue;}
  if(row.kind==='entry'){
   const input=entrySchema.parse(body),c=contracts.find(c=>c.securityId===input.contractId);
   const prior=store.positions().find(s=>s.id===id);if(prior){store.finish(id,{status:'completed',positionId:id});continue;}
   if(!c||c.expiry<=new Date(Date.parse(day(now))+7*86400000).toISOString().slice(0,10)){store.finish(id,{status:'rejected',reason:'Contract unavailable or inside seven-day expiry buffer'});continue;}
   const mark=freshQuote(quoteFile.rows.find(q=>q.securityId===c.securityId&&q.exchangeSegment==='MCX_COMM'),now,created);if(!mark)continue;
   const position={id,symbol:c.symbol,session:day(now),strategy:'mcx-manual',mode:'approximate-research',status:'open',reasons:['user_manual_paper_entry'],signal:null,entryAt:mark.observedAt,entry:mark.price,stop:null,target:null,exit:null,exitAt:null,exitReason:null,grossPnl:null,netPnl:null,unknownOutcome:false,quantity:input.lots,lots:input.lots,multiplier:c.multiplier,side:input.side,assetClass:'MCX_FUTURE',contract:c,updatedAt:now,mark};
   store.db.exec('BEGIN IMMEDIATE');try{store.db.prepare('INSERT OR IGNORE INTO manual_positions VALUES(?,?)').run(id,JSON.stringify(position));store.db.prepare('INSERT OR IGNORE INTO manual_events VALUES(?,?,?)').run(id+'/open',now,JSON.stringify(position));store.db.prepare("UPDATE commands SET status='completed',result=? WHERE id=?").run(JSON.stringify({status:'completed',positionId:id}),id);store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}continue;
  }
  const completed:Record<string,unknown>[]=row.result?JSON.parse(String(row.result)).results??[]:[],done=new Set(completed.map(r=>r.positionId));
  for(const target of body.targets as {cohort:string;id:string;symbol:string}[]){
   if(done.has(target.id))continue;
   const quote=quoteFile.rows.find(q=>q.symbol===target.symbol),mark=freshQuote(quote,now,created);
   if(target.cohort==='mcx-manual'){
    const s=store.positions().find(s=>s.id===target.id);if(!s||s.status==='closed'){completed.push({positionId:target.id,status:'already_closed'});continue;}if(!mark)continue;
    store.db.exec('BEGIN IMMEDIATE');try{const current=store.db.prepare('SELECT body FROM manual_positions WHERE id=?').get(s.id);const v=JSON.parse(String(current!.body));if(v.status==='open'){Object.assign(v,{status:'closed',exit:mark.price,exitAt:mark.observedAt,exitReason:'manual_observed_quote',updatedAt:now,grossPnl:(mark.price-v.entry)*v.quantity*v.multiplier*(v.side==='short'?-1:1),exitMark:mark});store.db.prepare('UPDATE manual_positions SET body=? WHERE id=?').run(JSON.stringify(v),s.id);store.db.prepare('INSERT OR IGNORE INTO manual_events VALUES(?,?,?)').run(id+'/'+s.id,now,JSON.stringify(v));}store.db.exec('COMMIT');completed.push({positionId:s.id,status:'closed',exit:v.exit});}catch(e){store.db.exec('ROLLBACK');throw e;}
   }else{
    const file=cohortFiles[target.cohort as keyof typeof cohortFiles];if(!file)continue;
    const state=storedStates(dir,file).find(s=>s.id===target.id);if(!state||state.status==='closed'){completed.push({positionId:target.id,status:'already_closed'});continue;}if(state.status==='open'&&!mark)continue;
    const variant=['range-hold','range-failure-exit','agent-recovery'].includes(target.cohort)?target.cohort as 'range-hold'|'range-failure-exit'|'agent-recovery':undefined;
    const ledger=new PaperLedger(join(dir,file),{...config,...(variant?{variant}:{})});
    try{completed.push(ledger.manualExit(target.id,mark,id,now));}catch(e){completed.push({positionId:target.id,status:'rejected',reason:e instanceof Error&&/^PAPER_[A-Z_]+$/.test(e.message)?e.message:'PAPER_EXIT_FAILED'});}finally{ledger.close();}
   }
  }
  // Store partial completion after every batch. A crash/retry cannot invent a second exit.
  store.db.prepare('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify({status:'pending',results:completed}),id);
  if(completed.length>=body.targets.length)store.finish(id,{status:'completed',results:completed});
 }
}
export async function consoleLoop(){const dir=process.env.RECORDER_DATA_DIR??'/data',controlDir=process.env.PAPER_CONTROL_DIR??'/controls',store=new ControlStore(controlDir),config=await loadPaperConfig();if(!config)throw Error('PAPER_DISABLED');let stopping=false;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});try{while(!stopping){try{await writeFile(join(controlDir,'health.json.tmp'),JSON.stringify({observedAt:new Date().toISOString(),paperOnly:true}));await rename(join(controlDir,'health.json.tmp'),join(controlDir,'health.json'));await processCommands(dir,store,config);}catch{console.error('PAPER_CONTROL_CYCLE_FAILED');}await new Promise(r=>setTimeout(r,1000));}}finally{store.close();}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)consoleLoop().catch(()=>{console.error('PAPER_CONSOLE_FAILED');process.exitCode=1;});
