import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {day,at,validDate} from './model.js';
const calendarSchema=z.object({source:z.string().min(1),kind:z.literal('scheduled_regular_sessions'),validFrom:z.string().refine(validDate),validThrough:z.string().refine(validDate),sessions:z.array(z.string().refine(validDate))});
export function marketSessionDecision(raw:unknown,now:number){
 const calendar=calendarSchema.parse(raw),date=day(now);
 if(calendar.validFrom>calendar.validThrough||new Set(calendar.sessions).size!==calendar.sessions.length||calendar.sessions.some(d=>d<calendar.validFrom||d>calendar.validThrough))throw new Error('Invalid calendar');
 if(date<calendar.validFrom||date>calendar.validThrough)return {date,run:false,reason:'calendar_out_of_coverage'};
 if(!calendar.sessions.includes(date))return {date,run:false,reason:'not_scheduled_regular_session'};
 if(now<at(date,'09:05')||now>=at(date,'15:35'))return {date,run:false,reason:'outside_collection_window'};
 return {date,run:true,reason:'scheduled_regular_session'};
}
export async function runMarketSession(){
 const calendarPath=process.env.RECORDER_CALENDAR_PATH??'/app/deploy/lightsail/calendar-2026.json';
 const decision=marketSessionDecision(JSON.parse(await readFile(calendarPath,'utf8')),Date.now());
 console.log(JSON.stringify({event:'market_session_decision',...decision,calendarSource:'published schedule; subsequent notices require operator updates'}));
 if(!decision.run){if(decision.reason==='calendar_out_of_coverage')process.exitCode=1;return;}
 const child=spawn(process.execPath,[new URL('./record.js',import.meta.url).pathname,'--live','--date',decision.date,'--interval',process.env.RECORDER_POLL_INTERVAL_SECONDS??'30','--data-dir',process.env.RECORDER_DATA_DIR??'/data','--lock-dir',process.env.RECORDER_LOCK_DIR??'/run/recorder'],{stdio:'inherit',env:process.env});
 const forward=(signal:NodeJS.Signals)=>()=>child.kill(signal);
 const interrupt=forward('SIGINT'),terminate=forward('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=signal?1:code??1;resolve();});});
 process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runMarketSession().catch(()=>{console.error('RECORDER_SESSION_START_FAILED');process.exitCode=1;});
