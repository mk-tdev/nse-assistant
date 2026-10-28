import {DatabaseSync} from 'node:sqlite';
import {at,day,FIVE,validCandle,validDate,type Candle,type Instrument,type Batch} from './model.js';
import type {Provider} from './dhan.js';
import type {Universe} from './universe.js';

export const WATCHLIST = ['HDFCBANK','TCS'] as const;
export type InstrumentReport = {
  symbol:string;securityId:string;status:'waiting'|'collecting'|'complete'|'missing_data'|'fetch_error';
  storedCandles:number;expectedCandles:number;missingSlots:string[];missingVolumeSlots:string[];
  lastSourceTimestamp:string|null;lagSeconds:number|null;lastSuccessfulFetch:string|null;latestExpectedCandleEnd:string|null;
  excludedIncomplete:number;newCandles:number;revisedCandles:number;error:string|null;
  timestampSemantics:'operator_verified_start'|'unverified_start_interpretation';
};
export type SessionReport = {sessionDate:string;observedAt:string;mode:'live'|'mock';source:string;timeZone:'Asia/Kolkata';calendarVerified:false;strategyEnabled:false;phase:'before_open'|'session'|'after_close';universe?:Universe;instruments:InstrumentReport[]};
const iso=(t:number)=>new Date(t).toISOString();
export function safeRecorderError(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  return /^(DHAN_[A-Z_0-9]+|LIVE_CREDENTIALS_NOT_CONFIGURED|UNKNOWN_NSE_EQUITY_SECURITY_ID|RECORDER_[A-Z_]+)$/.test(message)?message:'RECORDER_FETCH_OR_SCHEMA_ERROR';
}
export function resolveWatchlist(items:Instrument[],symbols:readonly string[]=WATCHLIST):Instrument[]{
  if(!symbols.length||symbols.length>80||new Set(symbols).size!==symbols.length)throw new Error('RECORDER_INVALID_WATCHLIST');
  const result=symbols.map(symbol=>{
    const matches=items.filter(i=>i.exchangeSegment==='NSE_EQ'&&i.instrument==='EQUITY'&&i.symbol.replace(/-EQ$/,'')===symbol);
    const ids=[...new Set(matches.map(i=>i.securityId))];
    if(ids.length!==1)throw new Error('RECORDER_INSTRUMENT_MAPPING_FAILED');
    return {...matches[0]!,symbol};
  });
  if(new Set(result.map(i=>i.securityId)).size!==result.length)throw new Error('RECORDER_INSTRUMENT_MAPPING_FAILED');
  return result;
}
export class CandleStore {
  readonly db:DatabaseSync;
  private reportSample=new Map<string,{bucket:number;health:string;id:number;mutable:boolean}>();
  constructor(path:string,readOnly=false){
    this.db=new DatabaseSync(path,{readOnly});
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;');
    if(readOnly)return;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS candle_batches(session TEXT NOT NULL,security_id TEXT NOT NULL,observed_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,security_id,observed_at));
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candles(session TEXT NOT NULL,security_id TEXT NOT NULL,symbol TEXT NOT NULL,source_epoch_ms INTEGER NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,volume REAL,first_observed_at INTEGER NOT NULL,last_observed_at INTEGER NOT NULL,PRIMARY KEY(session,security_id,source_epoch_ms));
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,session TEXT NOT NULL,security_id TEXT NOT NULL,source_epoch_ms INTEGER NOT NULL,observed_at INTEGER NOT NULL,previous_json TEXT NOT NULL,replacement_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS polls(id INTEGER PRIMARY KEY,session TEXT NOT NULL,observed_at INTEGER NOT NULL,report_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS candles_recent_updates ON candles(last_observed_at);
      CREATE TABLE IF NOT EXISTS fetches(session TEXT NOT NULL,security_id TEXT NOT NULL,last_success_at INTEGER NOT NULL,PRIMARY KEY(session,security_id));`);
  }
  bind(mode:string,source:string){
    const row=this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
    const identity=JSON.stringify({mode,source});
    if(row&&row.value!==identity)throw new Error('RECORDER_STORE_MODE_MISMATCH');
    if(!row)this.db.prepare("INSERT INTO metadata VALUES('identity',?)").run(identity);
  }
  close(){this.db.close();}
  candles(session:string,id:string):Candle[]{
    return this.db.prepare('SELECT source_epoch_ms AS start,open,high,low,close,volume FROM candles WHERE session=? AND security_id=? ORDER BY source_epoch_ms').all(session,id) as Candle[];
  }
  lastSuccess(session:string,id:string):number|null {
    const row=this.db.prepare('SELECT last_success_at AS t FROM fetches WHERE session=? AND security_id=?').get(session,id);
    return row?Number(row.t):null;
  }
  save(session:string,instrument:Instrument,cs:Candle[],observedAt:number,provenance?:Pick<Batch,'source'|'candleStartVerified'|'missing'>){
    let added=0,revised=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(provenance)this.db.prepare('INSERT OR IGNORE INTO candle_batches VALUES(?,?,?,?)').run(session,instrument.securityId,observedAt,JSON.stringify({source:provenance.source,candleStartVerified:provenance.candleStartVerified,missing:provenance.missing}));
      const select=this.db.prepare('SELECT source_epoch_ms AS start,open,high,low,close,volume FROM candles WHERE session=? AND security_id=? AND source_epoch_ms=?');
      const insert=this.db.prepare('INSERT INTO candles VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const update=this.db.prepare('UPDATE candles SET open=?,high=?,low=?,close=?,volume=?,last_observed_at=? WHERE session=? AND security_id=? AND source_epoch_ms=?');
      for(const c of cs){
        const previous=select.get(session,instrument.securityId,c.start) as Candle|undefined;
        if(!previous){insert.run(session,instrument.securityId,instrument.symbol,c.start,c.open,c.high,c.low,c.close,c.volume,observedAt,observedAt);added++;}
        else{
          if(['open','high','low','close','volume'].some(k=>previous[k as keyof Candle]!==c[k as keyof Candle])){
            this.db.prepare('INSERT INTO revisions(session,security_id,source_epoch_ms,observed_at,previous_json,replacement_json) VALUES(?,?,?,?,?,?)').run(session,instrument.securityId,c.start,observedAt,JSON.stringify(previous),JSON.stringify(c));revised++;
          }
          update.run(c.open,c.high,c.low,c.close,c.volume,observedAt,session,instrument.securityId,c.start);
        }
      }
      this.db.prepare('INSERT INTO fetches VALUES(?,?,?) ON CONFLICT(session,security_id) DO UPDATE SET last_success_at=excluded.last_success_at').run(session,instrument.securityId,observedAt);
      this.db.exec('COMMIT');return {added,revised};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  saveReport(report:SessionReport){this.db.prepare('INSERT INTO polls(session,observed_at,report_json) VALUES(?,?,?)').run(report.sessionDate,Date.parse(report.observedAt),JSON.stringify(report));}
  saveSampledReport(report:SessionReport,final=false){
    const observed=Date.parse(report.observedAt),bucket=Math.floor(observed/FIVE);
    const extra=report as SessionReport&{paper?:{errors?:string[];research?:{errors?:string[]}}};
    const health=JSON.stringify([report.phase,report.instruments.map(i=>[i.symbol,i.status,i.error,i.missingSlots.length,i.missingVolumeSlots.length]),extra.paper?.errors,extra.paper?.research?.errors]);
    const previous=this.reportSample.get(report.sessionDate),body=JSON.stringify(report);
    // Preserve the first snapshot at every bucket/health transition and a fresh latest
    // snapshot; subsequent unchanged polls replace only that bucket's rolling tail.
    if(!final&&previous&&previous.bucket===bucket&&previous.health===health&&previous.mutable){
      this.db.prepare('UPDATE polls SET observed_at=?,report_json=? WHERE id=? AND session=?').run(observed,body,previous.id,report.sessionDate);
    }else{
      const result=this.db.prepare('INSERT INTO polls(session,observed_at,report_json) VALUES(?,?,?)').run(report.sessionDate,observed,body);
      this.reportSample.set(report.sessionDate,{bucket,health,id:Number(result.lastInsertRowid),mutable:Boolean(previous&&previous.bucket===bucket&&previous.health===health&&!final)});
    }
  }
  latestReport(session:string):SessionReport|null {
    const row=this.db.prepare('SELECT report_json FROM polls WHERE session=? ORDER BY id DESC LIMIT 1').get(session);
    return row?JSON.parse(String(row.report_json)):null;
  }
}
export class SessionRecorder {
  constructor(readonly store:CandleStore,readonly provider:Provider,readonly instruments:Instrument[],readonly date:string,readonly mode:'live'|'mock',readonly settleSeconds=10,readonly universe?:Universe,readonly completedOnly=false,readonly persistReports=true){
    if(!validDate(date)||!Number.isFinite(settleSeconds)||settleSeconds<0||settleSeconds>60)throw new Error('RECORDER_INVALID_CONFIGURATION');
    store.bind(mode,provider.source);
  }
  async poll(now=Date.now()):Promise<SessionReport>{
    const open=at(this.date,'09:15'),close=at(this.date,'15:30');
    const expectedEnd=Math.max(open,Math.min(close,Math.floor((now-this.settleSeconds*1000)/FIVE)*FIVE));
    const report:SessionReport={sessionDate:this.date,observedAt:iso(now),mode:this.mode,source:this.provider.source,timeZone:'Asia/Kolkata',calendarVerified:false,strategyEnabled:false,phase:now<open?'before_open':now<close?'session':'after_close',...(this.universe?{universe:this.universe}:{}),instruments:[]};
    for(const instrument of this.instruments){
      let batch:Batch|null=null,error:string|null=null,added=0,revised=0,excluded=0,accepted:Candle[]|null=null;
      const prior=this.store.candles(this.date,instrument.securityId);
      const cached=this.completedOnly&&(this.store.lastSuccess(this.date,instrument.securityId)??0)>=expectedEnd&&Array.from({length:(expectedEnd-open)/FIVE},(_,i)=>open+i*FIVE).every(t=>prior.some(c=>c.start===t&&c.volume!==null));
      if(expectedEnd>open&&!cached){
        try{
          // Pad before the lower boundary; retain only the intended session locally.
          batch=await this.provider.candles(instrument.securityId,iso(open-1000),iso(Math.min(now,close)));
          if(batch.candles.some((c,i)=>!validCandle(c)||i>0&&c.start<=batch!.candles[i-1]!.start))throw new Error('RECORDER_INVALID_OR_DUPLICATE_CANDLES');
          const cs=batch.candles.filter(c=>day(c.start)===this.date&&c.start>=open&&c.start<close&&c.start+FIVE<=now);
          excluded=batch.candles.filter(c=>day(c.start)===this.date&&c.start>=open&&c.start<close&&c.start+FIVE>now).length;
          accepted=cs;
        }catch(caught){error=safeRecorderError(caught);}
        if(accepted&&batch){try{({added,revised}=this.store.save(this.date,instrument,accepted,batch.fetchedAt,batch));}catch{throw new Error('RECORDER_STORAGE_FAILURE');}}
      }
      const stored=this.store.candles(this.date,instrument.securityId),missing:string[]=[],missingVolume:string[]=[];
      for(let t=open;t<expectedEnd;t+=FIVE){const c=stored.find(c=>c.start===t);if(!c)missing.push(iso(t));else if(c.volume===null)missingVolume.push(iso(t));}
      const success=this.store.lastSuccess(this.date,instrument.securityId);
      report.instruments.push({symbol:instrument.symbol,securityId:instrument.securityId,status:error?'fetch_error':expectedEnd===open?'waiting':missing.length||missingVolume.length?'missing_data':expectedEnd===close?'complete':'collecting',storedCandles:stored.length,expectedCandles:(expectedEnd-open)/FIVE,missingSlots:missing,missingVolumeSlots:missingVolume,lastSourceTimestamp:stored.length?iso(stored[stored.length-1]!.start):null,lagSeconds:stored.length?Math.max(0,(expectedEnd-stored[stored.length-1]!.start-FIVE)/1000):null,lastSuccessfulFetch:success===null?null:iso(success),latestExpectedCandleEnd:expectedEnd>open?iso(expectedEnd):null,excludedIncomplete:excluded,newCandles:added,revisedCandles:revised,error,timestampSemantics:batch?.candleStartVerified?'operator_verified_start':'unverified_start_interpretation'});
    }
    if(this.persistReports)this.store.saveReport(report);return report;
  }
}
