import {at,FIVE,day,minute,validCandle,type Candle} from './model.js';
import {vwap,relativeVolume} from './analysis.js';
import type {LabStrategy} from './strategy-registry.js';
export type Candidate={setupEvidence?:unknown;id:string;symbol:string;session:string;signalStart:number;decidedAt:number;signalClose:number;rangeHigh:number;stop:number;vwap:number;relativeVolume:number;extension:number;source:string};
export function firstOrbCandidate(symbol:string,session:string,bars:Candle[],history:Candle[],previous:string[],delayMs=10000,window={start:'09:30',end:'11:00'}):Candidate|null{
 const cs=bars.filter(validCandle).sort((a,b)=>a.start-b.start),range=cs.filter(c=>c.start>=at(session,'09:15')&&c.start<at(session,'09:30'));
 if(range.length!==3||range.some(c=>c.volume===null)||previous.length!==20)return null;
 const high=Math.max(...range.map(c=>c.high)),low=Math.min(...range.map(c=>c.low));if(high<=low)return null;
 const historyByMinute=new Map<number,Candle[]>();for(const bar of history){const slot=minute(bar.start);if(!historyByMinute.has(slot))historyByMinute.set(slot,[]);historyByMinute.get(slot)!.push(bar);}
 for(const c of cs.filter(c=>c.start>=at(session,window.start)&&c.start+FIVE<=at(session,window.end))){
  const prefix=cs.filter(b=>b.start>=at(session,'09:15')&&b.start<=c.start);
  if(prefix.length!==(c.start-at(session,'09:15'))/FIVE+1||prefix.some(b=>b.volume===null))continue;
  const vw=vwap(prefix),rv=relativeVolume(c,historyByMinute.get(minute(c.start))??[],previous);
  if(vw===null||rv.missing||rv.ratio===null||c.close<=high||c.close<=vw||rv.ratio<1.5)continue;
  return {id:`${session}/${symbol}/${c.start}`,symbol,session,signalStart:c.start,decidedAt:c.start+FIVE+delayMs,signalClose:c.close,rangeHigh:high,stop:low,vwap:vw,relativeVolume:rv.ratio,extension:(c.close-high)/(high-low),source:'Historical final bars; modeled end+10s decision availability, not original live delivery'};
 }return null;
}
export type SelectionRow={symbol:string;eligible:boolean;reason:string;openingRelativeVolume:number|null;openingTurnover:number|null;openingReturnPct:number|null;relativeStrengthPct:number|null;rank:number|null;frozenAt:number;evidence?:unknown};
export function openingSelection(session:string,symbols:string[],current:Map<string,Candle[]>,history:Map<string,Candle[]>,previous:string[],cfg:LabStrategy['selection'],frozenAt:number):SelectionRow[]{
 const vals=symbols.map(symbol=>{const bars=(current.get(symbol)??[]).filter(c=>c.start>=at(session,'09:15')&&c.start<at(session,'09:30'));let reason='opening_baseline_unavailable',rvol:number|null=null,turnover:number|null=null,ret:number|null=null;
  if(previous.length===20&&bars.length===3&&bars.every(c=>validCandle(c)&&c.volume!==null)){
   const volumes=previous.map(date=>(history.get(symbol)??[]).filter(c=>day(c.start)===date&&minute(c.start)>=555&&minute(c.start)<570));
   if(volumes.every(cs=>cs.length===3&&cs.every(c=>validCandle(c)&&c.volume!==null))){const totals=volumes.map(cs=>cs.reduce((n,c)=>n+c.volume!,0)).sort((a,b)=>a-b),median=(totals[9]!+totals[10]!)/2;
    if(median>0){rvol=bars.reduce((n,c)=>n+c.volume!,0)/median;turnover=bars.reduce((n,c)=>n+(c.high+c.low+c.close)/3*c.volume!,0);const ordered=[...bars].sort((a,b)=>a.start-b.start);ret=(ordered[2]!.close/ordered[0]!.open-1)*100;reason='rank_pending';}
   }
  }return {symbol,eligible:false,reason,evidence:{openingBars:bars,prior20OpeningVolumes:previous.map(date=>({date,volume:(history.get(symbol)??[]).filter(c=>day(c.start)===date&&minute(c.start)>=555&&minute(c.start)<570).reduce((n,c)=>n+(c.volume??0),0)}))},openingRelativeVolume:rvol,openingTurnover:turnover,openingReturnPct:ret,relativeStrengthPct:null as number|null,rank:null as number|null,frozenAt};});
 const returns=vals.map(v=>v.openingReturnPct).filter((v):v is number=>v!==null).sort((a,b)=>a-b),mid=Math.floor(returns.length/2),median=returns.length?(returns.length%2?returns[mid]!:(returns[mid-1]!+returns[mid]!)/2):null;
 for(const v of vals){if(v.openingReturnPct===null||median===null)continue;v.relativeStrengthPct=v.openingReturnPct-median;v.reason=v.openingRelativeVolume!<cfg.minimumOpeningRelativeVolume?'opening_relative_volume_below_2x':v.openingTurnover!<cfg.minimumOpeningTurnover?'opening_turnover_below_1crore':v.openingReturnPct<=0||v.relativeStrengthPct<=0?'not_positive_relative_strength':'rank_pending';}
 const ranked=vals.filter(v=>v.reason==='rank_pending').sort((a,b)=>b.openingRelativeVolume!-a.openingRelativeVolume!||b.relativeStrengthPct!-a.relativeStrengthPct!||a.symbol.localeCompare(b.symbol));
 ranked.forEach((v,i)=>{v.rank=i+1;v.eligible=i<cfg.topN;v.reason=v.eligible?'selected_at_opening_cutoff':'outside_top_10';});return vals;
}
/** Qualification coverage is separate from trade outcomes: missing history is not a no-signal. */
export function qualificationCoverage(session:string,symbols:string[],current:Map<string,Candle[]>,history:Map<string,Candle[]>,previous:string[],window={start:'09:30',end:'11:00'},baselineSlots=1,requireCompleteHistory=false){
 let usableSlots=0,missingBaselineSlots=0,missingPrefixSlots=0;const unavailable:string[]=[];
 for(const symbol of symbols){const currentValid=new Set((current.get(symbol)??[]).filter(c=>validCandle(c)&&c.volume!==null).map(c=>c.start)),pastValid=new Set((history.get(symbol)??[]).filter(c=>validCandle(c)&&c.volume!==null).map(c=>day(c.start)+'/'+minute(c.start)));let usable=0;const completeHistory=!requireCompleteHistory||previous.length===20&&previous.every(date=>Array.from({length:75},(_,i)=>555+i*5).every(slot=>pastValid.has(date+'/'+slot)));
  for(let t=at(session,window.start);t+FIVE<=at(session,window.end);t+=FIVE){let prefix=true;for(let p=at(session,'09:15');p<=t;p+=FIVE)if(!currentValid.has(p)){prefix=false;break;}
   const baseline=completeHistory&&previous.length===20&&previous.every(date=>Array.from({length:baselineSlots},(_,i)=>minute(t-i*FIVE)).every(slot=>pastValid.has(date+'/'+slot)));if(!prefix)missingPrefixSlots++;if(!baseline)missingBaselineSlots++;if(prefix&&baseline){usable++;usableSlots++;}}
  if(!usable)unavailable.push(symbol);
 }return {status:usableSlots===0?'blocked':missingBaselineSlots||missingPrefixSlots?'partial':'complete',usableSlots,missingBaselineSlots,missingPrefixSlots,stocksWithoutUsableSlot:unavailable,reason:usableSlots===0?(requireCompleteHistory?'EMA evaluation blocked: complete 75-bar sessions across prior20 history and a valid current prefix are required':'No signal slots have a complete current prefix and prior-20 same-slot volume baseline'):missingBaselineSlots||missingPrefixSlots?'Some signal slots lack required price/volume history':null};
}
