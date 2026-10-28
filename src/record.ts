import {DatabaseSync} from 'node:sqlite';
import {PaperLedger} from './paper.js';
import {PaperSessionWorker,loadPaperConfig} from './paper-worker.js';
import {mkdir,writeFile,rename,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DhanProvider} from './dhan.js';
import {at,FIVE,validDate} from './model.js';
import {CandleStore,SessionRecorder,resolveWatchlist,safeRecorderError} from './recorder.js';
import {recorderMock} from './recorder-mock.js';
import {loadUniverse} from './universe.js';
import {loadWatchlists} from './watchlists.js';
import {ResearchCoordinator} from './research.js';

const help=`Configurable universe recorder and simulated-only paper loop (no broker orders; strict gated default).
Usage: npm run record -- --live --date YYYY-MM-DD [--once] [--interval 30] [--data-dir .local/recorder/live]
       npm run record -- --mock --date YYYY-MM-DD --once
       npm run record -- --report --date YYYY-MM-DD
Live mode reads credentials from the environment (.env.local is loaded by the npm command).
Run one collector only. An explicit date selects a session; it does not verify the exchange calendar.
Stop with Ctrl-C. The collector stops five minutes after 15:30 IST.
Exit: 0 healthy/waiting; 2 missing data or fetch failure; 1 setup/storage failure.`;
export async function main(args=process.argv.slice(2)){
  if(args.includes('--help')||!args.length){console.log(help);return;}
  const flags=new Set(['--live','--mock','--once','--report']),values=new Set(['--date','--interval','--data-dir','--lock-dir']);
  const options=new Map<string,string>();
  for(let i=0;i<args.length;i++){const key=args[i]!;if(options.has(key)||!flags.has(key)&&!values.has(key))throw new Error('RECORDER_INVALID_ARGUMENTS');if(flags.has(key))options.set(key,'true');else{const value=args[++i];if(!value||value.startsWith('--'))throw new Error('RECORDER_INVALID_ARGUMENTS');options.set(key,value);}}
  const date=options.get('--date')??'',interval=Number(options.get('--interval')??30),dir=resolve(options.get('--data-dir')??(options.has('--mock')?'.local/recorder/mock':'.local/recorder/live'));
  if(!validDate(date)||!Number.isFinite(interval)||interval<15||interval>300)throw new Error('RECORDER_INVALID_ARGUMENTS');
  const dbPath=join(dir,'candles.sqlite');
  if(options.has('--report')){const store=new CandleStore(dbPath,true);try{const r=store.latestReport(date);if(!r)throw new Error('RECORDER_REPORT_NOT_FOUND');console.log(JSON.stringify(r,null,2));}finally{store.close();}return;}
  if(options.has('--live')===options.has('--mock'))throw new Error('RECORDER_CHOOSE_LIVE_OR_MOCK');
  if(options.has('--live')&&at(date,'09:15')>Date.now()+7*86400000)throw new Error('RECORDER_DATE_TOO_FAR_AHEAD');
  await mkdir(dir,{recursive:true,mode:0o700});
  // Kernel-held SQLite lock shares the persistent data mount across host/container invocations.
  // It releases on crash; no PID guessing, stale-file deletion or lease timeout can cause two collectors.
  const lock=new DatabaseSync(join(dir,'collector-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS singleton(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
  catch{lock.close();throw new Error('RECORDER_LOCKED_OR_UNWRITABLE');}
  await chmod(join(dir,'collector-lock.sqlite'),0o600);
  let store:CandleStore|undefined,ledger:PaperLedger|undefined,research:ResearchCoordinator|undefined,stopping=false,wake:(()=>void)|undefined;
  const stop=()=>{stopping=true;wake?.();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{
    const mode=options.has('--live')?'live':'mock';
    const provider=mode==='live'?new DhanProvider({clientId:process.env.DHAN_CLIENT_ID??'',token:process.env.DHAN_ACCESS_TOKEN??'',candleStartVerified:process.env.DHAN_CANDLE_START_VERIFIED==='true',quoteTimezoneVerified:false}):recorderMock(date);
    const universe=await loadUniverse(date);
    const master=(await provider.instruments()).items;
    const baseline=resolveWatchlist(master,universe?.constituents.map(c=>c.symbol));
    const watched=await loadWatchlists(date,master,process.env.PAPER_RESEARCH_ENABLED==='true'?process.env.RECORDER_WATCHLIST_PATH:undefined);
    const instruments=[...new Map([...baseline,...watched.instruments].map(i=>[i.securityId,i])).values()];
    store=new CandleStore(dbPath);await chmod(dbPath,0o600);
    const recorder=new SessionRecorder(store,provider,instruments,date,mode,10,universe??undefined,process.env.RECORDER_FETCH_COMPLETED_ONLY==='true',false);
    const baselineRecorder=new SessionRecorder(store,provider,baseline,date,mode,10,universe??undefined,false,false);
    let worker:PaperSessionWorker|undefined,paperSetupError:string|undefined;
    try {
      const config=await loadPaperConfig();
      if(config){ledger=new PaperLedger(join(dir,'paper.sqlite'),config);await chmod(join(dir,'paper.sqlite'),0o600);worker=new PaperSessionWorker(baselineRecorder,ledger,mode==='mock'?()=>at(date,'10:00')+10000:Date.now);
        if(process.env.PAPER_RESEARCH_ENABLED==='true')research=new ResearchCoordinator(store,provider,instruments,watched.instruments,date,mode,config,dir,watched.snapshot,watched.error,mode==='mock'?()=>at(date,'10:00')+10000:Date.now,Number(process.env.PAPER_SCREENER_QUANTITY??config.quantity));}
    }catch{if(!worker)paperSetupError='PAPER_CONFIGURATION_OR_STORAGE_FAILED';else paperSetupError='RESEARCH_CONFIGURATION_OR_STORAGE_FAILED';}
    while(!stopping){
      const cycleStarted=Date.now();
      const now=mode==='mock'?at(date,'10:00')+10000:Date.now();
      // A paper fault cannot stop the recorder; all setup errors remain visible and no new fills are made.
      const raw=await recorder.poll(now);
      Object.assign(raw,{collection:{baselineSymbols:baseline.map(i=>i.symbol),screenerSymbols:watched.instruments.map(i=>i.symbol),watchlistHash:watched.snapshot?.snapshotHash??null,watchlistError:watched.error}});
      const report=worker?await worker.poll(raw,true):raw;
      if(research&&'paper' in report){try{Object.assign(report.paper as object,{research:await research.poll(report)});}catch{Object.assign(report.paper as object,{research:{errors:['research_poll_failed'],simulatedOnly:true}});}}
      if(paperSetupError&&!worker)Object.assign(report,{paper:{simulatedOnly:true,exactQualification:false,status:'blocked',errors:[paperSetupError],states:[],observedAt:new Date(now).toISOString()}});
      if(paperSetupError&&worker&&'paper' in report)Object.assign(report.paper as object,{research:{errors:[paperSetupError],simulatedOnly:true}});
      const target=join(dir,`${date}.json`),temp=target+'.tmp';
      await writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(temp,target);
      if('paper' in report){const paperTarget=join(dir,`${date}.paper.json`);await writeFile(paperTarget+'.tmp',JSON.stringify(report.paper,null,2)+'\n',{mode:0o600});await rename(paperTarget+'.tmp',paperTarget);}
      store.saveSampledReport(report,options.has('--once')||mode==='mock'||now>=at(date,'15:30')+FIVE);
      console.log(JSON.stringify({observedAt:report.observedAt,sessionDate:date,mode,phase:report.phase,instruments:report.instruments.map(i=>({symbol:i.symbol,status:i.status,stored:i.storedCandles,expected:i.expectedCandles,missing:i.missingSlots.length,missingVolume:i.missingVolumeSlots.length,revised:i.revisedCandles,error:i.error})),report:target}));
      const unhealthy=report.instruments.some(i=>i.status==='fetch_error'||i.status==='missing_data');
      if(options.has('--once')||mode==='mock'||(!worker&&report.instruments.some(i=>i.error==='DHAN_HTTP_401'||i.error==='DHAN_HTTP_403'))||now>=at(date,'15:30')+FIVE){process.exitCode=unhealthy?2:0;break;}
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},Math.max(0,Math.min(interval*1000-(Date.now()-cycleStarted),(Math.floor((Date.now()-10000)/FIVE)+1)*FIVE+10000-Date.now())));wake=()=>{clearTimeout(timer);wake=undefined;resolve();};if(stopping)wake();});
    }
  }finally{await research?.close();ledger?.close();store?.close();lock.close();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(safeRecorderError(error));process.exitCode=1;});
