import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Reviewer,requestReview} from '../src/reviewer.js';
import type {RecoveryCase} from '../src/recovery.js';
import {at} from '../src/model.js';
const date='2026-10-21',env={OPENAI_REVIEW_ENABLED:'true',OPENAI_API_KEY:'synthetic',OPENAI_REVIEW_MODEL:'gpt-5.6-luna',OPENAI_REVIEW_REASONING_EFFORT:'low'};
const item=(id:string):RecoveryCase=>({id,symbol:'TCS',gapStart:at(date,'09:30'),positionId:null,mark:null,actionOptions:['block_new_entries','wait_recovery'],evidence:[{id:'gap',kind:'missing',body:{available:false}}]});
const answer:typeof fetch=async(url,init)=>{const b=JSON.parse(String(init!.body));const cases=JSON.parse(b.input).cases as RecoveryCase[];return new Response(JSON.stringify({status:'completed',usage:{input_tokens:300,output_tokens:150,output_tokens_details:{reasoning_tokens:40}},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reviews:cases.map(c=>({caseId:c.id,action:'block_new_entries',reason:'Missing required candle; wait for validated data.',evidenceIds:['gap']}))})}]}]}));};
test('reasoning reviewer pins low effort, standard billing tier, bounded reasoning/output and no tools',async()=>{
 const fetcher:typeof fetch=async(url,init)=>{const b=JSON.parse(String(init!.body));assert.equal(b.model,'gpt-5.6-luna');assert.deepEqual(b.reasoning,{effort:'low'});assert.equal(b.service_tier,'default');assert.equal(b.max_output_tokens,4096);assert.equal(b.store,false);assert.equal(b.tools,undefined);assert.ok(Buffer.byteLength(String(init!.body))<=24000);return answer(url,init);};
 const r=await requestReview([item('one')],env,fetcher);assert.equal(r.decisions.length,1);
 await assert.rejects(()=>requestReview([item('x')],{...env,OPENAI_REVIEW_MODEL:'unpriced-model'},fetcher),/UNPRICED_MODEL/);
 await assert.rejects(()=>requestReview([item('x')],{...env,OPENAI_REVIEW_REASONING_EFFORT:'high'},fetcher),/UNSUPPORTED_EFFORT/);
});
test('atomic shared dollar budget survives restart and spans different simulated sessions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-dollar-')),path=join(dir,'budget.sqlite');let calls=0;const fetcher:typeof fetch=async(...args)=>{calls++;return answer(...args);};const a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:');let actualNow=at(date,'11:00');const e={...env,OPENAI_REVIEW_BUDGET_PATH:path};
 let r=new Reviewer(a,'2026-10-16',()=>{},()=>at('2026-10-16','10:00'),e,fetcher,()=>actualNow);
 try{for(let i=0;i<20;i++){r.submit([item('first'+i)]);await r.drain();}assert.equal(r.snapshot().budget.reservedUsd,.5);await r.close();
  r=new Reviewer(b,'2026-10-19',()=>{},()=>at('2026-10-19','10:00'),e,fetcher,()=>actualNow);
  for(let i=0;i<20;i++){r.submit([item('second'+i)]);await r.drain();}assert.equal(calls,40);assert.equal(r.snapshot().budget.day,date);assert.equal(r.snapshot().budget.reservedUsd,1);assert.equal(r.snapshot().budget.remainingUsd,0);assert.equal(r.snapshot().budget.exhausted,true);
  r.submit([item('blocked')]);await r.drain();assert.equal(calls,40);assert.match(r.snapshot().lastBlock!,/budget/);
  actualNow+=86400000;r.submit([item('next-day')]);await r.drain();assert.equal(calls,41);assert.equal(r.snapshot().budget.day,'2026-10-22');assert.equal(r.snapshot().budget.reservedUsd,.025);
 }finally{await r.close();a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('timeouts and interrupted requests keep their full reservation; oversized requests never reach API',async()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('simulated uncertain transport failure');};let r=new Reviewer(db,date,()=>{},()=>at(date,'11:00'),{...env,OPENAI_REVIEW_DAILY_BUDGET_USD:'.05'},fetcher,()=>at(date,'11:00'));
 r.submit([item('failed-one')]);await r.drain();assert.equal(r.snapshot().budget.reservedUsd,.025);
 r=new Reviewer(db,date,()=>{},()=>at(date,'11:00'),{...env,OPENAI_REVIEW_DAILY_BUDGET_USD:'.05'},fetcher,()=>at(date,'11:00'));r.submit([item('failed-two')]);await r.drain();r.submit([item('third')]);assert.equal(calls,2);assert.equal(r.snapshot().budget.exhausted,true);
 const big=item('huge');big.evidence[0]!.body={data:'x'.repeat(30000)};r.submit([big]);assert.equal(calls,2);assert.equal(r.snapshot().budget.reservedUsd,.05);assert.equal(r.snapshot().lastBlock,'invalid_model_or_oversized_input');db.close();
});
test('two independent reviewer handles cannot overspend their shared daily allowance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-atomic-')),path=join(dir,'budget.sqlite'),a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:');let release!:()=>void;const pending=new Promise<void>(r=>{release=r;});let calls=0;const fetcher:typeof fetch=async(...args)=>{calls++;await pending;return answer(...args);};const e={...env,OPENAI_REVIEW_BUDGET_PATH:path,OPENAI_REVIEW_DAILY_BUDGET_USD:'.025'};
 const x=new Reviewer(a,'sessionA',()=>{},Date.now,e,fetcher,()=>at(date,'11:00')),y=new Reviewer(b,'sessionB',()=>{},Date.now,e,fetcher,()=>at(date,'11:00'));
 try{x.submit([item('a')]);y.submit([item('b')]);assert.equal(calls,1);assert.equal(y.snapshot().budget.reservedUsd,.025);release();await x.drain();assert.equal(y.snapshot().budget.remainingUsd,0);}finally{await x.close();await y.close();a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('budget settings cannot silently raise the user-authorized one-dollar ceiling',()=>{
 const db=new DatabaseSync(':memory:');for(const value of ['1.01','-1','NaN'])assert.throws(()=>new Reviewer(db,date,()=>{},Date.now,{...env,OPENAI_REVIEW_DAILY_BUDGET_USD:value}),/INVALID_DAILY_BUDGET/);db.close();
});
