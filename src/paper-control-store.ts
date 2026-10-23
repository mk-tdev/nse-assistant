import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {labStrategies} from './strategy-registry.js';
import {validDate} from './model.js';
export const cohortFiles={baseline:'paper.sqlite','screener-orb':'paper-screener-orb.sqlite','range-hold':'paper-range-hold.sqlite','range-failure-exit':'paper-range-failure-exit.sqlite','agent-recovery':'paper-agent-recovery.sqlite'} as const;
export const exitSchema=z.object({requestId:z.string().uuid(),session:z.string().refine(validDate),scope:z.enum(['position','cohort','all']),cohort:z.string().refine(id=>['baseline','screener-orb','range-hold','range-failure-exit','agent-recovery','mcx-manual',...labStrategies.map(s=>s.id)].includes(id)).optional(),positionId:z.string().min(1).max(240).optional()}).strict().refine(x=>x.scope==='all'||Boolean(x.cohort)).refine(x=>x.scope!=='position'||Boolean(x.positionId));
export const entrySchema=z.object({requestId:z.string().uuid(),contractId:z.string().regex(/^\d+$/),lots:z.number().int().min(1).max(10),side:z.enum(['long','short'])}).strict();
export const customWatchlistSchema=z.object({requestId:z.string().uuid(),symbols:z.array(z.string().regex(/^[A-Z0-9&-]+$/)).min(1).max(20).refine(xs=>new Set(xs).size===xs.length)}).strict();
export class ControlStore{
 readonly db:DatabaseSync;
 constructor(dir:string){mkdirSync(dir,{recursive:true,mode:0o700});this.db=new DatabaseSync(join(dir,'console.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
 CREATE TABLE IF NOT EXISTS manual_positions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS manual_events(id TEXT PRIMARY KEY,observed_at INTEGER NOT NULL,body TEXT NOT NULL);
 `);}
 close(){this.db.close();}
 enqueue(id:string,kind:string,body:unknown,now=Date.now()){
 const text=JSON.stringify(body);this.db.exec('BEGIN IMMEDIATE');try{const old=this.db.prepare('SELECT kind,body FROM commands WHERE id=?').get(id);if(old&&(old.kind!==kind||JSON.stringify(JSON.parse(String(old.body)).input??JSON.parse(String(old.body)))!==JSON.stringify((body as any).input??body)))throw Error('IDEMPOTENCY_KEY_REUSED');this.db.prepare("INSERT OR IGNORE INTO commands VALUES(?,?,?,?,'pending',NULL)").run(id,now,kind,text);this.db.exec('COMMIT');return this.get(id);}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 get(id:string){const r=this.db.prepare('SELECT id,created_at,kind,status,result FROM commands WHERE id=?').get(id);return r?{id:String(r.id),created_at:Number(r.created_at),kind:String(r.kind),status:String(r.status),result:r.result?JSON.parse(String(r.result)):null}:null;}
 pending(kinds?:string[]){return this.db.prepare("SELECT * FROM commands WHERE status='pending'"+(kinds?.length?' AND kind IN ('+kinds.map(()=>'?').join(',')+')':'')+' ORDER BY created_at,rowid LIMIT 20').all(...(kinds??[]));}
 finish(id:string,result:unknown){this.db.prepare("UPDATE commands SET status='completed',result=? WHERE id=?").run(JSON.stringify(result),id);}
 latest(kind:string){const r=this.db.prepare('SELECT id,created_at,kind,body,status,result FROM commands WHERE kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(kind);return r?{id:String(r.id),created_at:Number(r.created_at),kind:String(r.kind),body:JSON.parse(String(r.body)),status:String(r.status),result:r.result?JSON.parse(String(r.result)):null}:null;}
 positions(){return this.db.prepare('SELECT body FROM manual_positions ORDER BY rowid').all().map(r=>JSON.parse(String(r.body)));}
}
