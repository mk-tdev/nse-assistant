import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {validDate,at,day,FIVE} from './model.js';
import {strategyById,labStrategies,type LabStrategy} from './strategy-registry.js';
import {StrategyLabStore} from './strategy-lab-store.js';
import {firstOrbCandidate,openingSelection} from './strategy-selection.js';
import {liveCandidates,recordedDecisionsAvailable,sessionBars,sessionUniverse} from './strategy-lab-data.js';
export const backtestSchema=z.object({requestId:z.string().uuid(),from:z.string().refine(validDate),to:z.string().refine(validDate),strategyIds:z.array(z.string().refine(id=>labStrategies.some(s=>s.id===id))).min(1).max(labStrategies.length),executionMode:z.enum(['quote-replay','bar-proxy'])}).strict().refine(x=>x.from<=x.to&&Date.parse(x.to)-Date.parse(x.from)<=7*86400000&&new Set(x.strategyIds).size===x.strategyIds.length);
export const toggleSchema=z.object({requestId:z.string().uuid(),strategyId:z.string().refine(id=>labStrategies.some(s=>s.id===id)),action:z.enum(['pause','resume'])}).strict();
export async function atomicJson(file:string,value:unknown){await writeFile(file+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});await rename(file+'.tmp',file);}
export async function backtest(dir:string,store:StrategyLabStore,input:z.infer<typeof backtestSchema>,calendar:string[],now=Date.now()){
 const cfgs=input.strategyIds.map(id=>({...strategyById(id),enabled:true,...(input.executionMode==='bar-proxy'?{fillTimeoutMs:330000}:{})}));
 const runId=input.requestId;
 const existing=store.runs().find(r=>r.id===runId);if(existing?.status==='completed'||existing?.status==='blocked')return existing.body;if(existing){store.finishRun(runId,'interrupted',{reason:'Previous attempt interrupted; partial records preserved. Submit a new request ID to retry.'});throw Error('LAB_BACKTEST_PREVIOUS_ATTEMPT_INTERRUPTED');}
 if(input.to>day(now)||input.to===day(now)&&now<at(input.to,'15:35'))throw Error('LAB_BACKTEST_REQUIRES_COMPLETED_SESSION');
 store.run(runId,input.executionMode,{input,configurations:cfgs},now);
 const sessions=calendar.filter(s=>s>=input.from&&s<=input.to);if(!sessions.length||sessions.length>5)throw Error('LAB_BACKTEST_SESSION_LIMIT');
 const results:any[]=[];
 for(const session of sessions){
  const universe=await sessionUniverse(dir,session),previous=calendar.filter(d=>d<session).sort().slice(-20),warnings:string[]=[];
  if(!universe.symbols.length){results.push({session,status:'blocked',reason:'recorded_universe_unavailable',cohorts:[]});continue;}
  if(!universe.selectionEvidence.niftyPointInTimeVerified)warnings.push('Nifty membership snapshot was not verified available before this historical session; survivorship/lookahead risk');
  if(!universe.selectionEvidence.screenerPointInTimeVerified)warnings.push(universe.selectionEvidence.screenerWarning!);
  const quoteReplay=input.executionMode==='quote-replay',quotes=store.quoteHistory(session);
  if(quoteReplay&&!quotes.length){results.push({session,status:'blocked',reason:'Persisted quote observations and immutable live signal decisions are required. OHLC cannot reconstruct missing quote fills.',warnings,selectionEvidence:universe.selectionEvidence,cohorts:[]});continue;}
  const {current,history}=sessionBars(dir,session,universe.symbols,previous),selection=openingSelection(session,universe.symbols,current,history,previous,cfgs[0]!.selection,at(session,'09:31'));store.selection(runId,session,selection);
  const modeledCandidates=universe.symbols.map(symbol=>firstOrbCandidate(symbol,session,current.get(symbol)??[],history.get(symbol)??[],previous)).filter((v):v is NonNullable<typeof v>=>Boolean(v)).sort((a,b)=>a.decidedAt-b.decidedAt||a.symbol.localeCompare(b.symbol));
  const candidates=quoteReplay?liveCandidates(dir,session):modeledCandidates;
  if(quoteReplay&&(!quotes.length||!candidates.length&&!recordedDecisionsAvailable(dir,session))){results.push({session,status:'blocked',reason:'Persisted quote observations and immutable live signal decisions are required. OHLC cannot reconstruct missing quote fills.',signalCount:candidates.length,warnings,selectionEvidence:universe.selectionEvidence,selection,cohorts:[]});continue;}
  if(!quoteReplay)warnings.push('Exploratory OHLC proxy, not a quote backtest: modeled signal availability at candle end+10s; entry at a strictly later future candle open, maximum wait 330s instead of the live 60s. Stops/targets modeled stop-first; costs/slippage estimated. Final historical bars may include revisions. Results cannot validate live quote execution.');
  let ci=0;
  const admit=(time:number)=>{while(ci<candidates.length&&candidates[ci]!.decidedAt<=time){const c=candidates[ci++]!;for(const cfg of cfgs)store.consider(runId,cfg,c,selection,universe.screeners,c.decidedAt,input.executionMode,universe.nifty);}};
  if(quoteReplay){for(const q of quotes){const time=Date.parse(q.observedAt);admit(time);store.applyQuotes(runId,[q],time,q.symbol);}admit(at(session,'15:35'));store.applyQuotes(runId,[],at(session,'15:35'));}
  else{const byTime=new Map<number,{symbol:string;bar:any}[]>();for(const [symbol,bars] of current)for(const bar of bars){if(!byTime.has(bar.start))byTime.set(bar.start,[]);byTime.get(bar.start)!.push({symbol,bar});}
   for(const [time,bars] of [...byTime].sort((a,b)=>a[0]-b[0])){admit(time);for(const {symbol,bar} of bars.sort((a,b)=>a.symbol.localeCompare(b.symbol)))store.barProxy(runId,symbol,bar);await new Promise<void>(r=>setImmediate(r));}
   admit(at(session,'15:35'));store.applyQuotes(runId,[],at(session,'15:35'));
  }
  const cohorts=store.snapshot(runId,cfgs,session);
  results.push({session,status:'completed',dataQuality:{storedBars:[...current.values()].reduce((n,b)=>n+b.length,0),expectedBars:universe.symbols.length*75,stocks:universe.symbols.length},quoteCoverage:quoteReplay?{observations:quotes.length,first:quotes[0]?.observedAt,last:quotes.at(-1)?.observedAt}:null,warnings,signalCount:candidates.length,selectionEvidence:universe.selectionEvidence,selection,cohorts});
 }
 const result={id:runId,input,createdAt:new Date(now).toISOString(),simulatedOnly:true,historicalSimulation:true,executionMode:input.executionMode,configuration:cfgs,results,policy:'Independent strategy accounts. Never sum overlapping cohorts. No historical quote fabrication. Fixed quantity defaults to 10 shares. Gross, charges, slippage, net and unknown paths remain separate. The extension threshold and selection rules were developed after observing 22 October; replay of that date is in-sample exploration, not validation.'};
 const status=results.every(r=>r.status==='blocked')?'blocked':'completed';store.finishRun(runId,status,result);await atomicJson(join(store.dir,'run-'+runId+'.json'),result);return result;
}
