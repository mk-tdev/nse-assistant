import {at,FIVE,minute,validCandle,type Candle} from './model.js';
import {vwap,relativeVolume} from './analysis.js';
import {firstOrbCandidate,type Candidate} from './strategy-selection.js';
import type {LabStrategy} from './strategy-registry.js';
/** Only completed prefix bars are passed here. All setup levels precede the decision. */
export function firstStrategyCandidate(cfg:LabStrategy,symbol:string,session:string,bars:Candle[],history:Candle[],previous:string[],delayMs=10000,window=cfg.signalWindow??{start:'09:30',end:'11:00'}):Candidate|null{
 if(!cfg.setup)return firstOrbCandidate(symbol,session,bars,history,previous,delayMs,window);
 if(previous.length!==20)return null;
 const cs=bars.filter(validCandle).sort((a,b)=>a.start-b.start),past=new Map<number,Candle[]>();
 for(const b of history){const t=minute(b.start);if(!past.has(t))past.set(t,[]);past.get(t)!.push(b);}
 for(let i=0;i<cs.length;i++){
  const c=cs[i]!;if(c.start<at(session,window.start)||c.start+FIVE>at(session,window.end))continue;
  const prefix=cs.slice(0,i+1).filter(b=>b.start>=at(session,'09:15'));
  if(prefix.length!==(c.start-at(session,'09:15'))/FIVE+1||prefix.some(b=>b.volume===null))continue;
  const vw=vwap(prefix);if(vw===null||c.close<=vw)continue;
  let high:number,stop:number,rv:number,evidence:unknown;
  if(cfg.setup==='midday-consolidation'){
   const box=prefix.slice(-7,-1);if(box.length!==6||box[0]!.start<at(session,'10:30'))continue;
   high=Math.max(...box.map(b=>b.high));stop=Math.min(...box.map(b=>b.low));
   const width=(high-stop)/high,meanVolume=box.reduce((n,b)=>n+b.volume!,0)/6;
   const relative=relativeVolume(c,past.get(minute(c.start))??[],previous);
   // A new breakout, not a continuation of a candle already above this box.
   if(high<=stop||width>0.01||c.close<=high||relative.missing||relative.ratio===null||relative.ratio<1.5||meanVolume<=0||c.volume!<meanVolume*1.2)continue;
   rv=relative.ratio;evidence={setup:cfg.setup,boxStart:box[0]!.start,boxEnd:c.start,boxBars:box,boxWidthPct:width*100,maximumBoxWidthPct:1,volumeVsBox:c.volume!/meanVolume,minimumVolumeVsBox:1.2};
  }else{
   const opening=prefix.filter(b=>b.start<at(session,'09:30'));if(opening.length!==3)continue;
   high=Math.max(...opening.map(b=>b.high));let found:{b:Candle;retest:Candle[];rv:number}|undefined;
   // Breakout must be 1–3 completed bars earlier. A close below the level invalidates it.
   for(let j=Math.max(3,prefix.length-4);j<prefix.length-1;j++){
    const b=prefix[j]!,before=prefix[j-1]!,tail=prefix.slice(j+1),breakVwap=vwap(prefix.slice(0,j+1)),relative=relativeVolume(b,past.get(minute(b.start))??[],previous);
    if(b.start<at(session,'09:30')||before.close>high||b.close<=high||breakVwap===null||b.close<=breakVwap||relative.missing||relative.ratio===null||relative.ratio<1.5)continue;
    if(tail.some(t=>t.close<=high)||c.low>high*1.001||c.close<=c.open||c.close<=high)continue;
    const low=Math.min(...tail.map(t=>t.low));if(low>=high||low>=c.close)continue;
    found={b,retest:tail,rv:relative.ratio};break;
   }
   if(!found)continue;stop=Math.min(...found.retest.map(b=>b.low));rv=found.rv;
   evidence={setup:cfg.setup,openingBars:opening,breakoutBar:found.b,retestBars:found.retest,touchTolerancePct:0.1,maximumRetestBars:3,volumeMeasuredAt:'breakout candle',confirmation:'bullish retest candle closes above opening-range high and session approximate VWAP'};
  }
  return {id:`${cfg.id}/${session}/${symbol}/${c.start}`,symbol,session,signalStart:c.start,decidedAt:c.start+FIVE+delayMs,signalClose:c.close,rangeHigh:high,stop,vwap:vw,relativeVolume:rv,extension:(c.close-high)/(high-stop),setupEvidence:evidence,source:'Historical final bars; modeled end+10s availability; setup defined on completed prefix only'};
 }
 return null;
}
