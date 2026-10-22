import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validDate,at,FIVE} from './model.js';
export async function dashboardData(dir:string,session?:string){
 const sessions=(await readdir(dir)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(0,10)).sort().reverse();
 const selected=session??sessions[0];
 if(!selected||!validDate(selected)||!sessions.includes(selected))return null;
 // The combined atomic report keeps quality, baseline and cohorts on the same poll.
 const report=JSON.parse(await readFile(join(dir,selected+'.json'),'utf8'));
 let deployment:unknown=null;try{deployment=JSON.parse(await readFile(join(dir,'dashboard-config.json'),'utf8'));}catch{/* Optional pre-session deployment metadata; never read environment files. */}
 return {deployment,servedAt:new Date().toISOString(),sessions,selectedSession:selected,report,policy:{simulatedOnly:true,realOrders:false,prices:'Dhan REST snapshots and stored completed five-minute bars; not tick streaming',pnl:'INR, one simulated share by default; gross resolved subtotal only; fees/slippage unset',timestampSemantics:'Provisional candle-start labels; exact qualification unavailable'}};
}
export function chartCandles(dir:string,session:string,symbol:string,now=Date.now()){
 if(!validDate(session)||!/^[A-Z0-9&_.-]{1,32}$/.test(symbol))throw Error('INVALID_CHART_QUERY');
 const db=new DatabaseSync(join(dir,'candles.sqlite'),{readOnly:true});
 try{
  db.exec('PRAGMA busy_timeout=1500; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY;');
  const candles=db.prepare(`SELECT source_epoch_ms AS start,open,high,low,close,volume,last_observed_at AS observedAt FROM candles WHERE session=? AND symbol=? AND source_epoch_ms>=? AND source_epoch_ms<? AND source_epoch_ms+?<=? ORDER BY source_epoch_ms LIMIT 75`).all(session,symbol,at(session,'09:15'),at(session,'15:30'),FIVE,now);
  return {session,symbol,intervalMinutes:5,source:'Persisted Dhan REST observations',pricePolicy:'Latest recorded versions for chart inspection; immutable paper ledger decides fills',timestampSemantics:'Provisional candle-start labels',candles};
 }finally{db.close();}
}
