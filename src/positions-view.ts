import {strategyVisible} from './strategy-visibility.js';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cohortFiles,type ControlStore} from './paper-control-store.js';
import {labStrategies} from './strategy-registry.js';
import {freshQuote,quoteSourceTime,valuePosition,type QuoteRow} from './paper-valuation.js';
const legacyNames:Record<string,string>={baseline:'Original Nifty ORB / legacy','screener-orb':'Screener ORB / legacy','range-hold':'Range hold / legacy','range-failure-exit':'Range failure exit / legacy','agent-recovery':'Agent recovery / legacy','mcx-manual':'MCX manual paper'};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
/** Independent read-only view: entered live-paper positions only, never scanner selections or backtest runs. */
export async function positionsView(dir:string,labDir?:string,control?:ControlStore,now=Date.now(),retainedOnly=false){
 const errors:string[]=[],groups=new Map<string,{id:string;name:string;positions:any[]}>(),seen=new Set<string>();
 const collect=(id:string,s:any)=>{
  if(retainedOnly&&!strategyVisible(id)&&s.status!=='open')return;
  if(!['open','closed'].includes(s.status)||!finite(s.entry)||s.entry<=0)return;
  const key=id+'/'+s.id;if(seen.has(key))return;seen.add(key);
  if(!groups.has(id))groups.set(id,{id,name:s.config?.name??labStrategies.find(c=>c.id===id)?.name??legacyNames[id]??id,positions:[]});
  groups.get(id)!.positions.push(s);
 };
 const open=(file:string)=>{const db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=1500;PRAGMA temp_store=MEMORY;');return db;};
 for(const [id,file] of Object.entries(cohortFiles)){
  const path=join(dir,file);if(!existsSync(path))continue;let db:DatabaseSync|undefined;
  try{db=open(path);for(const row of db.prepare('SELECT body FROM paper_states').all())collect(id,JSON.parse(String(row.body)));}
  catch{errors.push(id+': ledger unavailable; positions may be missing');}finally{db?.close();}
 }
 let lab:DatabaseSync|undefined,latestQuoteSession:string|null=null;
 try{
  if(labDir&&existsSync(join(labDir,'strategy-lab.sqlite'))){lab=open(join(labDir,'strategy-lab.sqlite'));for(const row of lab.prepare("SELECT strategy_id,body FROM lab_positions WHERE run_id LIKE 'live/%'").all())collect(String(row.strategy_id),JSON.parse(String(row.body)));const last=lab.prepare('SELECT MAX(session) AS session FROM lab_quotes').get();latestQuoteSession=last?.session?String(last.session):null;}
 }catch{errors.push('Strategy lab ledger unavailable; positions may be missing');}
 try{for(const s of control?.positions()??[])collect('mcx-manual',s);}catch{errors.push('Manual paper ledger unavailable');}
 let quotes:any=null;try{quotes=JSON.parse(await readFile(join(dir,'quotes.json'),'utf8'));}catch{errors.push('Quote snapshots unavailable');}
 const rows:QuoteRow[]=Array.isArray(quotes?.rows)?quotes.rows:[],quoteCache=new Map<string,QuoteRow|null>();
 try{
  const strategies=[...groups.values()].map(group=>{
   const positions=group.positions.map(s=>{
    const segment=s.assetClass==='MCX_FUTURE'?'MCX_COMM':'NSE_EQ',key=s.session+'/'+s.symbol+'/'+segment;
    const current=rows.find(q=>q.symbol===s.symbol&&(q.exchangeSegment??'NSE_EQ')===segment&&!q.error&&finite(q.lastPrice)&&q.lastPrice!>0);
    if(!quoteCache.has(key)){let archived:QuoteRow|null=null;
     if(!current&&lab&&segment==='NSE_EQ')try{for(const session of [...new Set([latestQuoteSession,s.session].filter(Boolean))]){const r=lab.prepare('SELECT body FROM lab_quotes WHERE session=? AND symbol=? ORDER BY observed_at DESC LIMIT 1').get(session!,s.symbol);if(r){archived=JSON.parse(String(r.body));break;}}}catch{}
     quoteCache.set(key,current??archived);
    }
    const q=quoteCache.get(key)??undefined,mark=freshQuote(q,now),quoteTime=quoteSourceTime(q?.rawSourceTimestamp??q?.sourceTimestamp),observed=q?Date.parse(q.observedAt):NaN;
    // Future or invalid timestamps are never shown as usable price observations.
    const usable=q&&!q.error&&finite(q.lastPrice)&&q.lastPrice!>0&&finite(observed)&&observed<=now&&(quoteTime===null||quoteTime<=now&&quoteTime<=observed+1000);
    const valuation=s.status==='open'?valuePosition(s,usable?q:undefined,now):null;
    return {id:s.id,session:s.session,symbol:s.symbol,status:s.status,side:s.side??'long',quantity:s.quantity,multiplier:s.multiplier??1,assetClass:s.assetClass??'NSE_EQ',entry:s.entry,entryAt:s.entryAt,stop:s.stop??null,target:s.target??null,exit:s.exit??null,exitAt:s.exitAt??null,exitReason:s.exitReason??null,unknownOutcome:Boolean(s.unknownOutcome),grossPnl:s.unknownOutcome?null:s.status==='closed'?(finite(s.grossPnl)?s.grossPnl:null):valuation?.grossPnl??null,netPnl:s.unknownOutcome?null:s.status==='closed'?(finite(s.netPnl)?s.netPnl:null):valuation?.estimatedNetPnl??null,pnlKind:s.status==='closed'?'recorded realized paper P&L':'estimated open mark after costs',quote:{price:usable?q.lastPrice:null,current:Boolean(mark&&usable),sourceTime:usable&&quoteTime!==null?new Date(quoteTime).toISOString():null,observedAt:usable?q.observedAt:null,kind:mark&&usable?'recent REST quote':usable?'last recorded quote; not live':'unavailable'},costs:s.status==='closed'?s.costs??null:valuation?.costs??null};
   }).sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1)||(Number(b.entryAt)||0)-(Number(a.entryAt)||0)||a.symbol.localeCompare(b.symbol));
   const closed=positions.filter(p=>p.status==='closed'),known=closed.filter(p=>finite(p.netPnl));
   return {id:group.id,name:group.name,positions,summary:{open:positions.filter(p=>p.status==='open').length,closed:closed.length,unknown:positions.filter(p=>p.unknownOutcome).length,knownRealizedNet:known.reduce((n,p)=>n+p.netPnl!,0),closedWithoutKnownNet:closed.length-known.length}};
  }).sort((a,b)=>b.summary.open-a.summary.open||a.name.localeCompare(b.name));
  const all=strategies.flatMap(g=>g.positions);
  return {servedAt:new Date(now).toISOString(),paperOnly:true,scope:'All recorded live-paper sessions; no stock or strategy selection filters; historical simulations excluded',quotePolicy:'Dhan REST snapshots; page refreshes every 5s. Source timestamps interpreted as IST, not independently verified. Old quotes are labelled; closed P&L always stays recorded.',quoteFeed:{checkedAt:quotes?.checkedAt??quotes?.observedAt??null,phase:quotes?.phase??null,error:quotes?.error??null},errors,strategies,summary:{open:all.filter(p=>p.status==='open').length,closed:all.filter(p=>p.status==='closed').length,unknown:all.filter(p=>p.unknownOutcome).length,strategies:strategies.length,openWithoutLiveQuote:all.filter(p=>p.status==='open'&&!p.quote.current).length}};
 }finally{lab?.close();}
}
