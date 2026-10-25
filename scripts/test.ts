import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {db} from '../src/db.js';
import {readConnections,root} from '../src/config.js';
import path from 'node:path';
const name='contribution_test_'+process.pid+'_'+Date.now();const url=new URL(process.env.DATABASE_URL||readConnections().application.database_url);url.pathname='/'+name;
await db.query('CREATE DATABASE "'+name+'"');
try{const files=fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.ts')).map(x=>'tests/'+x);const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1',...files],{stdio:'inherit',env:{...process.env,DATABASE_URL:url.href}});process.exitCode=await new Promise<number>(r=>child.on('exit',code=>r(code??1)));}finally{await db.query('DROP DATABASE "'+name+'" WITH (FORCE)');await db.end();}
