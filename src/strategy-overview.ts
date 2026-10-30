import {strategyVisible} from './strategy-visibility.js';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {positionsView} from './positions-view.js';
import {day,validDate} from './model.js';
import {costAssumptions,estimateCosts} from './paper-valuation.js';
import type {ControlStore} from './paper-control-store.js';
import {labStrategies} from './strategy-registry.js';
const number=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v),round=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
export const costKeys=['brokerage','exchange','transactionTax','gst','stamp','sebi','ipft','fees','slippage','total'] as const;
export function summarizeOverview(positions:any[],now=Date.now()){
 const costs=Object.fromEntries(costKeys.map(k=>[k,0])) as Record<typeof costKeys[number],number>;
 let buyTurnover=0,sellTurnover=0,gross=0,net=0,valued=0,unknown=0,missingCosts=0,estimatedCosts=0,savedCosts=0,realizedGross=0,realizedNet=0,unrealizedGross=0,unrealizedNet=0,wins=0,losses=0,openCosts=0,unmatchedGross=0,valuedCostTotal=0;
 for(const p of positions){
  const units=p.quantity*(p.multiplier??1),entryValue=p.entry*units,exitKnown=p.status==='closed'&&number(p.exit)&&p.exit>0,short=p.side==='short';
  if(number(entryValue)&&entryValue>0){if(short)sellTurnover+=entryValue;else buyTurnover+=entryValue;}
  if(exitKnown){if(short)buyTurnover+=p.exit*units;else sellTurnover+=p.exit*units;}
  // Historical open positions are unresolved, never valued using a later day's quote.
  const currentOpen=p.status==='open'&&p.session===day(now)&&p.quote?.current&&number(p.quote.price),price=exitKnown?p.exit:currentOpen?p.quote.price:null;
  let fee:any=null;
  if(number(price)&&price>0&&number(units)&&units>0){
   const c=p.costs;
   if(c&&costKeys.every(k=>number(c[k])&&c[k]>=0)&&Math.abs(c.total-c.fees-c.slippage)<0.03&&Math.abs(c.fees-(c.brokerage+c.exchange+c.transactionTax+c.gst+c.stamp+c.sebi+c.ipft))<0.04){fee=c;savedCosts++;}
   else{try{fee=estimateCosts(p.entry,price,p.quantity,p.multiplier??1,p.assetClass==='MCX_FUTURE',short?'short':'long');estimatedCosts++;}catch{}}
  }
  if(fee){for(const k of costKeys)costs[k]+=fee[k];if(p.status==='open')openCosts+=fee.total;}else missingCosts++;
  const g=!p.unknownOutcome&&(p.status==='closed'||currentOpen)&&number(p.grossPnl)?p.grossPnl:null;
  if(number(g)&&fee){const n=round(g-fee.total);gross+=g;net+=n;valuedCostTotal+=fee.total;valued++;if(p.status==='closed'){realizedGross+=g;realizedNet+=n;if(n>0)wins++;if(n<0)losses++;}else{unrealizedGross+=g;unrealizedNet+=n;}}
  else{unknown++;if(number(g))unmatchedGross+=g;}
 }
 for(const k of costKeys)costs[k]=round(costs[k]);
 return {entries:positions.length,open:positions.filter(p=>p.status==='open').length,closed:positions.filter(p=>p.status==='closed').length,valued,unresolved:unknown,missingCosts,estimatedCosts,savedCosts,wins,losses,buyTurnover:round(buyTurnover),sellTurnover:round(sellTurnover),costs,estimatedOpenExitCosts:round(openCosts),grossPnl:valued?round(gross):null,netPnl:positions.length&&(valued||costs.total>0)?round(gross-costs.total):null,valuedNetPnl:valued?round(net):null,unresolvedCosts:round(costs.total-valuedCostTotal),realizedGross:round(realizedGross),realizedNet:round(realizedNet),unrealizedGross:round(unrealizedGross),unrealizedNet:round(unrealizedNet),grossWithoutComparableCosts:round(unmatchedGross),complete:positions.length>0&&unknown===0};
}
export async function strategyOverview(dir:string,labDir:string|undefined,control:ControlStore|undefined,from?:string,to?:string,now=Date.now(),retainedOnly=false){
 const view=await positionsView(dir,labDir,control,now,retainedOnly),files=await readdir(dir);
 const sessions=[...new Set([...files.filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(0,10)),...view.strategies.flatMap(g=>g.positions.map(p=>p.session))])].filter(d=>validDate(d)&&d<=day(now)).sort().reverse();
 const start=from??to??sessions[0]??day(now),end=to??from??start;if(!validDate(start)||!validDate(end)||start>end||end>day(now))throw Error('OVERVIEW_INVALID_DATE_RANGE');
 let registry:any=labStrategies;try{registry=JSON.parse(await readFile(join(labDir??'','registry.json'),'utf8')).strategies??labStrategies;}catch{}
 const definitions=new Map<string,string>(registry.filter((s:any)=>!retainedOnly||strategyVisible(s.id)).map((s:any)=>[s.id,s.name]));for(const s of view.strategies)definitions.set(s.id,s.name);
 const groups=[...definitions].map(([id,name])=>{const p=view.strategies.find(g=>g.id===id)?.positions.filter(p=>p.session>=start&&p.session<=end)??[];return {id,name,...summarizeOverview(p,now)};}).sort((a,b)=>(b.netPnl??-Infinity)-(a.netPnl??-Infinity)||a.name.localeCompare(b.name));
 const positions=view.strategies.flatMap(g=>g.positions).filter(p=>p.session>=start&&p.session<=end),summary=summarizeOverview(positions,now);if(view.errors.length)summary.complete=false;
 return {servedAt:new Date(now).toISOString(),paperOnly:true,selection:{from:start,to:end},today:day(now),availableSessions:sessions,recordedSessionsInRange:sessions.filter(d=>d>=start&&d<=end),summary,strategies:groups,errors:view.errors,costAssumptions,policy:{scope:'Sum of independent live-paper strategy experiments, including repeated stocks and legacy position sizes; not a single broker account or capital return. Backtests excluded.',dates:'Grouped by trade entry session (IST). Closed positions use their latest recorded final outcome, not an intraday point-in-time replay. Past sessions with open positions stay unresolved.',costs:'Saved paper charge breakdowns are used when available. Missing legacy breakdowns are estimated from recorded entry/exit fills using the existing model; saved trades are unchanged. Open costs include an estimated exit at the fresh current mark. Slippage is separate from taxes and fees.',turnover:'Executed paper buy/sell notional, including known entry legs. Principal turnover is not a trading expense. Estimated open exits are excluded from executed turnover.',unknown:'Unresolved positions do not become zero P&L. Partial net is known valued gross minus ALL known trading costs, including costs on unresolved positions. Missing P&L is excluded, never treated as a known zero; the full outcome remains unresolved. Valued-position net and unresolved-position costs are also exposed separately.',excluded:'Cloud, LLM and data subscriptions are outside trading charges.'}};
}
