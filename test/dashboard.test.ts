import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportServer} from '../src/report-server.js';
import {CandleStore} from '../src/recorder.js';
import {at} from '../src/model.js';
test('dashboard uses atomic selected-session report and bound read-only candle queries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nse-dashboard-')),store=new CandleStore(join(dir,'candles.sqlite'));
 const inst={symbol:'TCS',securityId:'11536',name:'TCS',exchangeSegment:'NSE_EQ' as const,instrument:'EQUITY' as const};
 const c={start:at('2026-10-21','09:15'),open:100,high:102,low:99,close:101,volume:100};
 store.save('2026-10-21',inst,[c],at('2026-10-21','09:21'));
 await writeFile(join(dir,'2026-10-21.json'),JSON.stringify({sessionDate:'2026-10-21',paper:{states:[{symbol:'TCS',entry:100}]}}));
 await writeFile(join(dir,'2026-10-22.json'),JSON.stringify({sessionDate:'2026-10-22',paper:{states:[]}}));
 const server=reportServer(dir);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');const base='http://127.0.0.1:'+a.port;
 try{
  const latest=await(await fetch(base+'/api/dashboard')).json();assert.equal(latest.selectedSession,'2026-10-22');assert.equal(latest.policy.realOrders,false);
  const selected=await(await fetch(base+'/api/dashboard?session=2026-10-21')).json();assert.equal(selected.report.paper.states[0].entry,100);
  const chart=await(await fetch(base+'/api/candles?session=2026-10-21&symbol=TCS')).json();assert.equal(chart.candles.length,1);assert.equal(chart.candles[0].close,101);
  assert.equal((await fetch(base+'/api/candles?session=2026-10-21&symbol=TCS%27%20OR%201=1')).status,400);
  assert.equal((await fetch(base+'/api/dashboard?session=../../etc')).status,400);
  assert.equal((await fetch(base+'/api/dashboard?session=2026-10-19')).status,404);
  assert.equal((await fetch(base+'/api/candles',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/reviewer-budget.sqlite')).status,404);
  assert.match(await(await fetch(base+'/dashboard.css')).text(),/--cyan/);
  assert.match(await(await fetch(base+'/')).text(),/PAPER ONLY/);
  assert.equal(store.candles('2026-10-21','11536').length,1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();await rm(dir,{recursive:true,force:true});}
});
