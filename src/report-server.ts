import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NSE quality and simulated paper ledger</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#14302b;background:#f7faf8}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:#e8f0ec;border-radius:12px}small{color:#45625c}</style><h1>NSE recorder · quality and paper ledger</h1><p>Read-only observation coverage and simulated-only positions. Exact qualification remains gated; no broker orders.</p><small>Refreshes every 30 seconds. Check observedAt and sessionDate: an old report is not current health. Calendar and timestamp verification remain separate.</small><h2>Session quality</h2><pre id="report">Loading…</pre><h2>Stock scanner</h2><pre id="scanner">Waiting for the next session…</pre><h2>Simulated paper decisions and positions</h2><p id="paper-status">Loading…</p><pre id="paper">Loading…</pre><script src="/report.js"></script></html>`;
const script=`async function refresh(){try{const r=await fetch('/api/latest',{cache:'no-store'});const q=r.ok?await r.json():null;document.getElementById('report').textContent=q?JSON.stringify({...q,paper:undefined},null,2):'No report available yet. The recorder may be waiting for its first scheduled run.';const p=await fetch('/api/paper',{cache:'no-store'});const data=p.ok?await p.json():q?.paper;document.getElementById('paper-status').textContent=data?'SIMULATED ONLY · '+(data.mode??'blocked')+' · observed '+data.observedAt+' · exact qualification: unavailable':'No paper report available. Check worker configuration.';document.getElementById('scanner').textContent=data?.scanner?JSON.stringify(data.scanner,null,2):'No scanner report yet.';document.getElementById('paper').textContent=data?JSON.stringify(data,null,2):'No paper report.';}catch{document.getElementById('report').textContent='Report service unavailable. Do not treat the last report as current.';document.getElementById('scanner').textContent='Unavailable — no current scanner health';document.getElementById('paper-status').textContent='Unavailable — no current health claim';}}refresh();setInterval(refresh,30000);`;
export function reportServer(dir:string){
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  try{
   const path=new URL(req.url??'/', 'http://localhost').pathname;
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
