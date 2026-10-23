import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {at,validDate,type Instrument} from './model.js';
export const SCREEN_URLS={chartink:'https://chartink.com/screener/short-term-breakouts',screener:'https://www.screener.in/screens/803777/near-breakout-stocks-in-uptrend/'} as const;
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const candidate=z.object({symbol:z.string().regex(/^[A-Z0-9&-]+$/),source:z.enum(['chartink','screener','custom']),sourceUrl:z.string().url()});
const schema=z.object({sessionDate:z.string().refine(validDate),frozenAt:z.string().datetime({offset:true}),candidates:z.array(candidate).max(100),accepted:z.array(z.object({symbol:z.string(),securityId:z.string().regex(/^\d+$/),sources:z.array(z.enum(['chartink','screener','custom'])),medianObservedTurnover:z.number(),medianObservedVolume:z.number()})).max(20),rejected:z.array(z.object({symbol:z.string(),reason:z.string()})),sources:z.array(z.object({source:z.string(),url:z.string(),fetchedAt:z.string(),status:z.string(),contentHash:z.string()})),policy:z.string(),snapshotHash:z.string()});
export type Watchlists=z.infer<typeof schema>;
export async function loadWatchlists(date:string,items:Instrument[],path:string|undefined):Promise<{snapshot:Watchlists|null;instruments:Instrument[];error:string|null}>{
 if(!path)return {snapshot:null,instruments:[],error:null};
 try{const w=schema.parse(JSON.parse(await readFile(path.replace('{date}',date),'utf8')));
  if(w.sessionDate!==date||Date.parse(w.frozenAt)>at(date,'09:05')||Date.parse(w.frozenAt)>Date.now()||new Set(w.accepted.map(i=>i.symbol)).size!==w.accepted.length||hash({...w,snapshotHash:undefined})!==w.snapshotHash)throw Error();
  const instruments=w.accepted.map(c=>{const matches=items.filter(i=>i.symbol===c.symbol&&i.securityId===c.securityId&&i.exchangeSegment==='NSE_EQ'&&i.instrument==='EQUITY');if(matches.length!==1)throw Error();return matches[0]!;});
  if(new Set(instruments.map(i=>i.securityId)).size!==instruments.length)throw Error();
  return {snapshot:w,instruments,error:null};
 }catch{return {snapshot:null,instruments:[],error:'WATCHLIST_SNAPSHOT_MISSING_INVALID_OR_NOT_FROZEN_BEFORE_SESSION'};}
}
const decode=(s:string)=>s.replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
export function parseScreener(html:string){
 const table=html.match(/<table[^>]*class=["'][^"']*data-table[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
 if(!table)throw Error('WATCHLIST_SOURCE_SCHEMA_CHANGED');
 return [...new Set([...table.matchAll(/href=["']\/company\/([A-Z0-9&-]+)\/[^"']*["']/g)].map(m=>decode(m[1]!)).filter(s=>!/^\d+$/.test(s)))];
}
export function chartinkDefinition(html:string){
 const match=html.match(/:scan-json="([^"]+)"/);if(!match)throw Error('WATCHLIST_SOURCE_SCHEMA_CHANGED');
 const scan=JSON.parse(decode(match[1]!));if(scan.slug!=='short-term-breakouts'||scan.is_private||typeof scan.atlas_query!=='string')throw Error('WATCHLIST_SOURCE_SCHEMA_CHANGED');return scan.atlas_query as string;
}
export async function fetchScreens(fetcher:typeof fetch=fetch){
 const candidates:{symbol:string;source:'chartink'|'screener';sourceUrl:string}[]=[],sources:Watchlists['sources']=[];
 for(const source of ['chartink','screener'] as const){const url=SCREEN_URLS[source];let content='';
  try{const page=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!page.ok)throw Error();content=await page.text();let symbols:string[];
   if(source==='screener')symbols=parseScreener(content);
   else{const query=chartinkDefinition(content),csrf=content.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];if(!csrf)throw Error();
    const cookies=page.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const response=await fetcher('https://chartink.com/screener/process',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-TOKEN':csrf,'X-Requested-With':'XMLHttpRequest',Cookie:cookies,Referer:url},body:new URLSearchParams({scan_clause:query})});
    if(!response.ok)throw Error();const raw=await response.json() as {data?:{nsecode?:string}[]};if(!Array.isArray(raw.data))throw Error();symbols=raw.data.map(r=>r.nsecode??'');content=JSON.stringify({query,symbols});
   }
   if(symbols.some(s=>!s||!/^[A-Z0-9&-]+$/.test(s)))throw Error();for(const symbol of symbols)candidates.push({symbol,source,sourceUrl:url});
   sources.push({source,url,fetchedAt:new Date().toISOString(),status:'fetched',contentHash:hash(content)});
  }catch{sources.push({source,url,fetchedAt:new Date().toISOString(),status:'unavailable',contentHash:hash(content)});}
 }
 return {candidates,sources};
}
