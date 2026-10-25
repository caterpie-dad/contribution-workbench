import fs from 'node:fs/promises';
import path from 'node:path';
import {runtime} from './config.js';
import {createHash} from 'node:crypto';
export async function saveRaw(content:string|Buffer){const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);const digest=createHash('sha256').update(bytes).digest('hex');const folder=path.join(runtime,'objects',digest.slice(0,2));await fs.mkdir(folder,{recursive:true});try{await fs.writeFile(path.join(folder,digest),bytes,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}return digest;}
export async function readRaw(digest:string){if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('원본 참조 오류');return fs.readFile(path.join(runtime,'objects',digest.slice(0,2),digest));}
