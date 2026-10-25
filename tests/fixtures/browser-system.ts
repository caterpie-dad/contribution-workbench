import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import {spawn,ChildProcess} from 'node:child_process';
import {readConnections,root} from '../../src/config.js';
import {fixtureGit} from './git.js';
import {fixtureLlm} from './llm.js';
import {randomUUID} from 'node:crypto';
export async function browserSystem(){
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL||readConnections().application.database_url});const name='contribution_browser_'+process.pid+'_'+Date.now();await admin.query('CREATE DATABASE "'+name+'"');const database=new URL(process.env.DATABASE_URL||readConnections().application.database_url);database.pathname='/'+name;
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'contribution-browser-'));const localGit=await fixtureGit(true,true);const llm=await fixtureLlm({rejectGrounding:true});const c=JSON.parse(await fs.readFile(path.join(root,'config/connections.example.json'),'utf8'));c.example_only=false;c.systems.github.url='https://github.fixture';c.systems.opencode.llm={url:llm.url,provider_id:'contract',protocol:'chat_completions',token:'fixture-only-token',strict_tools:true,default_model_id:'contract-model',models:[{model_id:'contract-model',display_name:'격리 계약 모델',enabled:true,context_limit_tokens:32000}]};c.systems.opencode.llm.models.push({model_id:'contract-alternative',display_name:'선택 가능한 계약 모델 B',enabled:true,context_limit_tokens:32000});c.application={admin_username:'contract-admin',admin_password:'contract-browser-password',session_secret:'contract-browser-session-secret-1234567890',database_url:database.href};const file=path.join(folder,'connections.json');await fs.writeFile(file,JSON.stringify(c),{mode:0o600});
  const t=JSON.parse(await fs.readFile(path.join(root,'design/team-config.example.json'),'utf8'));t.period={start_inclusive:'2025-01-01T00:00:00Z',end_exclusive:'2025-01-03T00:00:00Z',as_of:'2025-01-03T00:00:00Z'};t.repositories=[{repository_id:'repo-platform',source_id:'github-main',url:'https://github.fixture/team/repo',mirror_path:localGit.bare,context_paths:['README.md'],docs_paths:['README.md']}];for(const person of t.members)person.repository_assignments=[{repository_id:'repo-platform',expected_role:'developer',valid_from:'2025-01-01',valid_until_exclusive:null}];t.sources.confluence.roots=[];t.demo={docs_surrogate:true,github_api:false,provenance_notice:'격리된 UI·계약 시험입니다. 공개 자료 10명의 실제 평가 결과와 구분합니다.'};
  const probe=net.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));const env={...process.env,CONTRIB_CONNECTIONS_FILE:file,DATABASE_URL:database.href,HOST:'127.0.0.1',PORT:String(port)};const children:ChildProcess[]=[];const logs:string[]=[];
  const launch=(entry:string)=>{const child=spawn(process.execPath,['--import','tsx',entry],{cwd:root,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream?.on('data',x=>logs.push(x.toString()));children.push(child);return child;};launch('src/server.ts');launch('src/worker.ts');const url=`http://127.0.0.1:${port}`;
  async function seedEvaluation(status:'running'|'review_required'='running'){
    const pool=new pg.Pool({connectionString:database.href});
    try{
      const config=(await pool.query('SELECT id FROM configurations ORDER BY created_at DESC LIMIT 1')).rows[0];
      const id=randomUUID(),collection=randomUUID(),job=randomUUID();
      await pool.query("INSERT INTO collection_runs(id,configuration_id,status) VALUES($1,$2,'complete')",[collection,config.id]);
      await pool.query('INSERT INTO evaluation_runs(id,collection_id,configuration_id,model,status,summary) VALUES($1,$2,$3,$4,$5,$6)',[id,collection,config.id,{provider_id:'contract',model_id:'contract-model'},status,{management_stage:'repository_catalog',executive_status:'running'}]);
      await pool.query("INSERT INTO jobs(id,kind,target_id,status,lease_owner,lease_until) VALUES($1,'evaluate',$2,$3,'browser-seeded',now()+interval '1 day')",[job,id,status==='running'?'running':'succeeded']);
      await pool.query('INSERT INTO portfolios(evaluation_id,person_id,output) VALUES($1,$2,$3)',[id,'member-a',{person_id:'member-a',summary:'보존할 중간 평가',generation:'rule_based_insufficient_evidence',dimensions:{},considered_evidence_ids:[]}]);
      return {id,job};
    }finally{await pool.end();}
  }
  async function close(){for(const child of children)child.kill('SIGTERM');await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise<void>(r=>{const timer=setTimeout(()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}r();},3000);child.once('exit',()=>{clearTimeout(timer);r();});})));await llm.close();await localGit.cleanup();await fs.rm(folder,{recursive:true,force:true});await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');await admin.end();}
  try{for(let i=0;i<100;i++){try{if((await fetch(url+'/api/health')).ok)return {url,username:c.application.admin_username,password:c.application.admin_password,configuration:t,close,logs,seedEvaluation};}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('격리 서버 시작 실패: '+logs.join(''));}catch(e){await close();throw e;}
}
