import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {at,day,FIVE,validDate,validCandle} from './model.js';
import {DhanProvider} from './dhan.js';
import {CandleStore,resolveWatchlist} from './recorder.js';
import {loadPaperConfig} from './paper-worker.js';
import {fetchScreens,hash,loadWatchlists,type Watchlists} from './watchlists.js';
import {median} from './analysis.js';
export async function prepare(date:string,dir:string){
 if(!validDate(date)||Date.now()>at(date,'09:05'))throw Error('WATCHLIST_FREEZE_WINDOW_CLOSED');await mkdir(dir,{recursive:true,mode:0o700});
 const lock=new DatabaseSync(join(dir,'collector-lock.sqlite'));lock.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS singleton(id INTEGER PRIMARY KEY);BEGIN EXCLUSIVE;');
 const store=new CandleStore(join(dir,'candles.sqlite'));
 try{const provider=new DhanProvider({clientId:process.env.DHAN_CLIENT_ID??'',token:process.env.DHAN_ACCESS_TOKEN??'',candleStartVerified:false,quoteTimezoneVerified:false});store.bind('live',provider.source);
  const cfg=await loadPaperConfig();if(!cfg)throw Error('PAPER_CONFIG_REQUIRED');const previous=cfg.calendar.sessions.filter(d=>d<date).sort().slice(-20);if(previous.length!==20||!cfg.calendar.sessions.includes(date))throw Error('WATCHLIST_CALENDAR_COVERAGE_MISSING');
  const {candidates,sources}=await fetchScreens(),items=(await provider.instruments()).items;
  const cached=await loadWatchlists(date,items,join(dir,`${date}.watchlists.json`));
  if(cached.snapshot)for(const source of sources.filter(s=>s.status==='unavailable')){const previousSource=cached.snapshot.sources.find(s=>s.source===source.source&&s.status!=='unavailable');if(previousSource){candidates.push(...cached.snapshot.candidates.filter(c=>c.source===source.source));Object.assign(source,previousSource,{status:'cached_valid_same_session_snapshot'});}}
  const accepted:Watchlists['accepted']=[],rejected:Watchlists['rejected']=[];
  for(const symbol of [...new Set(candidates.map(c=>c.symbol))]){
   let instrument;try{instrument=resolveWatchlist(items,[symbol])[0]!;}catch{rejected.push({symbol,reason:'not_uniquely_mapped_NSE_EQ_equity'});continue;}
   if(accepted.length>=20){rejected.push({symbol,reason:'research_universe_capacity_20'});continue;}
   let ok=previous.every(session=>{const cs=store.candles(session,instrument.securityId);return Array.from({length:18},(_,i)=>at(session,'09:30')+i*FIVE).every(t=>cs.some(c=>c.start===t&&validCandle(c)&&c.volume!==null));});
   if(!ok)for(let attempt=0;attempt<2;attempt++){try{const batch=await provider.candles(instrument.securityId,new Date(at(previous[0]!,'09:15')-1000).toISOString(),new Date(at(previous.at(-1)!,'15:30')).toISOString());
     for(const session of previous)store.save(session,instrument,batch.candles.filter(c=>day(c.start)===session&&validCandle(c)),batch.fetchedAt,batch);ok=true;break;
    }catch{await new Promise(r=>setTimeout(r,2000));}}
   if(!ok){rejected.push({symbol,reason:'history_fetch_failed'});continue;}
   const turnover:number[]=[],volumes:number[]=[];let missing=false;
   for(const session of previous){const cs=store.candles(session,instrument.securityId);for(let t=at(session,'09:30');t<at(session,'11:00');t+=FIVE)if(!cs.some(c=>c.start===t&&validCandle(c)&&c.volume!==null))missing=true;
    turnover.push(cs.reduce((v,c)=>v+(c.high+c.low+c.close)/3*(c.volume??0),0));volumes.push(cs.reduce((v,c)=>v+(c.volume??0),0));}
   if(missing){rejected.push({symbol,reason:'required_prior20_morning_slots_missing'});continue;}
   const turn=median(turnover)??0,vol=median(volumes)??0;
   if(turn<10_000_000||vol<100_000){rejected.push({symbol,reason:'liquidity_proxy_below_1crore_turnover_or_100k_shares'});continue;}
   accepted.push({symbol,securityId:instrument.securityId,sources:[...new Set(candidates.filter(c=>c.symbol===symbol).map(c=>c.source))],medianObservedTurnover:turn,medianObservedVolume:vol});
  }
  const w:Watchlists={sessionDate:date,frozenAt:new Date().toISOString(),candidates,accepted,rejected,sources,policy:'Frozen pre-session candidate lists; unique NSE EQ mappings; complete prior20 morning volume slots; median observed (tail-incomplete) turnover >= INR1crore and volume >=100k shares; at most20 extras; no assertion of spread/circuit tradability',snapshotHash:''};
  w.snapshotHash=hash({...w,snapshotHash:undefined});const file=join(dir,`${date}.watchlists.json`);await writeFile(file+'.tmp',JSON.stringify(w,null,2),{mode:0o600});await rename(file+'.tmp',file);
  console.log(JSON.stringify({sessionDate:date,candidates:candidates.length,accepted:accepted.map(a=>a.symbol),rejected,sources:sources.map(s=>({source:s.source,status:s.status})),snapshot:file,ordersSubmitted:false}));
 }finally{store.close();lock.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)prepare(process.argv[2]??day(Date.now()),process.env.RECORDER_DATA_DIR??'/data').catch(()=>{console.error('WATCHLIST_PREPARATION_FAILED');process.exitCode=1;});
