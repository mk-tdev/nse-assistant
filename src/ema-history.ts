import {at,FIVE,validCandle,type Candle} from './model.js';
export type EmaHistoryPolicy={sessionEnd:'15:15';lookbackSessions:3;minimumBars:200};
/** Fixed, declared calculation window. The closing tail is OUTSIDE this EMA model,
 * never imputed or reclassified as a market closure. Calendar order skips only
 * actual scheduled non-session dates. Every required core slot must really exist. */
export function emaWarmupStarts(previous:string[],policy:EmaHistoryPolicy):number[]{
 if(previous.length<policy.lookbackSessions||new Set(previous).size!==previous.length)return [];
 return previous.slice(-policy.lookbackSessions).flatMap(date=>{
  const starts:number[]=[];for(let t=at(date,'09:15');t<at(date,policy.sessionEnd);t+=FIVE)starts.push(t);return starts;
 }).slice(-policy.minimumBars);
}
export function emaWarmup(history:Candle[],previous:string[],policy:EmaHistoryPolicy){
 const expected=emaWarmupStarts(previous,policy),byStart=new Map<number,Candle[]>();
 for(const c of history){if(!byStart.has(c.start))byStart.set(c.start,[]);byStart.get(c.start)!.push(c);}
 const missingStarts:number[]=[],invalidStarts:number[]=[],bars:Candle[]=[];
 for(const t of expected){const values=byStart.get(t)??[];if(!values.length)missingStarts.push(t);
  else if(values.length!==1||!validCandle(values[0]!)||values[0]!.volume===null)invalidStarts.push(t);
  else bars.push(values[0]!);
 }
 return {ready:expected.length===policy.minimumBars&&!missingStarts.length&&!invalidStarts.length,bars,expected,missingStarts,invalidStarts,policy};
}
