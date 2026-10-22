import {day,at} from './model.js';
export type Mark={price:number;observedAt:number;sourceTime:number;source:string;policy:string};
export type QuoteRow={symbol:string;securityId?:string;exchangeSegment?:string;lastPrice:number|null;observedAt:string;rawSourceTimestamp?:string|null;sourceTimestamp?:string|null;error?:string|null};
export function quoteSourceTime(raw:string|null|undefined):number|null{
 if(!raw)return null;
 const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
 const t=m?Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`):/Z$|[+-]\d{2}:\d{2}$/.test(raw)?Date.parse(raw):NaN;
 if(!Number.isFinite(t))return null;
 if(m){const local=new Date(t+330*60000).toISOString();if(local.slice(0,10)!==`${m[3]}-${m[2]}-${m[1]}`||local.slice(11,19)!==`${m[4]}:${m[5]}:${m[6]}`)return null;}
 return t;
}
export function freshQuote(row:QuoteRow|undefined,now:number,after=0):Mark|null{
 if(!row||row.error||!Number.isFinite(row.lastPrice)||row.lastPrice!<=0)return null;
 const observedAt=Date.parse(row.observedAt),sourceTime=quoteSourceTime(row.rawSourceTimestamp??row.sourceTimestamp);
 if(sourceTime===null||sourceTime>observedAt+1000||observedAt>now||observedAt<after||now-observedAt>15000||now-sourceTime>60000||day(sourceTime)!==day(now))return null;
 const date=day(now),mcx=row.exchangeSegment==='MCX_COMM';if(now<at(date,mcx?'09:00':'09:15')||now>=at(date,mcx?'23:30':'15:30'))return null;
 return {price:row.lastPrice!,observedAt,sourceTime,source:'Dhan REST quote',policy:'Research mark; raw trade timestamp interpreted as IST, not independently timezone verified; not a broker fill'};
}
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export const costAssumptions={version:'paper-costs-2026-10-22-v1',slippageBpsPerSide:1,source:'https://dhan.co/pricing/',equity:'Dhan retail NSE intraday indicative schedule; per-trade rounding approximation',commodity:'Illustrative non-agricultural MCX futures schedule: exchange 0.0026%, CTT sell 0.01%, stamp buy 0.002%, SEBI 0.0001%; verify against contract notes',note:'Estimates, not billed charges. One entry and one exit order. No margin funding/delivery fees. Slippage is an assumed 1 basis point per side, not measured market impact.'};
export function estimateCosts(entry:number,exit:number,quantity:number,multiplier=1,commodity=false,side:'long'|'short'='long'){
 if([entry,exit,quantity,multiplier].some(v=>!Number.isFinite(v)||v<=0))throw Error('INVALID_COST_INPUT');
 const entryValue=entry*quantity*multiplier,exitValue=exit*quantity*multiplier,buy=side==='long'?entryValue:exitValue,sell=side==='long'?exitValue:entryValue,total=buy+sell;
 const brokerage=commodity?40:round(Math.min(20,entryValue*.0003))+round(Math.min(20,exitValue*.0003));
 const exchange=round(total*(commodity?.000026:.000030699)),sebi=round(total*.000001),ipft=commodity?0:round(total*.000000001);
 const transactionTax=Math.round(sell*(commodity?.0001:.00025)),stamp=Math.round(buy*(commodity?.00002:.00003)),gst=round((brokerage+exchange+sebi+ipft)*.18),fees=round(brokerage+exchange+sebi+ipft+transactionTax+stamp+gst),slippage=round(total/10000);
 return {entryValue:round(entryValue),exitValue:round(exitValue),turnover:round(total),brokerage,exchange,sebi,ipft,transactionTax,stamp,gst,fees,slippage,total:round(fees+slippage),assumptions:costAssumptions.version};
}
export type Position={id:string;symbol:string;session:string;status:string;entry:number|null;entryAt:number|null;exit:number|null;exitAt:number|null;quantity:number;grossPnl:number|null;unknownOutcome:boolean;side?:'long'|'short';multiplier?:number;assetClass?:string};
export function valuePosition(s:Position,row:QuoteRow|undefined,now=Date.now(),fallback?:{price:number;sourceTime:number;observedAt:number}){
 if(s.entry===null)return {available:false,reason:'no_entry'};
 const multiplier=s.multiplier??1,side=s.side??'long',entryValue=s.entry*s.quantity*multiplier;
 const mark=s.status==='open'?freshQuote(row,now):null;
 const fallbackValid=fallback&&Number.isFinite(fallback.price)&&fallback.price>0&&fallback.sourceTime<=now&&fallback.observedAt<=now&&fallback.sourceTime>=(s.entryAt??0);
 const price=s.status==='closed'?s.exit:mark?.price??(fallbackValid?fallback!.price:null),gross=price===null?null:(price-s.entry)*s.quantity*multiplier*(side==='short'?-1:1);
 const costs=price===null?null:estimateCosts(s.entry,price,s.quantity,multiplier,s.assetClass==='MCX_FUTURE',side);
 const qualifiedGross=s.unknownOutcome?null:gross,net=qualifiedGross===null||!costs?null:round(qualifiedGross-costs.total);
 return {available:price!==null,entryValue:round(entryValue),markPrice:price,markAt:mark?.sourceTime??(s.status==='closed'?s.exitAt:fallbackValid?fallback!.sourceTime:null),markKind:s.status==='closed'?'recorded paper exit':mark?'recent REST snapshot':fallbackValid?'last stored completed candle; not current': 'unavailable',current:Boolean(mark),grossPnl:qualifiedGross===null?null:round(qualifiedGross),unrealizedGross:s.status==='open'&&qualifiedGross!==null?round(qualifiedGross):null,markedGrossBeforeUnknownPath:gross===null?null:round(gross),grossReturnPct:qualifiedGross===null?null:qualifiedGross/entryValue*100,estimatedNetPnl:net,estimatedNetReturnPct:net===null?null:net/entryValue*100,costs,unknownOutcome:s.unknownOutcome,denominator:'Entry notional; futures margin and account capital returns unavailable'};
}
