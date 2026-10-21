import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marketSessionDecision} from '../src/market-session.js';
import {reportServer} from '../src/report-server.js';
import {at} from '../src/model.js';
test('cloud schedule uses IST, skips holidays/weekends, and limits collection to market window',async()=>{
 const calendar=JSON.parse(await readFile('deploy/lightsail/calendar-2026.json','utf8'));
 assert.equal(marketSessionDecision(calendar,at('2026-10-21','09:04')).run,false);
 assert.equal(marketSessionDecision(calendar,at('2026-10-21','09:05')).run,true);
 assert.equal(marketSessionDecision(calendar,at('2026-10-21','15:34')).run,true);
 assert.equal(marketSessionDecision(calendar,at('2026-10-21','15:35')).run,false);
 assert.equal(marketSessionDecision(calendar,at('2026-11-10','10:00')).reason,'not_scheduled_regular_session');
 assert.equal(marketSessionDecision(calendar,at('2026-11-08','10:00')).run,false);
 assert.equal(marketSessionDecision(calendar,at('2027-01-04','10:00')).reason,'calendar_out_of_coverage');
});
test('quality report service serves only reports and refuses writes or filesystem traversal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nse-reports-'));
 const server=reportServer(dir);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(base+'/api/latest')).status,404);
  await writeFile(join(dir,'2026-10-21.json'),JSON.stringify({sessionDate:'2026-10-21',mode:'mock',observedAt:'2026-10-21T04:00:00Z'}));
  const r=await fetch(base+'/api/latest');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).sessionDate,'2026-10-21');
  assert.equal((await fetch(base+'/api/latest',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/candles.sqlite')).status,404);
  assert.equal((await fetch(base+'/etc/passwd')).status,404);
  assert.match(await (await fetch(base+'/')).text(),/Check observedAt/);
  assert.ok((await fetch(base+'/')).headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(dir,{recursive:true,force:true});}
});
test('private paper API exposes simulated state and provenance with no new listener or file routes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nse-paper-report-')),server=reportServer(dir);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 try{
  const paper={mode:'strict',simulatedOnly:true,exactQualification:false,observedAt:'2026-10-21T04:00:00Z',states:[{status:'blocked',reasons:['timestamp_aligned_exact_session_vwap_unavailable']}],events:[]};
  await writeFile(join(dir,'2026-10-21.paper.json'),JSON.stringify(paper));
  const response=await fetch(base+'/api/paper');assert.equal(response.status,200);assert.deepEqual(await response.json(),paper);
  assert.equal((await fetch(base+'/api/paper',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/paper.sqlite')).status,404);
  assert.match(await(await fetch(base+'/')).text(),/Simulated paper decisions and positions/);
  assert.match(await(await fetch(base+'/report.js')).text(),/textContent/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
