import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {validDate} from './model.js';
const schema=z.object({name:z.literal('NIFTY 50'),snapshotDate:z.string().refine(validDate),validThrough:z.string().refine(validDate),source:z.string().url(),retrievedAt:z.string().datetime({offset:true}),sha256:z.string().regex(/^[a-f0-9]{64}$/),constituents:z.array(z.object({symbol:z.string().regex(/^[A-Z0-9&-]+$/),name:z.string().min(1),industry:z.string().min(1),isin:z.string().regex(/^IN[A-Z0-9]{10}$/)})).length(50)});
export type Universe= z.infer<typeof schema>;
export function parseUniverse(raw:unknown,date:string):Universe {
 const u=schema.parse(raw);
 if(!validDate(date)||date<u.snapshotDate||date>u.validThrough||u.validThrough<u.snapshotDate||new Set(u.constituents.map(c=>c.symbol)).size!==50||new Set(u.constituents.map(c=>c.isin)).size!==50)throw new Error('RECORDER_INVALID_OR_EXPIRED_UNIVERSE');
 return u;
}
export async function loadUniverse(date:string,env:NodeJS.ProcessEnv=process.env):Promise<Universe|null> {
 const name=env.RECORDER_UNIVERSE??'validation-pair';
 if(name==='validation-pair')return null;
 if(name!=='nifty50')throw new Error('RECORDER_UNKNOWN_UNIVERSE');
 return parseUniverse(JSON.parse(await readFile(env.RECORDER_UNIVERSE_PATH??new URL('../deploy/lightsail/nifty50-2026-10-21.json',import.meta.url),'utf8')),date);
}
