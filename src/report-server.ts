import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {dashboardHtml as page,dashboardCss,dashboardJs as script} from './dashboard-assets.js';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ControlStore,exitSchema,entrySchema} from './paper-control-store.js';
import {exitTargets} from './paper-console.js';
import {enrichPortfolio} from './dashboard-portfolio.js';
import {day} from './model.js';
import {dashboardData,chartCandles} from './dashboard-data.js';
export function reportServer(dir:string,options:{controlDir?:string;origin?:string}={}){
 const control=options.controlDir?new ControlStore(options.controlDir):undefined,csrf=randomBytes(32).toString('hex');
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");

  try{
   const url=new URL(req.url??'/', 'http://localhost'),path=url.pathname;
   const json=(value:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
   if(req.method==='POST'&&control&&['/api/paper/exit','/api/paper/entry'].includes(path)){
    const supplied=Buffer.from(String(req.headers['x-paper-csrf']??'')),expected=Buffer.from(csrf);
    if(req.headers.origin!==options.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||req.headers['content-type']!=='application/json'){res.statusCode=403;json({error:'PAPER_CONTROL_ORIGIN_OR_CSRF_REJECTED'});return;}
    let body='';for await(const chunk of req){body+=String(chunk);if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return;}}
    try{
     const health=JSON.parse(await readFile(join(options.controlDir!,'health.json'),'utf8'));if(Date.now()-Date.parse(health.observedAt)>20000)throw Error('PAPER_WORKER_OFFLINE');
     const raw=JSON.parse(body);let command;
     if(path==='/api/paper/exit'){const input=exitSchema.parse(raw);if(input.session!==day(Date.now())){res.statusCode=409;json({error:'Select the current IST session for paper controls'});return;}const targets=exitTargets(dir,control,input);command=control.enqueue(input.requestId,'exit',{input,targets});}
     else{const input=entrySchema.parse(raw);command=control.enqueue(input.requestId,'entry',input);}
     res.statusCode=202;json(command);return;
    }catch(e){res.statusCode=e instanceof Error&&e.message==='PAPER_WORKER_OFFLINE'?503:400;json({error:e instanceof Error&&e.message==='PAPER_WORKER_OFFLINE'?'Paper execution worker unavailable':'Invalid or conflicting paper request'});return;}
   }
   if(req.method!=='GET'){res.writeHead(405);res.end();return;}
   if(path==='/api/control-session'){let healthy=false;if(control)try{const h=JSON.parse(await readFile(join(options.controlDir!,'health.json'),'utf8'));healthy=Date.now()-Date.parse(h.observedAt)<=20000;}catch{}json({enabled:Boolean(control),healthy,csrf:control?csrf:null,paperOnly:true});return;}
   if(path==='/api/paper/command'&&control){const id=url.searchParams.get('id')??'';if(!/^[a-f0-9-]{36}$/.test(id)){res.writeHead(400);res.end();return;}const result=control.get(id);if(!result){res.writeHead(404);res.end();return;}json(result);return;}
   if(path==='/dashboard.css'){res.setHeader('Content-Type','text/css; charset=utf-8');res.end(dashboardCss);return;}
   if(path==='/api/dashboard'){const session=url.searchParams.get('session');if(session&&!/^\d{4}-\d{2}-\d{2}$/.test(session)){res.writeHead(400);res.end();return;}const value=await dashboardData(dir,session??undefined);if(!value){res.writeHead(404);res.end();return;}json(await enrichPortfolio(dir,value,control));return;}
   if(path==='/api/candles'){const session=url.searchParams.get('session')??'',symbol=url.searchParams.get('symbol')??'';if(!/^\d{4}-\d{2}-\d{2}$/.test(session)||!/^[A-Z0-9&_.-]{1,32}$/.test(symbol)){res.writeHead(400);res.end();return;}if(symbol.startsWith('GOLDM-')||symbol.startsWith('SILVERM-')){const c=JSON.parse(await readFile(join(dir,'commodities.json'),'utf8'));json({session,symbol,candles:c.sessionDate===session?c.candles?.[symbol]??[]:[],intervalMinutes:5,sessionOpen:'09:00',sessionClose:'23:30',policy:'MCX futures; provisional candle-start labels'});}else json(chartCandles(dir,session,symbol));return;}
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
 server.on('close',()=>control?.close());return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.PORT??8787),host=process.env.REPORT_BIND??'127.0.0.1';
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_REPORT_PORT');
 reportServer(process.env.RECORDER_DATA_DIR??'.local/recorder/live',{controlDir:process.env.PAPER_CONTROL_DIR,origin:process.env.DASHBOARD_ORIGIN??'https://nse-assistant.pixeltrendanalytics.com'}).listen(port,host,()=>console.log('Read-only quality report service listening'));
}
