import fs from 'node:fs/promises';
import {db,one,audit} from '../src/db.js';
const manifest=JSON.parse(await fs.readFile('runtime/verification/demo-run.json','utf8'));const id=process.argv[2]||manifest.evaluation_id;
try{const job=await one('SELECT * FROM jobs WHERE target_id=$1',[id]);if(!['failed','cancelled'].includes(job.status))throw new Error('실패·취소 작업만 명시적으로 재개할 수 있습니다');await db.query("UPDATE jobs SET status='pending',lease_owner=NULL,lease_until=NULL,error=NULL WHERE id=$1",[job.id]);await db.query("UPDATE evaluation_runs SET status='pending',summary=summary-'error' WHERE id=$1",[id]);await audit('local-operator','job.resume',job.id,{evaluation_id:id});console.log('Queued existing evaluation; completed validated evidence retained:',id);}finally{await db.end();}
