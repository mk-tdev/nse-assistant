import {initializeShadows,updateShadows} from './agent-shadow.js';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AgentStore} from './agent-store.js';
import {fetchNews,type NewsItem} from './agent-news.js';
import {requestAgentOpinion} from './agent-review.js';
import {StrategyLabStore,type LabPosition} from './strategy-lab-store.js';
import {labStrategies,type LabStrategy} from './strategy-registry.js';
import {liveCandidates,sessionUniverse} from './strategy-lab-data.js';
import {estimateCosts,freshQuote,type QuoteRow} from './paper-valuation.js';
import {at,day} from './model.js';
import type {Candidate} from './strategy-selection.js';
export const agentConfig:LabStrategy={...labStrategies[1]!,id:'agent-approved-10-v1',name:'Agent-approved paper / 10 shares',enabled:true,universe:'all',quantity:10,maxOpenPositions:10,maxExtension:1,signalWindow:{start:'09:30',end:'14:30'}};
const atomic=async(path:string,body:unknown)=>{await writeFile(path+'.tmp',JSON.stringify(body)+'\n',{mode:0o600});await rename(path+'.tmp',path);};
export function manageAgentPositions(store:StrategyLabStore,session:string,quotes:QuoteRow[],now:number){
 const run='live/'+session;
 // One prospective fill at a time: limits count actual entries, not approvals, across all signals.
 for(const p of store.positions(run).filter(p=>p.status==='open'))store.applyQuotes(run,quotes,now,p.symbol);
 for(const p of store.positions(run).filter(p=>p.status==='pending-entry')){
  const entered=store.positions(run).filter(s=>s.entry!==null),open=entered.filter(s=>s.status==='open');
  if(entered.length>=20||open.length>=10){p.status='skipped';p.reasons=[entered.length>=20?'agent_daily_20_entry_limit':'agent_10_open_limit'];p.updatedAt=now;store.save(p);store.event(p,'portfolio-limit','entry_rejected',{reason:p.reasons[0]},now);continue;}
  store.applyQuotes(run,quotes,now,p.symbol);
 }
}
export function marketEvidence(rows:any[],nifty:string[],now:number,companies:Record<string,{name:string;industry:string}>={}){
 const eligible=rows.filter(q=>nifty.includes(q.symbol)&&freshQuote(q,now)&&Number.isFinite(q.changePercent));const changes=eligible.map(q=>q.changePercent).sort((a,b)=>a-b);const industries=[...new Set(eligible.map(q=>companies[q.symbol]?.industry).filter(Boolean))].map(industry=>{const sector=eligible.filter(q=>companies[q.symbol]?.industry===industry);return {industry,covered:sector.length,averageChangePct:sector.reduce((n,q)=>n+q.changePercent,0)/sector.length};});return {id:'market',observedAt:new Date(now).toISOString(),covered:eligible.length,expected:nifty.length,sectors:industries,advancers:changes.filter(n=>n>0).length,decliners:changes.filter(n=>n<0).length,medianChangePct:changes.length?changes[Math.floor(changes.length/2)]:null,ready:eligible.length>=Math.max(20,Math.ceil(nifty.length*.6)),policy:'Current watched Nifty constituents breadth and median change from prior close; a universe proxy, not the official Nifty index or global index prices.'};
}
function candidatesFrom(dir:string,labDir:string,session:string,now:number){
 const bySymbol=new Map<string,Candidate>();for(const c of liveCandidates(dir,session))if(c.decidedAt<=now)bySymbol.set(c.symbol,c);
 const file=join(labDir,'strategy-lab.sqlite');if(existsSync(file)){const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500;');for(const r of db.prepare("SELECT body FROM lab_positions WHERE run_id=?").all('live/'+session)){const p=JSON.parse(String(r.body));const c=p.candidate;if(c&&c.decidedAt<=now&&(!bySymbol.has(c.symbol)||bySymbol.get(c.symbol)!.decidedAt<c.decidedAt))bySymbol.set(c.symbol,{...c,setupEvidence:{setup:p.config?.setup??'ORB',originStrategy:p.strategy,original:c.setupEvidence??null}});}}finally{db.close();}}
 return [...bySymbol.values()].filter(c=>c.decidedAt>=now-10*60000&&c.signalStart>=at(session,'09:30')&&c.signalStart+300000<=at(session,'14:30')&&c.stop>0&&c.rangeHigh>c.stop&&c.extension<=1).sort((a,b)=>b.relativeVolume-a.relativeVolume||a.extension-b.extension);
}
export async function agentLoop(env:NodeJS.ProcessEnv=process.env,preflight=false){
 const dir=env.RECORDER_DATA_DIR??'/data',agentDir=env.AGENT_TRADING_DIR??'/agent',labDir=env.STRATEGY_LAB_DIR??'/lab';await mkdir(agentDir,{recursive:true,mode:0o700});const store=new AgentStore(agentDir,env),execution=new StrategyLabStore(agentDir),shadow=new StrategyLabStore(join(agentDir,'shadow'));initializeShadows(shadow);const calendar=JSON.parse(await readFile(new URL('../deploy/lightsail/calendar-paper-2026.json',import.meta.url),'utf8')).sessions as string[];
 const membership=JSON.parse(await readFile(new URL('../deploy/lightsail/nifty50-2026-10-21.json',import.meta.url),'utf8'));const companies=Object.fromEntries(membership.constituents.map((c:any)=>[c.symbol,{name:c.name,industry:c.industry}]));
 let stopped=false,news:any=null,newsTask:Promise<void>|null=null,reviewTask:Promise<void>|null=null,lastNews=0,lastReview=0,lastBrief=0,lastSnapshot=0,status='Starting',market:any=null;
 process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
 try{
  try{news=JSON.parse(await readFile(join(agentDir,'news.json'),'utf8'));}catch{}
  const refreshNews=async()=>{news=await fetchNews();for(const item of news.items as NewsItem[]){store.db.prepare('INSERT OR IGNORE INTO agent_news VALUES(?,?,?,?)').run(item.id,item.publishedAt,item.firstSeenAt,JSON.stringify(item));const prior=store.db.prepare('SELECT first_seen_at FROM agent_news WHERE id=?').get(item.id);item.firstSeenAt=String(prior!.first_seen_at);}await atomic(join(agentDir,'news.json'),news);};
  const review=async(session:string,candidates:Candidate[],quotes:any[],mode='live')=>{
   const now=Date.now(),items=(news?.items??[]) as NewsItem[];const picked=[...items.filter(i=>i.feed==='bbc').slice(0,5),...items.filter(i=>i.feed==='cnbc').slice(0,5),...items.filter(i=>i.kind==='company'&&candidates.some(c=>i.title.toUpperCase().includes(c.symbol.toUpperCase())||Boolean(companies[c.symbol]?.name&&i.title.toUpperCase().includes(companies[c.symbol].name.toUpperCase().replace(/ LIMITED| LTD\.?/g,''))))).slice(0,8),...items.filter(i=>i.kind==='company').slice(0,5)].filter((i,k,a)=>a.findIndex(x=>x.id===i.id)===k);
   const payload:any={mode,observedAt:new Date(now).toISOString(),paperOnly:true,portfolio:{open:execution.positions('live/'+session).filter(p=>p.status==='open').map(p=>({symbol:p.symbol,entry:p.entry,quantity:p.quantity})),dailyEntries:execution.positions('live/'+session).filter(p=>p.entry!==null).length,limits:{shares:10,maxOpen:10,maxDailyEntries:20}},market:market??{id:'market',ready:false,policy:'Preflight after hours; no current eligible equity quotes.'},news: picked.map(i=>({...i,excerpt:i.excerpt.slice(0,220)})),newsCoverage:news?.feeds,candidates:candidates.map(c=>{const q=quotes.find(q=>q.symbol===c.symbol);return {id:c.id,symbol:c.symbol,company:companies[c.symbol]?.name??null,industry:companies[c.symbol]?.industry??null,originalSignalAt:c.decidedAt,setup:c.setupEvidence??'ORB',signalClose:c.signalClose,observedPrice:q?.lastPrice,stop:c.stop,openingRangeHigh:c.rangeHigh,relativeVolume:c.relativeVolume,extension:c.extension,quantity:10,estimatedCostAtStop:q?.lastPrice?estimateCosts(q.lastPrice,c.stop,10):null,quoteObservedAt:q?.observedAt,tradeTime:q?.rawSourceTimestamp};}),evidenceIds:['market',...candidates.map(c=>c.id),...picked.map(i=>i.id)]};
   // Pre-shrink the news packet, never truncate price evidence or exceed the priced input bound.
   while(Buffer.byteLength(JSON.stringify(payload))>16000&&payload.news.length>3)payload.news.pop();payload.evidenceIds=['market',...candidates.map(c=>c.id),...payload.news.map((i:any)=>i.id)];
   const id=store.reserve(payload,session,mode,now);if(!id){status='Shared $3/day allowance exhausted; new entries blocked';return;}
   try{const result=await requestAgentOpinion(payload,env);store.complete(id,result,result.usage);store.context(session,{mode,...result.opinion,callId:id},Date.now());
    for(const opinion of [...result.opinion.decisions].sort((a,b)=>a.priority-b.priority)){
     const c=candidates.find(c=>c.id===opinion.candidateId)!;const decided=Date.now();let admission='Not approved';
     if(opinion.action==='approve'&&mode==='live'){
      if(day(decided)!==session||decided-now>60000||decided>=at(session,'14:30')||!news?.ready||decided-Date.parse(news.observedAt)>20*60000)admission='Approval expired or required news evidence unavailable';
      else if(result.opinion.marketRegime==='insufficient_data')admission='Agent market evidence insufficient';
      else{execution.consider('live/'+session,agentConfig,{...c,decidedAt:decided,source:'Agent-approved prospective paper plan',setupEvidence:{original:c,agentCallId:id,opinion,marketRegime:result.opinion.marketRegime}},null,[],decided,'observed-quote');admission='Approved; waiting for a strictly later fresh trade quote, subject to portfolio caps';}
     }
     store.db.prepare('INSERT INTO agent_decisions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,session,c.symbol,c.id,decided,JSON.stringify({...opinion,admission,approvedAt:decided,expiresAt:decided+60000,originalCandidate:c,mode}));
    }status='Review completed; awaiting fresh eligible entries';
   }catch(e){const message=e instanceof Error&&/^AGENT_[A-Z_0-9]+$/.test(e.message)?e.message:'AGENT_RESPONSE_FAILED_OR_INVALID';store.fail(id,message);status=message+'; no new entries from failed review';}
  };
  if(preflight){await refreshNews();await review(day(Date.now()),[],[],'preflight');await atomic(join(agentDir,'preflight.json'),{observedAt:new Date().toISOString(),status,newsReady:news.ready,paperOnly:true,noEntries:true,budget:store.budgetStatus()});console.log(JSON.stringify({status,newsReady:news.ready,budget:store.budgetStatus(),paperOnly:true}));return;}
  while(!stopped){try{const now=Date.now(),session=day(now),during=calendar.includes(session)&&now>=at(session,'09:30')&&now<at(session,'15:35'),canReview=during&&now<at(session,'14:30');
   if(!newsTask&&(lastNews===0||calendar.includes(session)&&now>=at(session,'08:50')&&now<at(session,'15:35')&&now-lastNews>10*60000)){lastNews=now;newsTask=refreshNews().catch(()=>{status='News refresh failed; approvals blocked when evidence expires';}).finally(()=>{newsTask=null;});}
   let quotes:any={rows:[]};try{quotes=JSON.parse(await readFile(join(dir,'quotes.json'),'utf8'));}catch{}
   const rows=quotes.sessionDate===session?quotes.rows??[]:[];
   execution.run('live/'+session,'live',{session,configurations:[agentConfig],policy:'Independent agent-approved paper portfolio'},now);
   // Manage all stored open sessions after restarts; never manufacture an exit.
   for(const run of execution.runs().filter(r=>r.id.startsWith('live/'))){const date=run.id.slice(5);if(date===session&&during){execution.journal(session,rows);manageAgentPositions(execution,session,rows,now);}else if(now>=at(date,'15:35')&&execution.positions(run.id).some(p=>['open','pending-entry'].includes(p.status)))manageAgentPositions(execution,date,[],now);}
   updateShadows(store.db,shadow,rows,now);
   if(canReview&&!reviewTask&&now-lastReview>60000){
    const u=await sessionUniverse(dir,session);market=marketEvidence(rows,u.nifty,now,companies);const entered=execution.positions('live/'+session).filter(p=>p.entry!==null);
    if(entered.length>=20)status='Daily 20-entry limit reached';else if(entered.filter(p=>p.status==='open').length>=10)status='10 open positions; no new approvals';else if(!market.ready)status='Insufficient fresh equity market breadth; waiting';else if(!news?.ready||now-Date.parse(news.observedAt)>20*60000)status='Required company/global news feeds unavailable or stale; waiting';else if(store.budgetStatus(now).exhausted)status='Shared $3/day allowance exhausted';else{
     const candidates=candidatesFrom(dir,labDir,session,now).filter(c=>!execution.positions('live/'+session).some(p=>p.symbol===c.symbol)&&freshQuote(rows.find((q:any)=>q.symbol===c.symbol),now)&&Number(store.db.prepare('SELECT COUNT(*) AS n FROM agent_decisions WHERE session=? AND candidate_id=?').get(session,c.id)!.n)<3&&!store.db.prepare('SELECT id FROM agent_decisions WHERE session=? AND candidate_id=? AND observed_at>?').get(session,c.id,now-5*60000)).slice(0,5);
     if(candidates.length){lastReview=now;status='Agent reviewing '+candidates.length+' shortlisted candidates';reviewTask=review(session,candidates,rows).finally(()=>{reviewTask=null;});}else if(now-lastBrief>15*60000){lastBrief=now;lastReview=now;status='Agent updating the market and global news brief';reviewTask=review(session,[],rows,'brief').finally(()=>{reviewTask=null;});}else status='Watching scanners for new qualified candidates';
    }
   }
   if(!during)status='Outside equity session; next scheduled session '+(calendar.find(d=>d>session)??'requires calendar update');
   if(now-lastSnapshot>5000){lastSnapshot=now;await atomic(join(agentDir,'status.json'),{observedAt:new Date(now).toISOString(),session,status,market,newsReady:Boolean(news?.ready&&now-Date.parse(news.observedAt)<=20*60000),limits:{quantity:10,maxOpenPositions:10,maxEntriesPerDay:20},budget:store.budgetStatus(now),model:env.OPENAI_REVIEW_MODEL,paperOnly:true,reviewPending:Boolean(reviewTask),policy:'Independent prospective agent book; ordinary baselines remain separate. Approvals expire; missing data or budget blocks new entries. Stops, targets and 15:10 exits use observed quotes.'});}
   }catch{status='Agent data cycle unavailable; no new approvals';console.error('AGENT_DATA_CYCLE_UNAVAILABLE');}
   await new Promise(r=>setTimeout(r,1000));
  }
  await newsTask;await reviewTask;
 }finally{shadow.close();execution.close();store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)agentLoop(process.env,process.argv.includes('--preflight')).catch(()=>{console.error('AGENT_TRADING_WORKER_FAILED');process.exitCode=1;});
