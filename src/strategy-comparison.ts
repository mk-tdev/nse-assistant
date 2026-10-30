import {capitalMargin,readMarginSession} from './capital-margin.js';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {positionsView} from './positions-view.js';
import {summarizeOverview} from './strategy-overview.js';
import {day,validDate} from './model.js';
import {valuePosition,freshQuote} from './paper-valuation.js';
import type {ControlStore} from './paper-control-store.js';
const round=(n:number)=>Math.round(n*100)/100;
export function compareGroups(groups:{id:string;name:string;positions:any[]}[],sessions:string[],now=Date.now()){
 return groups.map(g=>{
  const positions=g.positions.filter(p=>sessions.includes(p.session)),summary=summarizeOverview(positions,now);
  const daily=sessions.map(session=>{const ps=positions.filter(p=>p.session===session),s=summarizeOverview(ps,now);return {session,...s,state:!ps.length?'no_trades':!s.complete?'partial':s.open?'open':'complete'};});
  const resolved=daily.filter(d=>d.state==='complete'),green=resolved.filter(d=>(d.netPnl??0)>0).length,red=resolved.filter(d=>(d.netPnl??0)<0).length;
  let equity=0,peak=0,drawdown=0;for(const d of resolved){equity+=d.netPnl??0;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);}
  const closed=positions.filter(p=>p.status==='closed').map(p=>summarizeOverview([p],now)).filter(s=>s.complete),profits=closed.reduce((n,p)=>n+Math.max(0,p.realizedNet),0),losses=closed.reduce((n,p)=>n+Math.max(0,-p.realizedNet),0);
  return {id:g.id,name:g.name,summary,daily,activeSessions:daily.filter(d=>d.entries).length,completeSessions:resolved.length,profitableSessions:green,losingSessions:red,flatSessions:resolved.length-green-red,partialSessions:daily.filter(d=>d.state==='partial').length,openSessions:daily.filter(d=>d.state==='open').length,noTradeSessions:daily.filter(d=>d.state==='no_trades').length,
   allSelectedSessionsProfitable:sessions.length>0&&green===sessions.length,
   positiveSessionPct:resolved.length?round(100*green/resolved.length):null,averageCompleteSessionNet:resolved.length?round(resolved.reduce((n,d)=>n+(d.netPnl??0),0)/resolved.length):null,
   profitFactor:losses?round(profits/losses):null,profitFactorLabel:!losses&&profits?'No resolved losses':!closed.length?'No resolved closed trades':null,
   knownSessionDrawdown:round(drawdown),drawdownPartial:resolved.length!==daily.filter(d=>d.entries).length,
   quantities:[...new Set(positions.map(p=>p.quantity))].sort((a,b)=>a-b),closedWinRate:closed.length?round(100*closed.filter(p=>p.realizedNet>0).length/closed.length):null};
 }).filter(g=>g.summary.entries).sort((a,b)=>b.profitableSessions-a.profitableSessions||b.completeSessions-a.completeSessions||(b.summary.netPnl??-Infinity)-(a.summary.netPnl??-Infinity));
}
export async function strategyComparison(dir:string,labDir:string|undefined,agentDir:string,control:ControlStore|undefined,from?:string,to?:string,now=Date.now(),retainedOnly=false){
 const baseline=await positionsView(dir,labDir,control,now,retainedOnly),agent=await positionsView(join(agentDir,'no-baseline-ledgers'),agentDir,undefined,now);
 let quotes:any=null;try{quotes=JSON.parse(await readFile(join(dir,'quotes.json'),'utf8'));}catch{}
 for(const g of agent.strategies)for(const p of g.positions){const q=quotes?.sessionDate===p.session?quotes.rows?.find((q:any)=>q.symbol===p.symbol):undefined,mark=freshQuote(q,now);p.quote={price:mark?.price??null,current:Boolean(mark),sourceTime:null,observedAt:null,kind:mark?'recent REST quote':'unavailable'};if(p.status==='open'){const value=valuePosition(p,q,now);p.grossPnl=value.grossPnl;p.costs=value.costs;p.netPnl=value.estimatedNetPnl;}}
 const groups=[...baseline.strategies,...agent.strategies.map(g=>({...g,name:'Agent Trading / approved / 10 shares'}))];
 const files=await readdir(dir),available=[...new Set([...files.filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(0,10)),...groups.flatMap(g=>g.positions.map(p=>p.session))])].filter(d=>validDate(d)&&d<=day(now)).sort();
 const end=to??from??available.at(-1)??day(now),start=from??to??available.slice(-3)[0]??end;
 if(!validDate(start)||!validDate(end)||start>end||end>day(now))throw Error('COMPARISON_INVALID_DATE_RANGE');
 const sessions=available.filter(d=>d>=start&&d<=end),strategies=compareGroups(groups,sessions,now);const margins=new Map(await Promise.all(sessions.map(async session=>[session,await readMarginSession(dir,session)] as const)));for(const strategy of strategies){const group=groups.find(g=>g.id===strategy.id)!;(strategy as any).capitalDays=sessions.map(session=>({session,...capitalMargin(group.positions.filter(p=>p.session===session),margins.get(session))}));}
 const combinedCapitalDays=sessions.map(session=>({session,...capitalMargin(baseline.strategies.flatMap(g=>g.positions).filter(p=>p.session===session),margins.get(session))}));
 return {combinedCapitalDays,servedAt:new Date(now).toISOString(),paperOnly:true,today:day(now),selection:{from:start,to:end},availableSessions:available,sessions,strategies,errors:[...baseline.errors,...agent.errors.filter(e=>!e.startsWith('Quote snapshots'))],policy:'Independent live-paper experiments only, including the separate Agent Trading book. Shadows and backtests excluded. Positive-session counts use only fully resolved, closed, traded sessions; no-trade dates are not wins or losses. Partial totals exclude missing P&L. Different stock prices, position sizes and risk mean net ranking is not a risk-adjusted return. No missing candles or outcomes are invented.'};
}
