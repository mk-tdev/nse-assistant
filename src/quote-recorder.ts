/** Separate read-only REST snapshot collector. Its output never drives paper fills. */
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dashboardData} from './dashboard-data.js';
import {at,day} from './model.js';
import {z} from 'zod';
const quoteSchema=z.object({last_price:z.number().positive(),last_trade_time:z.string().optional(),volume:z.number().nonnegative().optional(),ohlc:z.object({open:z.number(),high:z.number(),low:z.number(),close:z.number()}).optional()});
export async function collectQuotes(items:{symbol:string;securityId:string}[],env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
 if(!env.DHAN_CLIENT_ID||!env.DHAN_ACCESS_TOKEN)throw Error('QUOTE_CREDENTIALS_MISSING');
 if(!items.length||items.length>80||items.some(i=>!/^\d+$/.test(i.securityId)))throw Error('QUOTE_UNIVERSE_INVALID');
 const response=await fetcher('https://api.dhan.co/v2/marketfeed/quote',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json','access-token':env.DHAN_ACCESS_TOKEN,'client-id':env.DHAN_CLIENT_ID},body:JSON.stringify({NSE_EQ:items.map(i=>Number(i.securityId))})});
 if(!response.ok)throw Error('DHAN_HTTP_'+response.status);
 const raw=await response.json() as {status?:string;data?:{NSE_EQ?:Record<string,unknown>}};if(raw.status!=='success')throw Error('QUOTE_UNSUCCESSFUL');
 const observedAt=new Date().toISOString();
 return items.map(i=>{const q=quoteSchema.safeParse(raw.data?.NSE_EQ?.[i.securityId]);if(!q.success)return {...i,lastPrice:null,observedAt,error:'QUOTE_MISSING_OR_INVALID'};const v=q.data,close=v.ohlc?.close;return {...i,lastPrice:v.last_price,observedAt,rawSourceTimestamp:v.last_trade_time??null,sourceTimestampVerified:false,sourceFreshness:'unknown',volume:v.volume??null,ohlc:v.ohlc??null,changePercent:close&&close>0?(v.last_price-close)/close*100:null,error:null};});
}
export async function quoteLoop(env:NodeJS.ProcessEnv=process.env){
 const dir=env.RECORDER_DATA_DIR??'/data';await mkdir(dir,{recursive:true});let stopping=false;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
 const calendar=JSON.parse(await readFile(env.QUOTE_CALENDAR_PATH??new URL('../deploy/lightsail/calendar-2026.json',import.meta.url),'utf8')) as {sessions:string[];validFrom?:string;validThrough?:string};
 while(!stopping){const now=Date.now(),sessionDate=day(now),during=calendar.sessions.includes(sessionDate)&&now>=at(sessionDate,'09:15')&&now<at(sessionDate,'15:30');let output:Record<string,unknown>={sessionDate,checkedAt:new Date(now).toISOString(),source:'Dhan REST full-quote snapshots',intervalSeconds:5,sourceTimeZoneVerified:false,simulatedOnly:true,phase:during?'regular_hours':'outside_scheduled_hours',rows:[],error:null};
  try{if(during){const d=await dashboardData(dir,sessionDate);if(!d)throw Error('QUOTE_AWAITING_SESSION_REPORT');output.rows=await collectQuotes(d.report.instruments,env);output.observedAt=new Date().toISOString();}}catch(e){output.error=e instanceof Error&&/^(DHAN_HTTP_\d+|QUOTE_[A-Z_]+)$/.test(e.message)?e.message:'QUOTE_FETCH_OR_SCHEMA_ERROR';}
  const file=join(dir,'quotes.json');await writeFile(file+'.tmp',JSON.stringify(output)+'\n',{mode:0o600});await rename(file+'.tmp',file);
  // No requests outside the published scheduled market window. Browser count never changes API rate.
  await new Promise(r=>setTimeout(r,during?5000:15000));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)quoteLoop().catch(()=>{console.error('QUOTE_SERVICE_FAILED');process.exitCode=1;});
