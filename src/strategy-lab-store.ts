import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {estimateCosts,freshQuote,type QuoteRow} from './paper-valuation.js';
import {at,day} from './model.js';
import {strategyHash,type LabStrategy} from './strategy-registry.js';
import type {Candidate,SelectionRow} from './strategy-selection.js';
export type LabPosition={id:string;runId:string;strategy:string;session:string;symbol:string;status:string;signal:number;decidedAt:number;entryAt:number|null;entry:number|null;stop:number;target:number|null;exitAt:number|null;exit:number|null;exitReason:string|null;quantity:number;grossPnl:number|null;netPnl:number|null;unknownOutcome:boolean;reasons:string[];updatedAt:number;lastQuoteAt:number|null;lastPrice:number|null;candidate:Candidate;config:LabStrategy;configHash:string;costs:ReturnType<typeof estimateCosts>|null;initialRisk:number|null;executionMode:string};
export class StrategyLabStore{
 readonly db:DatabaseSync;
 constructor(readonly dir:string){mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'strategy-lab.sqlite');this.db=new DatabaseSync(file);chmodSync(file,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS lab_runs(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS lab_positions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,strategy_id TEXT NOT NULL,session TEXT NOT NULL,symbol TEXT NOT NULL,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS lab_positions_run ON lab_positions(run_id,strategy_id,session);
 CREATE INDEX IF NOT EXISTS lab_positions_symbol ON lab_positions(run_id,symbol);
 CREATE TABLE IF NOT EXISTS lab_events(id INTEGER PRIMARY KEY,position_id TEXT NOT NULL,event_key TEXT NOT NULL,observed_at INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(position_id,event_key));
 CREATE TABLE IF NOT EXISTS lab_quotes(session TEXT NOT NULL,symbol TEXT NOT NULL,observed_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,symbol,observed_at));
 CREATE TABLE IF NOT EXISTS lab_controls(strategy_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS lab_selection(run_id TEXT NOT NULL,session TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,session));`);}
 close(){this.db.close();}
 enabled(cfg:LabStrategy){const r=this.db.prepare('SELECT enabled FROM lab_controls WHERE strategy_id=?').get(cfg.id);return r?Boolean(r.enabled):cfg.enabled;}
 toggle(id:string,enabled:boolean){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO lab_controls VALUES(?,?) ON CONFLICT(strategy_id) DO UPDATE SET enabled=excluded.enabled').run(id,enabled?1:0);if(!enabled)for(const row of this.db.prepare('SELECT body FROM lab_positions WHERE strategy_id=?').all(id)){const p=JSON.parse(String(row.body)) as LabPosition;if(p.runId.startsWith('live/')&&p.status==='pending-entry'){p.status='skipped';p.reasons=['strategy_paused_before_fill'];p.updatedAt=Date.now();this.save(p);this.event(p,'paused','entry_rejected',{reason:p.reasons[0]},p.updatedAt);}}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 quoteHistory(session:string){return this.db.prepare('SELECT body FROM lab_quotes WHERE session=? ORDER BY observed_at,symbol').all(session).map(r=>JSON.parse(String(r.body)) as QuoteRow);}

 run(id:string,mode:string,body:unknown,now=Date.now()){this.db.prepare("INSERT OR IGNORE INTO lab_runs VALUES(?,?,?,'running',?)").run(id,now,mode,JSON.stringify(body));}
 runs(){return this.db.prepare('SELECT * FROM lab_runs ORDER BY created_at DESC LIMIT 100').all().map(r=>({id:String(r.id),created_at:Number(r.created_at),mode:String(r.mode),status:String(r.status),body:JSON.parse(String(r.body))}));}
 finishRun(id:string,status:string,result:unknown){this.db.prepare('UPDATE lab_runs SET status=?,body=? WHERE id=?').run(status,JSON.stringify(result),id);}
 positions(runId:string,strategy?:string,symbol?:string):LabPosition[]{return this.db.prepare('SELECT body FROM lab_positions WHERE run_id=?'+(strategy?' AND strategy_id=?':'')+(symbol?' AND symbol=?':'')+' ORDER BY rowid').all(runId,...(strategy?[strategy]:[]),...(symbol?[symbol]:[])).map(r=>JSON.parse(String(r.body)));}
 get(id:string):LabPosition|null{const r=this.db.prepare('SELECT body FROM lab_positions WHERE id=?').get(id);return r?JSON.parse(String(r.body)):null;}
 save(p:LabPosition){this.db.prepare('INSERT INTO lab_positions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(p.id,p.runId,p.strategy,p.session,p.symbol,JSON.stringify(p));}
 event(p:LabPosition,key:string,kind:string,body:unknown,now:number){this.db.prepare('INSERT OR IGNORE INTO lab_events(position_id,event_key,observed_at,kind,body) VALUES(?,?,?,?,?)').run(p.id,key,now,kind,JSON.stringify(body));}
 selection(runId:string,session:string,rows?:SelectionRow[]){if(rows)this.db.prepare('INSERT OR IGNORE INTO lab_selection VALUES(?,?,?)').run(runId,session,JSON.stringify(rows));const r=this.db.prepare('SELECT body FROM lab_selection WHERE run_id=? AND session=?').get(runId,session);return r?JSON.parse(String(r.body)) as SelectionRow[]:null;}
 journal(session:string,quotes:QuoteRow[]){const stmt=this.db.prepare('INSERT OR IGNORE INTO lab_quotes VALUES(?,?,?,?)');this.db.exec('BEGIN IMMEDIATE');try{for(const q of quotes)if(q.exchangeSegment!=='MCX_COMM'&&Number.isFinite(Date.parse(q.observedAt))&&day(Date.parse(q.observedAt))===session)stmt.run(session,q.symbol,Date.parse(q.observedAt),JSON.stringify(q));this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 consider(runId:string,cfg:LabStrategy,c:Candidate,selection:SelectionRow[]|null,screeners:string[],now:number,executionMode='observed-quote',nifty:string[]=[]){
 const id=`${runId}/${cfg.id}/${c.session}/${c.symbol}`;if(this.get(id))return;
 const reasons:string[]=[];
 if(!cfg.enabled)reasons.push('strategy_disabled');
 if(cfg.universe==='nifty50'&&!nifty.includes(c.symbol))reasons.push('outside_frozen_nifty50_universe');
 if(cfg.universe==='screeners'&&!screeners.includes(c.symbol))reasons.push('outside_frozen_screener_universe');
 if(cfg.universe==='stocks-in-play'&&!selection?.find(r=>r.symbol===c.symbol)?.eligible)reasons.push('not_selected_at_opening_cutoff');
 if(cfg.maxExtension!==null&&c.extension>cfg.maxExtension)reasons.push('extension_exceeds_'+cfg.maxExtension+'_opening_range_width');
 if(c.signalStart<at(c.session,'09:30')||c.signalStart+300000>at(c.session,'11:00'))reasons.push('outside_morning_signal_window');
 if(!Number.isFinite(c.extension)||c.rangeHigh<=c.stop)reasons.push('invalid_opening_range');
 if(now<c.decidedAt||now-c.decidedAt>cfg.fillTimeoutMs)reasons.push('signal_arrived_too_late_for_prospective_fill');
 const p:LabPosition={id,runId,strategy:cfg.id,session:c.session,symbol:c.symbol,status:reasons.length?'skipped':'pending-entry',signal:c.signalStart,decidedAt:c.decidedAt,entryAt:null,entry:null,stop:c.stop,target:null,exitAt:null,exit:null,exitReason:null,quantity:cfg.sizing==='fixed-10'?cfg.quantity:0,grossPnl:null,netPnl:null,unknownOutcome:false,reasons,updatedAt:now,lastQuoteAt:null,lastPrice:null,candidate:c,config:cfg,configHash:strategyHash(cfg),costs:null,initialRisk:null,executionMode};
 this.save(p);this.event(p,'candidate','candidate',{candidate:c,reasons,configuration:cfg,selection:selection?.find(r=>r.symbol===c.symbol)??null},now);
 }
 private quantity(p:LabPosition,price:number){const cfg=p.config,risk=price-p.stop;if(risk<=0)return 0;if(cfg.sizing==='fixed-10')return cfg.quantity;
  const positions=this.positions(p.runId,p.strategy).filter(s=>s.session===p.session),open=positions.filter(s=>s.status==='open');if(open.length>=cfg.maxOpenPositions||positions.some(s=>s.unknownOutcome))return 0;
  const cash=cfg.capital+positions.reduce((n,s)=>n+(s.status==='closed'?(s.netPnl??0):0),0)-open.reduce((n,s)=>n+s.entry!*s.quantity+(s.costs?.total??0),0);
  const allowedRisk=Math.min(cfg.riskPerTrade,cfg.riskPerTrade*cfg.maxOpenPositions-open.reduce((n,s)=>n+(s.initialRisk??0),0));let qty=Math.floor(Math.min(allowedRisk/risk,cfg.maxPositionValue/price,cash/price));
  while(qty>0){const fees=estimateCosts(price,p.stop,qty);const slip=(price+p.stop)*qty*cfg.slippageBps/10000;const total=risk*qty+fees.fees+slip;if(total<=allowedRisk&&price*qty+fees.fees+slip<=cash)return qty;qty--;}
  return 0;
 }
 private closePosition(p:LabPosition,price:number,now:number,reason:string,quote:QuoteRow){p.status='closed';p.exit=price;p.exitAt=now;p.exitReason=reason;p.updatedAt=now;p.lastPrice=price;p.lastQuoteAt=Date.parse(quote.observedAt);const costs=estimateCosts(p.entry!,price,p.quantity);costs.slippage=Math.round((p.entry!+price)*p.quantity*p.config.slippageBps/10000*100)/100;costs.total=Math.round((costs.fees+costs.slippage)*100)/100;p.costs=costs;p.grossPnl=p.unknownOutcome?null:Math.round((price-p.entry!)*p.quantity*100)/100;p.netPnl=p.grossPnl===null?null:Math.round((p.grossPnl-costs.total)*100)/100;this.event(p,'exit','closed',{price,reason,quote,costs,unknownOutcome:p.unknownOutcome,policy:'Observed sampled quote mark; assumed slippage/costs deducted separately. No broker execution.'},now);}
 applyQuotes(runId:string,quotes:QuoteRow[],now:number,onlySymbol?:string){this.db.exec('BEGIN IMMEDIATE');try{
 for(const p of this.positions(runId,undefined,onlySymbol).filter(p=>p.status==='open'||p.status==='pending-entry')){
  const q=quotes.find(q=>q.symbol===p.symbol&&q.exchangeSegment!=='MCX_COMM'),mark=freshQuote(q,now,p.status==='pending-entry'?p.decidedAt+1:0);
  const valid=mark&&mark.sourceTime<=now&&now-mark.sourceTime<=15000&&(p.status!=='pending-entry'||mark.sourceTime>p.decidedAt);
  if(p.status==='pending-entry'){
   if(now-p.decidedAt>p.config.fillTimeoutMs){p.status='skipped';p.reasons=['no_fresh_post_decision_quote_within_60s'];p.updatedAt=now;this.event(p,'entry-expired','entry_rejected',{reason:p.reasons[0]},now);}
   else if(valid&&q){const price=mark.price;const qty=this.quantity(p,price);if(price<=p.stop||price>=p.candidate.signalClose+2*(p.candidate.signalClose-p.stop)||p.config.maxExtension!==null&&(price-p.candidate.rangeHigh)/(p.candidate.rangeHigh-p.stop)>p.config.maxExtension||qty<1){p.status='skipped';p.reasons=[qty<1?'risk_or_capital_limit':'entry_quote_outside_price_bounds'];this.event(p,'entry-rejected','entry_rejected',{price,quantity:qty},now);}else{p.status='open';p.entry=price;p.entryAt=now;p.quantity=qty;p.target=price+2*(price-p.stop);p.lastPrice=price;p.lastQuoteAt=mark.observedAt;p.initialRisk=(price-p.stop)*qty;p.costs=estimateCosts(price,p.stop,qty);p.updatedAt=now;p.reasons=['prospective_observed_quote_entry'];this.event(p,'entry','open',{quote:q,price,quantity:qty,risk:p.initialRisk,costsAtStop:p.costs,policy:'LTP snapshot at/after decision, never assigned an earlier candle-open fill'},now);}}
  }else{
   if(p.lastQuoteAt!==null&&now-p.lastQuoteAt>(p.executionMode==='bar-proxy'?330000:30000)){p.unknownOutcome=true;p.reasons=['quote_coverage_gap_exceeded_30s'];this.event(p,'unknown-coverage','unknown_outcome',{lastQuoteAt:p.lastQuoteAt,now},now);}
   if(valid&&q&&mark.observedAt>(p.lastQuoteAt??0)){p.lastQuoteAt=mark.observedAt;p.lastPrice=mark.price;p.updatedAt=now;
    const reason=mark.price<=p.stop?'observed_quote_stop':mark.price>=p.target!?'observed_quote_target':now>=at(p.session,'15:10')&&mark.sourceTime>=at(p.session,'15:10')&&mark.observedAt>=at(p.session,'15:10')?'observed_quote_time_exit':null;if(reason)this.closePosition(p,mark.price,now,reason,q);
   }
   if(p.status==='open'&&now>=at(p.session,'15:30')){p.status='closed';p.unknownOutcome=true;p.exitReason='no_eligible_quote_exit_before_market_close';p.exit=null;p.exitAt=null;p.grossPnl=null;p.netPnl=null;this.event(p,'missing-exit','unknown_outcome',{reason:p.exitReason},now);}
  }this.save(p);
 }
 this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
 barProxy(runId:string,symbol:string,c:{start:number;open:number;high:number;low:number;close:number}){
 const quote=(price:number,time:number):QuoteRow=>({symbol,exchangeSegment:'NSE_EQ',lastPrice:price,observedAt:new Date(time).toISOString(),rawSourceTimestamp:new Date(time).toISOString(),error:null});
 this.applyQuotes(runId,[quote(c.open,c.start)],c.start,symbol);
 this.db.exec('BEGIN IMMEDIATE');try{for(const p of this.positions(runId,undefined,symbol).filter(p=>p.status==='open')){
  let price:number|null=null,reason:string|null=null;
  if(c.start>=at(p.session,'15:10')){price=c.open;reason='bar_proxy_time_exit';}
  else if(c.start>=(p.entryAt??0)){
   if(c.low<=p.stop){price=Math.min(c.open,p.stop);reason=c.high>=p.target!?'bar_proxy_stop_first_ambiguity':'bar_proxy_stop';}
   else if(c.high>=p.target!){price=p.target;reason='bar_proxy_target';}
  }
  if(reason&&price!==null){const exitTime=reason==='bar_proxy_time_exit'?c.start:c.start+300000;this.closePosition(p,price,exitTime,reason,quote(price,exitTime));}
  else {p.lastQuoteAt=c.start+300000;p.lastPrice=c.close;}
  this.save(p);
 }this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 manualExit(id:string,createdAt:number,quote:QuoteRow|undefined,now:number,requestId:string){this.db.exec('BEGIN IMMEDIATE');try{const p=this.get(id);if(!p||!['open','pending-entry'].includes(p.status)){this.db.exec('COMMIT');return {positionId:id,status:'already_closed'};}
 if(p.status==='pending-entry'){p.status='closed';p.exitReason='manual_cancel_pending';this.save(p);this.event(p,'manual/'+requestId,'manual_exit',{requestId},now);this.db.exec('COMMIT');return {positionId:id,status:'cancelled'};}
 const mark=freshQuote(quote,now,createdAt+1);if(!mark||mark.sourceTime<=createdAt){this.db.exec('COMMIT');return null;}if(p.lastQuoteAt!==null&&now-p.lastQuoteAt>(p.executionMode==='bar-proxy'?330000:30000))p.unknownOutcome=true;this.closePosition(p,mark.price,now,mark.price<=p.stop?'observed_quote_stop':mark.price>=p.target!?'observed_quote_target':'manual_observed_quote',quote!);this.event(p,'manual/'+requestId,'manual_exit',{requestId},now);this.save(p);this.db.exec('COMMIT');return {positionId:id,status:'closed',exit:p.exit,unknownOutcome:p.unknownOutcome};}catch(e){this.db.exec('ROLLBACK');throw e;}}
 snapshot(runId:string,cfgs:LabStrategy[],session?:string){return cfgs.map(cfg=>{const states=this.positions(runId,cfg.id).filter(s=>!session||s.session===session),entered=states.filter(s=>s.entry!==null),closed=entered.filter(s=>s.status==='closed'),unknown=entered.filter(s=>s.unknownOutcome),known=closed.filter(s=>s.netPnl!==null);return {name:cfg.id,label:cfg.name,configuration:cfg,configHash:strategyHash(cfg),runId,simulatedOnly:true,mode:'approximate-research',executionMode:states[0]?.executionMode??'observed-quote',states,events:this.db.prepare("SELECT e.* FROM lab_events e JOIN lab_positions p ON p.id=e.position_id WHERE p.run_id=? AND p.strategy_id=? AND (?='' OR p.session=?) ORDER BY e.id DESC LIMIT 100").all(runId,cfg.id,session??'',session??'').map(e=>({id:Number(e.id),position_id:String(e.position_id),state_id:String(e.position_id),observed_at:Number(e.observed_at),kind:String(e.kind),body:String(e.body)})),summary:{entries:entered.length,open:entered.filter(s=>s.status==='open').length,closed:closed.length,unknown:unknown.length,wins:known.filter(s=>s.netPnl!>0).length,losses:known.filter(s=>s.netPnl!<0).length,knownGrossSubtotal:known.reduce((n,s)=>n+s.grossPnl!,0),knownNetSubtotal:known.reduce((n,s)=>n+s.netPnl!,0),complete:unknown.length===0&&entered.every(s=>s.status==='closed')},scanner:{expectedStocks:states.length,rows:states.map(s=>({symbol:s.symbol,status:s.status,reasons:s.reasons,lastClose:s.lastPrice,openingRange:{high:s.candidate.rangeHigh,low:s.stop},approximateVwap:s.candidate.vwap,relativeVolume:s.candidate.relativeVolume,entry:s.entry,stop:s.stop,target:s.target}))}};});}
}
