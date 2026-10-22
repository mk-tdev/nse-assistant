import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dashboardHtml as page,dashboardCss,dashboardJs as script} from './dashboard-assets.js';
import {dashboardData,chartCandles} from './dashboard-data.js';
export function reportServer(dir:string){
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  try{
   const url=new URL(req.url??'/', 'http://localhost'),path=url.pathname;
   const json=(value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
   if(path==='/dashboard.css'){res.setHeader('Content-Type','text/css; charset=utf-8');res.end(dashboardCss);return;}
   if(path==='/api/dashboard'){const session=url.searchParams.get('session');if(session&&!/^\d{4}-\d{2}-\d{2}$/.test(session)){res.writeHead(400);res.end();return;}const value=await dashboardData(dir,session??undefined);if(!value){res.writeHead(404);res.end();return;}json(value);return;}
   if(path==='/api/candles'){const session=url.searchParams.get('session')??'',symbol=url.searchParams.get('symbol')??'';if(!/^\d{4}-\d{2}-\d{2}$/.test(session)||!/^[A-Z0-9&_.-]{1,32}$/.test(symbol)){res.writeHead(400);res.end();return;}json(chartCandles(dir,session,symbol));return;}
   if(path==='/api/quotes'){json(JSON.parse(await readFile(join(dir,'quotes.json'),'utf8')));return;}
   if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
   if(path==='/report.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(script);return;}
   if(path==='/api/latest'||path==='/api/paper'){
    const pattern=path==='/api/paper'?/^\d{4}-\d{2}-\d{2}\.paper\.json$/:/^\d{4}-\d{2}-\d{2}\.json$/;
    const files=(await readdir(dir)).filter(f=>pattern.test(f)).sort();
    if(!files.length){res.writeHead(404);res.end();return;}
    const report=JSON.parse(await readFile(join(dir,files[files.length-1]!),'utf8'));
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(report));return;
   }
   res.writeHead(404);res.end();
  }catch{res.writeHead(503);res.end('Report unavailable');}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.PORT??8787),host=process.env.REPORT_BIND??'127.0.0.1';
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_REPORT_PORT');
 reportServer(process.env.RECORDER_DATA_DIR??'.local/recorder/live').listen(port,host,()=>console.log('Read-only quality report service listening'));
}
