import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {StrategyLabStore} from './strategy-lab-store.js';
import {middayDecisions} from './midday-signals.js';
import {labStrategies} from './strategy-registry.js';
import {liveCandidates,sessionBars,sessionUniverse} from './strategy-lab-data.js';
import {openingSelection} from './strategy-selection.js';
import {backtest,backtestSchema,toggleSchema,atomicJson} from './strategy-backtest.js';
import {ControlStore} from './paper-control-store.js';
import {at,day} from './model.js';
import type {QuoteRow} from './paper-valuation.js';
async function liveCohorts(dir:string,store:StrategyLabStore,runId:string,definitions:typeof labStrategies,universe:Awaited<ReturnType<typeof sessionUniverse>>,session:string,selection:ReturnType<StrategyLabStore['selection']>){
 let sourceRows:any[]=[];try{const r=JSON.parse(await readFile(join(dir,session+'.json'),'utf8'));sourceRows=r.paper?.research?.cohorts?.find((c:any)=>c.name==='range-hold')?.scanner?.rows??r.paper?.scanner?.rows??[];}catch{}
 return store.snapshot(runId,definitions).map(c=>{const scope=c.configuration.universe,members=scope==='nifty50'?universe.nifty:scope==='screeners'?universe.screeners:universe.symbols;
 return {...c,scanner:{...c.scanner,universe:scope,expectedStocks:members.length,metricPolicy:'Rows show the scoped universe; immutable signal records alone authorize new candidates.',rows:members.map(symbol=>{const src=sourceRows.find(r=>r.symbol===symbol)??{},p=c.states.find(p=>p.symbol===symbol),rank=selection?.find(r=>r.symbol===symbol);return {...src,symbol,status:p?.status??(scope==='stocks-in-play'&&rank&&!rank.eligible?'not-selected':'waiting-signal'),reasons:p?.reasons??[scope==='stocks-in-play'&&rank&&!rank.eligible?rank.reason:c.configuration.setup?'awaiting_immutable_'+c.configuration.setup+'_candidate':'awaiting_first_immutable_ORB_candidate'],entry:p?.entry??null,stop:p?.stop??null,target:p?.target??null,quantity:p?.quantity??(c.configuration.sizing==='fixed-10'?10:null),unknownOutcome:p?.unknownOutcome??false};})}};});
}
export async function labCycle(dir:string,store:StrategyLabStore,calendar:string[],now=Date.now()){
 const session=day(now),during=calendar.includes(session)&&now>=at(session,'09:05')&&now<at(session,'15:35');
 let quotes:{sessionDate:string;rows:QuoteRow[]}={sessionDate:session,rows:[]};try{quotes=JSON.parse(await readFile(join(dir,'quotes.json'),'utf8'));}catch{}
 if(during&&quotes.sessionDate===session)store.journal(session,quotes.rows);
 if(during){const runId='live/'+session;store.run(runId,'live',{session,configurations:labStrategies},now);const definitions=(store.runs().find(r=>r.id===runId)?.body.configurations??labStrategies) as typeof labStrategies;const universe=await sessionUniverse(dir,session);let selection=store.selection(runId,session);
  if(!selection&&now>=at(session,'09:31')&&universe.symbols.length){const previous=calendar.filter(d=>d<session).sort().slice(-20),bars=sessionBars(dir,session,universe.symbols,previous,at(session,'09:31'));selection=store.selection(runId,session,openingSelection(session,universe.symbols,bars.current,bars.history,previous,labStrategies[0]!.selection,at(session,'09:31')));}
  for(const cfg of definitions)if(store.enabled(cfg)){const candidates=cfg.signalWindow?middayDecisions(dir,store,cfg,session,universe.symbols,calendar,now):liveCandidates(dir,session);for(const c of candidates)store.consider(runId,{...cfg,enabled:true},c,selection,universe.screeners,now,'observed-quote',universe.nifty);}
  // Pausing affects future entries. Already open positions keep stop/target/time management.
  store.applyQuotes(runId,quotes.sessionDate===session?quotes.rows:[],now);
  await atomicJson(join(store.dir,'live-'+session+'.json'),{session,observedAt:new Date(now).toISOString(),selectionEvidence:universe.selectionEvidence,selection,cohorts:await liveCohorts(dir,store,runId,definitions,universe,session,selection),policy:'Sampled quote-based paper execution with explicit costs. Missing quote coverage >30 seconds makes the historical path unknown. No broker orders.'});
 }
 // Manage old sessions after a restart; a missed close is unknown, never a made-up exit.
 for(const run of store.runs().filter(r=>String(r.id).startsWith('live/'))){const old=String(run.id).slice(5);if(now>=at(old,'15:35')&&(run.status==='running'||store.positions(String(run.id)).some(p=>p.status==='open'||p.status==='pending-entry'))){store.applyQuotes(String(run.id),[],now);let prior:any={};try{prior=JSON.parse(await readFile(join(store.dir,'live-'+old+'.json'),'utf8'));}catch{}const definitions=run.body.configurations??labStrategies;const cohorts=store.snapshot(String(run.id),definitions);store.finishRun(String(run.id),'completed',{...run.body,endedAt:new Date(now).toISOString(),unknownOutcomes:cohorts.reduce((n,c)=>n+c.summary.unknown,0)});await atomicJson(join(store.dir,'live-'+old+'.json'),{...prior,session:old,observedAt:new Date(now).toISOString(),cohorts,policy:'Final/restart reconciliation; missing exits remain unknown.'});}}

 return {session,during};
}
export async function strategyLabLoop(env:NodeJS.ProcessEnv=process.env){const dir=env.RECORDER_DATA_DIR??'/data',labDir=env.STRATEGY_LAB_DIR??'/lab',controls=env.PAPER_CONTROL_DIR??'/controls',store=new StrategyLabStore(labDir),queue=new ControlStore(controls),calendar=JSON.parse(await readFile(env.PAPER_CALENDAR_PATH??new URL('../deploy/lightsail/calendar-paper-2026.json',import.meta.url),'utf8')).sessions as string[];
 let stopping=false,lastWrite=0;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
 try{while(!stopping){const now=Date.now();try{
  const {during}=await labCycle(dir,store,calendar,now);
  for(const row of queue.pending(['lab-toggle','lab-backtest'])){
   if(row.kind==='lab-toggle'){const input=toggleSchema.parse(JSON.parse(String(row.body)));store.toggle(input.strategyId,input.action==='resume');queue.finish(String(row.id),{status:'completed',strategyId:input.strategyId,enabled:input.action==='resume'});}
   if(row.kind==='lab-backtest'&&!during){const input=backtestSchema.parse(JSON.parse(String(row.body)));try{await atomicJson(join(labDir,'health.json'),{observedAt:new Date().toISOString(),paperOnly:true,status:'backtesting'});const result=await backtest(dir,store,input,calendar);queue.finish(String(row.id),{status:'completed',runId:input.requestId});}catch(e){if(store.runs().find(r=>r.id===String(row.id))?.status==='running')store.finishRun(String(row.id),'failed',{reason:e instanceof Error?e.message:'LAB_BACKTEST_FAILED'});queue.finish(String(row.id),{status:'failed',reason:e instanceof Error&&/^LAB_[A-Z_]+$/.test(e.message)?e.message:'LAB_BACKTEST_DATA_OR_EXECUTION_ERROR'});}}
  }
  if(now-lastWrite>=5000){await atomicJson(join(labDir,'registry.json'),{observedAt:new Date().toISOString(),strategies:labStrategies.map(s=>({...s,enabled:store.enabled(s)})),paperOnly:true,policy:'Morning and midday are independent fixed-10-share trials. Midday activation follows historical comparison; equal-risk is optional. Independent strategy ledgers/accounts; baseline records unchanged.'});const pending=queue.pending(['lab-backtest']).map(r=>({id:String(r.id),created_at:Number(r.created_at),mode:JSON.parse(String(r.body)).executionMode,status:'queued',body:{input:JSON.parse(String(r.body))}})),ids=new Set(pending.map(r=>r.id));await atomicJson(join(labDir,'runs.json'),{runs:[...pending,...store.runs().filter(r=>!ids.has(r.id))]});lastWrite=now;}
  await atomicJson(join(labDir,'health.json'),{observedAt:new Date().toISOString(),paperOnly:true});
 }catch{console.error('STRATEGY_LAB_CYCLE_FAILED');}await new Promise(r=>setTimeout(r,1000));}}
 finally{queue.close();store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)strategyLabLoop().catch(()=>{console.error('STRATEGY_LAB_FAILED');process.exitCode=1;});
