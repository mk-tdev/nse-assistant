// Developer-only loopback validation. Loads the inherited Postman fixture without needing its CLI.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createServer,type Server} from 'node:http';
import {spawn} from 'node:child_process';
const source=(await readFile('postman/mocks/dhan-data/default.js','utf8')).replace("server.listen(PORT, '127.0.0.1');",'globalThis.fixtureServer=server;');
const sandbox:{fixtureServer?:Server;require:NodeRequire;process:unknown;URL:typeof URL}={require:createRequire(import.meta.url),process:{env:{}},URL};
runInNewContext(source,sandbox);const fixture=sandbox.fixtureServer!;
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const address=fixture.address();if(!address||typeof address==='string')throw new Error('FIXTURE_ADDRESS');
const proxy=createServer(async(req,res)=>{try{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const upstream=await fetch(`http://127.0.0.1:${address.port}${(req.url??'').replace(/^\/dhan/,'')}`,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k,v])=>k!=='host'&&typeof v==='string')) as Record<string,string>,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
 res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'text/plain'});res.end(Buffer.from(await upstream.arrayBuffer()));
 }catch{res.writeHead(502);res.end();}});
try {
 await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(4900,'127.0.0.1',resolve);});
 for(const file of ['test/http-simulation.ts','test/recorder-http-simulation.ts']) {
  const child=spawn(process.execPath,['--import','tsx',file],{stdio:'inherit',env:{PATH:process.env.PATH}});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw new Error(`FIXTURE_FAILED/${file}`);
 }
}finally {proxy.closeAllConnections();fixture.closeAllConnections();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>fixture.close(()=>resolve()))]);}
