import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {day} from './model.js';
import {REVIEW_RESERVATION_MICRO_USD,settings} from './reviewer.js';
export class AgentStore{
 readonly db:DatabaseSync;readonly budget:DatabaseSync;
 constructor(readonly dir:string,readonly env:NodeJS.ProcessEnv=process.env){mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'agent.sqlite'));chmodSync(join(dir,'agent.sqlite'),0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS agent_calls(id TEXT PRIMARY KEY,session TEXT,mode TEXT,started_at INTEGER,status TEXT,input_json TEXT,output_json TEXT,error TEXT);
 CREATE TABLE IF NOT EXISTS agent_decisions(id TEXT PRIMARY KEY,call_id TEXT,session TEXT,symbol TEXT,candidate_id TEXT,observed_at INTEGER,body TEXT);
 CREATE TABLE IF NOT EXISTS agent_news(id TEXT PRIMARY KEY,published_at TEXT,first_seen_at TEXT,body TEXT);
 CREATE TABLE IF NOT EXISTS agent_context(id TEXT PRIMARY KEY,session TEXT,observed_at INTEGER,body TEXT);`);
 if(!env.OPENAI_REVIEW_BUDGET_PATH)throw Error('AGENT_SHARED_BUDGET_REQUIRED');this.budget=new DatabaseSync(env.OPENAI_REVIEW_BUDGET_PATH);this.budget.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS llm_budget_reservations(id TEXT PRIMARY KEY,budget_day TEXT NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,reserved_micro_usd INTEGER NOT NULL,status TEXT NOT NULL,usage_json TEXT);`);chmodSync(env.OPENAI_REVIEW_BUDGET_PATH,0o600);
 this.db.prepare("UPDATE agent_calls SET status='interrupted',error='Process restarted; pending opinions cannot authorize entries' WHERE status='pending'").run();
 }
 close(){this.db.close();this.budget.close();}
 budgetStatus(now=Date.now()){const used=Number(this.budget.prepare('SELECT COALESCE(SUM(reserved_micro_usd),0) AS n FROM llm_budget_reservations WHERE budget_day=?').get(day(now))!.n);return {day:day(now),timeZone:'Asia/Kolkata',dailyLimitUsd:3,reservedUsd:used/1e6,remainingUsd:Math.max(0,3-used/1e6),exhausted:used+REVIEW_RESERVATION_MICRO_USD>3e6,scope:'Shared with the recovery reviewer; conservative reservations, not billed cost. Failed and uncertain calls keep their reservation.'};}
 reserve(input:unknown,session:string,mode:string,now=Date.now()){
 const model=settings(this.env).model,id='agent/'+randomUUID();this.budget.exec('BEGIN IMMEDIATE');try{if(this.budgetStatus(now).exhausted){this.budget.exec('COMMIT');return null;}this.budget.prepare("INSERT INTO llm_budget_reservations VALUES(?,?,?,?,?,'reserved',NULL)").run(id,day(now),session,model,REVIEW_RESERVATION_MICRO_USD);this.budget.exec('COMMIT');}catch(e){this.budget.exec('ROLLBACK');throw e;}
 this.db.prepare("INSERT INTO agent_calls VALUES(?,?,?,?,'pending',?,NULL,NULL)").run(id,session,mode,now,JSON.stringify(input));return id;
 }
 complete(id:string,output:unknown,usage:unknown){this.db.prepare("UPDATE agent_calls SET status='completed',output_json=? WHERE id=?").run(JSON.stringify(output),id);this.budget.prepare("UPDATE llm_budget_reservations SET status='completed',usage_json=? WHERE id=?").run(JSON.stringify(usage??null),id);}
 fail(id:string,error:string){this.db.prepare("UPDATE agent_calls SET status='failed',error=? WHERE id=?").run(error,id);this.budget.prepare("UPDATE llm_budget_reservations SET status='failed_or_uncertain' WHERE id=?").run(id);}
 context(session:string,body:unknown,now=Date.now()){this.db.prepare('INSERT INTO agent_context VALUES(?,?,?,?)').run(randomUUID(),session,now,JSON.stringify(body));}
}
