import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {PaperLedger,paperDefaults} from '../src/paper.js';
import {at} from '../src/model.js';
test('read-only assistant audit export includes immutable observations, baseline refresh provenance and blocked decisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nse-export-'));try{
  const path=join(dir,'paper.sqlite'),date='2026-10-22',l=new PaperLedger(path,paperDefaults({source:'synthetic',coverageFrom:'2026-10-21',coverageTo:date,sessions:['2026-10-21',date],independentlyVerified:false}));
  const c={start:at('2026-10-21','09:30'),open:100,high:102,low:99,close:101,volume:100};
  l.observe('TCS',{candle:c,source:'legacy execution observation',sourceTime:c.start+300000,observedAt:at('2026-10-21','09:35'),issues:['recorder_batch_provenance_unavailable']});
  l.observeBaseline(date,'TCS',{candle:c,source:'synthetic historical baseline refresh',sourceTime:c.start+300000,observedAt:at(date,'09:05'),issues:[]});l.tick('TCS',date,at(date,'09:35'));l.close();
  const result=spawnSync(process.execPath,['--import','tsx','src/paper-export.ts',path],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(result.status,0,result.stderr);const audit=JSON.parse(result.stdout);
  assert.equal(audit.exactQualification,false);assert.equal(audit.states[0].status,'blocked');assert.equal(audit.baselines.length,1);assert.equal(audit.observations.length,1);assert.match(audit.observations[0].body,/legacy execution/);assert.ok(audit.events.length);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
