import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const args=['--import','tsx','src/record.ts','--mock','--once','--date','2026-10-21'];
test('persistent singleton prevents duplicate collectors and permits restart after kernel lock release',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nse-lock-')),db=new DatabaseSync(join(dir,'collector-lock.sqlite'));
 try {
  db.exec('CREATE TABLE singleton(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
  const env={PATH:process.env.PATH,PAPER_ENABLED:'false'};
  const blocked=spawnSync(process.execPath,[...args,'--data-dir',dir],{encoding:'utf8',env});assert.equal(blocked.status,1);assert.match(blocked.stderr,/RECORDER_LOCKED_OR_UNWRITABLE/);
  db.exec('ROLLBACK');db.close();
  const restarted=spawnSync(process.execPath,[...args,'--data-dir',dir],{encoding:'utf8',env});assert.equal(restarted.status,0,restarted.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir,'2026-10-21.json'),'utf8')).instruments[0].storedCandles,9);
 }finally{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('invalid paper configuration is visible without stopping recorder persistence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nse-paper-config-'));try{
  const child=spawnSync(process.execPath,[...args,'--data-dir',dir],{encoding:'utf8',env:{PATH:process.env.PATH,PAPER_ENABLED:'true',PAPER_CALENDAR_PATH:join(dir,'absent.json')}});
  assert.equal(child.status,0,child.stderr);const report=JSON.parse(readFileSync(join(dir,'2026-10-21.json'),'utf8'));
  assert.equal(report.instruments[0].storedCandles,9);assert.equal(report.paper.status,'blocked');assert.deepEqual(report.paper.errors,['PAPER_CONFIGURATION_OR_STORAGE_FAILED']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('deployment keeps one recorder service and mounts persistent storage while exposing reports only on loopback',()=>{
 const service=readFileSync('deploy/lightsail/nse-recorder.service','utf8'),reports=readFileSync('deploy/lightsail/nse-reports.service','utf8'),docker=readFileSync('deploy/lightsail/Dockerfile','utf8');
 assert.match(service,/flock -n/);assert.match(service,/paper\.env/);assert.match(service,/source=\/var\/lib\/nse-recorder,target=\/data/);
 assert.match(reports,/--publish 127\.0\.0\.1:8787:8787/);assert.match(reports,/target=\/data,readonly/);assert.match(docker,/COPY deploy\/lightsail\/\*\.json/);
 assert.match(readFileSync('.dockerignore','utf8'),/!deploy\/lightsail\/calendar-paper-2026\.json/);
});
