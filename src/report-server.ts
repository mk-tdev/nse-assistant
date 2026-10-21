import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NSE recorder quality</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#14302b;background:#f7faf8}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:#e8f0ec;border-radius:12px}small{color:#45625c}</style><h1>NSE recorder · quality reports</h1><p>Read-only observation coverage. No order execution or strategy signals.</p><small>Refreshes every 30 seconds. Check observedAt and sessionDate: an old report is not current health. Calendar and timestamp verification remain separate.</small><pre id="report">Loading…</pre><script src="/report.js"></script></html>`;
const script=`async function refresh(){try{const r=await fetch('/api/latest',{cache:'no-store'});document.getElementById('report').textContent=r.ok?JSON.stringify(await r.json(),null,2):'No report available yet. The recorder may be waiting for its first scheduled run.';}catch{document.getElementById('report').textContent='Report service unavailable. Do not treat the last report as current.';}}refresh();setInterval(refresh,30000);`;
export function reportServer(dir:string){
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  try{
   const path=new URL(req.url??'/', 'http://localhost').pathname;
   if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
   if(path==='/report.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(script);return;}
   if(path==='/api/latest'){
    const files=(await readdir(dir)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
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
