import {randomUUID} from 'node:crypto';
import {migrate,db} from './db.js';
import {claimJob,executeJob} from './jobs.js';
import {stopOpenCode} from './evaluation/opencode.js';
import {redact} from './config.js';
await migrate();const owner=randomUUID();let stopping=false;const shutdown=new AbortController();
process.on('SIGINT',()=>{stopping=true;shutdown.abort();});process.on('SIGTERM',()=>{stopping=true;shutdown.abort();});
console.log('Contribution worker ready');
try{while(!stopping){const job=await claimJob(owner);if(job){console.log('Processing',job.kind,job.target_id);await executeJob(job,owner,shutdown.signal);}else await new Promise(r=>setTimeout(r,500));}}catch(e){console.error(redact(e));process.exitCode=1;}finally{await stopOpenCode();await db.end();}
