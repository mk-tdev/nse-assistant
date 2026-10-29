import {at,FIVE} from './model.js';
import {vwap,relativeVolume} from './analysis.js';
import type {SessionRecorder,SessionReport} from './recorder.js';
import type {PaperLedger} from './paper.js';
/** All configured equities are evaluated independently. No ranking truncates the universe. */
export function scanUniverse(recorder:SessionRecorder,ledger:PaperLedger,report:SessionReport,now:number){
 const previous=ledger.config.calendar.sessions.filter(d=>d<recorder.date).sort().slice(-20);
 const states=ledger.list().filter(s=>s.session===recorder.date&&s.mode===ledger.config.mode);
 const rows=recorder.instruments.map(i=>{
  const cs=recorder.store.candles(recorder.date,i.securityId).filter(c=>c.start+FIVE<=now);
  const range=cs.filter(c=>c.start>=at(recorder.date,'09:15')&&c.start<at(recorder.date,'09:30'));
  const latest=cs.at(-1),state=states.find(s=>s.symbol===i.symbol),quality=report.instruments.find(r=>r.symbol===i.symbol);
  const rv=latest&&latest.start>=at(recorder.date,'09:30')&&latest.start<at(recorder.date,'11:00')?relativeVolume(latest,ledger.baselines(recorder.date,i.symbol,now).map(o=>o.candle),previous):null;
  return {symbol:i.symbol,securityId:i.securityId,status:state?.status??'blocked',reasons:state?.reasons??['paper_state_unavailable'],quality:quality?.status??'fetch_error',fetchError:quality?.error??null,missingCandles:quality?.missingSlots.length??null,
   lastCompletedCandle:latest?new Date(latest.start).toISOString():null,lastClose:latest?.close??null,openingRange:range.length===3?{high:Math.max(...range.map(c=>c.high)),low:Math.min(...range.map(c=>c.low))}:null,
   approximateVwap:vwap(cs),relativeVolume:rv?.ratio??null,signalAt:state?.signal?new Date(state.signal).toISOString():null,entry:state?.entry??null,stop:state?.stop??null,target:state?.target??null,quantity:state?.quantity??ledger.config.quantity,unknownOutcome:state?.unknownOutcome??false};
 });
 return {universe:recorder.universe?.name??'validation-pair',snapshotDate:recorder.universe?.snapshotDate??null,membershipSource:recorder.universe?.source??null,expectedStocks:recorder.instruments.length,evaluatedStocks:states.filter(s=>recorder.instruments.some(i=>i.symbol===s.symbol)).length,observedAt:new Date(now).toISOString(),simulatedOnly:true,selection:'evaluate every constituent independently; no top-N selection',metricPolicy:'Latest stored completed bars are descriptive; immutable paper ledger alone decides trades. Approximate VWAP; not executable fills.',counts:Object.fromEntries(['blocked','no-signal','pending-entry','open','closed','signal-only'].map(status=>[status,rows.filter(r=>r.status===status).length])),rows};
}
