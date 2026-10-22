import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {at,day,FIVE,type Candle} from './model.js';
import type {Candidate} from './strategy-selection.js';
export function liveCandidates(dir:string,session:string):Candidate[]{const result:Candidate[]=[];
 for(const file of ['paper.sqlite','paper-screener-orb.sqlite']){const path=join(dir,file);if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA busy_timeout=1500;');
 const rows=db.prepare('SELECT e.* FROM paper_events e JOIN paper_states s ON s.id=e.state_id WHERE e.kind=?').all('research_signal');for(const r of rows){const v=JSON.parse(String(r.body)),start=Number(v.observation?.candle?.start);if(day(start)!==session||!v.observation||!Number.isFinite(v.vwap)||!Number.isFinite(v.relativeVolume?.ratio))continue;const state=String(r.state_id).split('/');result.push({id:`${session}/${state[0]}/${start}`,symbol:state[0]!,session,signalStart:start,decidedAt:Number(r.observed_at),signalClose:v.observation.candle.close,rangeHigh:v.high,stop:v.low,vwap:v.vwap,relativeVolume:v.relativeVolume.ratio,extension:(v.observation.candle.close-v.high)/(v.high-v.low),source:'Immutable live research_signal event; original observation and actual engine decision timestamp'});}
 }finally{db.close();}}
 return result.sort((a,b)=>a.decidedAt-b.decidedAt||a.symbol.localeCompare(b.symbol));
}
export function sessionBars(dir:string,session:string,symbols:string[],previous:string[],asOf?:number){
 const db=new DatabaseSync(join(dir,'candles.sqlite'),{readOnly:true});const current=new Map<string,Candle[]>(),history=new Map<string,Candle[]>();try{db.exec('PRAGMA busy_timeout=3000; PRAGMA temp_store=MEMORY;');
 for(const symbol of symbols){current.set(symbol,[]);history.set(symbol,[]);}
 if(symbols.length){const rows=db.prepare('SELECT symbol,session,source_epoch_ms AS start,open,high,low,close,volume,first_observed_at FROM candles WHERE session>=? AND session<=? AND symbol IN ('+symbols.map(()=>'?').join(',')+') ORDER BY source_epoch_ms').all(previous[0]??session,session,...symbols),past=new Set(previous);
 for(const r of rows){const symbol=String(r.symbol),c={start:Number(r.start),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:r.volume===null?null:Number(r.volume)};
 if(String(r.session)===session&&(!asOf||Number(r.first_observed_at)<=asOf)&&c.start+FIVE<=(asOf??Infinity))current.get(symbol)!.push(c);else if(past.has(String(r.session)))history.get(symbol)!.push(c);
 }}

 }finally{db.close();}return {current,history};
}
export async function sessionUniverse(dir:string,session:string){let report:any=null;try{report=JSON.parse(await readFile(join(dir,session+'.json'),'utf8'));}catch{}
 let membership=report?.universe;if(!membership)try{membership=JSON.parse(await readFile(new URL('../deploy/lightsail/nifty50-2026-10-21.json',import.meta.url),'utf8'));}catch{}
 const nifty:string[]=membership?.constituents?.map((x:any)=>x.symbol)??[];let frozen:any=null;try{frozen=JSON.parse(await readFile(join(dir,session+'.watchlists.json'),'utf8'));}catch{}
 const accepted:string[]=Array.isArray(frozen?.accepted)?frozen.accepted.map((x:any)=>typeof x==='string'?x:x.symbol):[];
 const timely=frozen?.sessionDate===session&&Date.parse(frozen.frozenAt)<at(session,'09:15');const screeners=timely?accepted:[];
 return {nifty,screeners,symbols:[...new Set([...nifty,...screeners])],selectionEvidence:{niftySnapshotHash:membership?.sha256??null,screenerSnapshotHash:timely?frozen.snapshotHash:null,niftySource:membership?.source??null,niftyRetrievedAt:membership?.retrievedAt??null,niftyPointInTimeVerified:membership?.retrievedAt?Date.parse(membership.retrievedAt)<at(session,'09:15'):false,screenerFrozenAt:timely?frozen.frozenAt:null,screenerPointInTimeVerified:Boolean(timely),screenerWarning:timely?null:'No eligible pre-session screener snapshot; screener strategies cannot trade historical current-list selections'}};
}

export function recordedDecisionsAvailable(dir:string,session:string){for(const file of ['paper.sqlite','paper-screener-orb.sqlite']){const path=join(dir,file);if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('SELECT 1 FROM paper_events WHERE kind IN (?,?) AND state_id LIKE ? LIMIT 1').get('research_signal','no_signal','%/'+session+'/%'))return true;}finally{db.close();}}return false;}
