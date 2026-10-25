import pg from 'pg';
import fs from 'node:fs/promises';
import {readConnections,root} from './config.js';
import path from 'node:path';
export const db=new pg.Pool({connectionString:process.env.DATABASE_URL||readConnections().application.database_url,max:12});
export async function migrate(){const client=await db.connect();try{await client.query('SELECT pg_advisory_lock(82739105)');await client.query(await fs.readFile(path.join(root,'src/schema.sql'),'utf8'));}finally{await client.query('SELECT pg_advisory_unlock(82739105)').catch(()=>{});client.release();}}
export async function one<T=any>(sql:string,params:unknown[]=[]):Promise<T>{const r=await db.query(sql,params);if(!r.rows[0])throw new Error('자료를 찾을 수 없습니다');return r.rows[0];}
export async function audit(actor:string,action:string,target:string,details:unknown={}){await db.query('INSERT INTO audit_events(actor,action,target_id,details) VALUES($1,$2,$3,$4)',[actor,action,target,details]);}
export async function transaction<T>(fn:(c:pg.PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
