import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {reportServer} from '../src/report-server.js';
import {ControlStore} from '../src/paper-control-store.js';

test('custom watchlist GET reports unavailable without a control directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nse-watchlist-nocontrol-'));
 const server=reportServer(dir);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const base='http://127.0.0.1:'+a.port;
 try{assert.deepEqual(await(await fetch(base+'/api/watchlist/custom')).json(),{enabled:false,pending:null,lastResult:null});}
 finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('custom watchlist submissions require Origin/CSRF and schema validation, queue even while the paper worker is offline, and the latest submission is what GET reports',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nse-watchlist-api-')),data=join(root,'data'),controls=join(root,'controls');
 await Promise.all([mkdir(data),mkdir(controls)]);
 // Deliberately no controls/health.json: the live worker is offline, unlike the lab/paper endpoints this must still queue.
 const server=reportServer(data,{controlDir:controls,origin:'https://example.test'});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const base='http://127.0.0.1:'+a.port;
 try{
  const auth=await(await fetch(base+'/api/watchlist/custom')).json();assert.equal(auth.enabled,true);assert.equal(auth.pending,null);
  const session=await(await fetch(base+'/api/control-session')).json();
  const send=(body:unknown,origin='https://example.test',csrf=session.csrf)=>fetch(base+'/api/watchlist/custom',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Paper-CSRF':csrf},body:JSON.stringify(body)});
  const requestId=randomUUID();
  assert.equal((await send({requestId,symbols:['RELIANCE']},'https://evil.test')).status,403);
  assert.equal((await send({requestId,symbols:['RELIANCE']},'https://example.test','wrong')).status,403);
  assert.equal((await send({requestId,symbols:[]})).status,400);
  assert.equal((await send({requestId,symbols:['not a symbol']})).status,400);
  assert.equal((await send({requestId,symbols:Array.from({length:21},(_,i)=>'SYM'+i)})).status,400);
  assert.equal((await send({requestId,symbols:['RELIANCE','TCS']})).status,202);
  const first=await(await fetch(base+'/api/watchlist/custom')).json();
  assert.deepEqual(first.pending.symbols,['RELIANCE','TCS']);
  const queue=new ControlStore(controls);try{assert.equal(queue.pending(['custom-watchlist-update']).length,1);}finally{queue.close();}
  const second=randomUUID();assert.equal((await send({requestId:second,symbols:['INFY']})).status,202);
  const latest=await(await fetch(base+'/api/watchlist/custom')).json();
  assert.deepEqual(latest.pending.symbols,['INFY'],'GET must reflect the most recently queued submission');
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
