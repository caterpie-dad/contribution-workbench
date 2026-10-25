import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {db,migrate} from '../src/db.js';
import {readConnections,resolveModel,validateModelSnapshot} from '../src/config.js';
import {buildServer} from '../src/server.js';
import {modelCatalog} from '../src/evaluation/models.js';
after(async()=>{await db.end();});

async function fixture(){
  await migrate();const initial=readConnections(),folder=await fs.mkdtemp(path.join(os.tmpdir(),'contribution-settings-')),file=path.join(folder,'connections.json');
  const c=JSON.parse(await fs.readFile('config/connections.example.json','utf8'));c.example_only=false;
  c.application={admin_username:'settings-admin',admin_password:'settings-fixture-password',session_secret:'settings-fixture-session-secret-1234567890',database_url:process.env.DATABASE_URL||initial.application.database_url};
  c.systems.github.auth.token='settings-github-fixture-token';c.systems.confluence.auth.token='settings-wiki-fixture-token';c.systems.confluence.mcp={command:'preserve-command',args:['preserve-argument'],env:{WIKI_AUTH:'settings-mcp-fixture-secret'},bindings:{page:{tool:'preserve-tool',arguments:{id:'{{page_id}}'}}}};
  const calls:string[]=[];let broken=false;
  const model=(id:string,toolcall=true,status='active')=>({id,name:id,capabilities:{toolcall,output:{text:true}},limit:{context:64000,output:8000},status});
  const server=http.createServer((req,res)=>{calls.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='Bearer settings-opencode-fixture-token'){res.writeHead(401);res.end('{}');return;}if(req.url==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.19.4'}));return;}if(req.url==='/provider'&&!broken){res.end(JSON.stringify({all:[{id:'corp',models:{shared:model('shared'),next:model('next'),old:model('old',true,'deprecated'),image:model('image',false)}},{id:'second',models:{shared:model('shared')}},{id:'disconnected',models:{hidden:model('hidden')}}],connected:['corp','second'],default:{corp:'shared',second:'shared'}}));return;}res.writeHead(502);res.end('{}');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  Object.assign(c.systems.opencode,{server_url:'http://127.0.0.1:'+(server.address() as any).port,manage_process:false,server_auth:{scheme:'bearer',token:'settings-opencode-fixture-token'}});
  c.systems.opencode.llm={url:'https://unused-llm.fixture/v1',provider_id:'corp',protocol:'chat_completions',token:'',default_model_id:'shared',models:[{model_id:'shared',display_name:'Existing model',enabled:true,context_limit_tokens:32000,max_output_tokens:4096}]};
  c.extension={preserved:true};await fs.writeFile(file,JSON.stringify(c),{mode:0o600});const previous=process.env.CONTRIB_CONNECTIONS_FILE;process.env.CONTRIB_CONNECTIONS_FILE=file;
  const app=await buildServer();
  const login=await app.inject({method:'POST',url:'/api/login',headers:{'x-contribution-request':'1'},payload:{username:c.application.admin_username,password:c.application.admin_password}});assert.equal(login.statusCode,200);
  const headers={cookie:'session='+login.cookies.find(x=>x.name==='session')!.value,'x-contribution-request':'1'};
  const api=async(method:string,url:string,payload?:any)=>app.inject({method:method as any,url:'/api'+url,headers,payload});
  return {c,file,calls,api,breakDiscovery:()=>{broken=true;},read:async()=>JSON.parse(await fs.readFile(file,'utf8')),close:async()=>{await app.close();await new Promise<void>(r=>server.close(()=>r()));if(previous===undefined)delete process.env.CONTRIB_CONNECTIONS_FILE;else process.env.CONTRIB_CONNECTIONS_FILE=previous;await fs.rm(folder,{recursive:true,force:true});}};
}

test('연결 폼 API는 URL만 원자적으로 저장하고 토큰·MCP·확장 필드를 보존하며 잘못된 입력과 충돌을 거부한다',async()=>{
  const f=await fixture();
  try{
    const safe=(await f.api('GET','/connections')).json();const edits={github:{url:'https://github.changed.fixture',deployment:'enterprise_server',api_url:'https://github.changed.fixture/api/v3'},confluence:{url:'https://wiki.changed.fixture',deployment:'data_center',transport:'mcp',mcp_url:'http://127.0.0.1:8042/mcp'},opencode:{server_url:f.c.systems.opencode.server_url,manage_process:false,transport:'sdk',llm_url:'https://unused-llm.fixture/v1',protocol:'chat_completions'}};
    const changed=await f.api('PUT','/connections',{expected_revision:safe.revision,connections:edits});assert.equal(changed.statusCode,200,changed.body);
    const raw=await f.read();assert.equal(raw.systems.github.url,edits.github.url);assert.equal(raw.systems.github.auth.token,f.c.systems.github.auth.token);assert.deepEqual(raw.systems.confluence.mcp.bindings,f.c.systems.confluence.mcp.bindings);assert.equal(raw.systems.confluence.mcp.env.WIKI_AUTH,'settings-mcp-fixture-secret');assert.equal(raw.systems.confluence.mcp.url,edits.confluence.mcp_url);assert.deepEqual(raw.extension,{preserved:true});assert.equal((await fs.stat(f.file)).mode&0o777,0o600);
    for(const secret of [f.c.systems.github.auth.token,f.c.systems.confluence.auth.token,f.c.application.admin_password,'settings-mcp-fixture-secret'])assert(!changed.body.includes(secret));
    const before=await fs.readFile(f.file,'utf8'),revision=changed.json().revision;
    assert.equal((await f.api('PUT','/connections',{expected_revision:safe.revision,connections:edits})).statusCode,409);
    assert.equal((await f.api('PUT','/connections',{expected_revision:revision,connections:{...edits,github:{...edits.github,auth:{token:'injected'}}}})).statusCode,400);
    assert.equal((await f.api('PUT','/connections',{expected_revision:revision,connections:{...edits,github:{...edits.github,url:'https://name:password@github.fixture'}}})).statusCode,400);
    assert.equal((await f.api('PUT','/connections',{expected_revision:revision,connections:{...edits,opencode:{...edits.opencode,llm_url:'file:///tmp/model'}}})).statusCode,400);
    const job=randomUUID();await db.query("INSERT INTO jobs(id,kind,target_id,status) VALUES($1,'collect',$2,'running')",[job,randomUUID()]);try{assert.equal((await f.api('PUT','/connections',{expected_revision:revision,connections:edits})).statusCode,409);}finally{await db.query('DELETE FROM jobs WHERE id=$1',[job]);}
    assert.equal(await fs.readFile(f.file,'utf8'),before);
  }finally{await f.close();}
});

test('실제 OpenCode SDK로 연결된 공급자의 모델만 조회하고 기본값·실행 모델을 보존하며 동명 모델을 구분한다',async()=>{
  const f=await fixture();
  try{
    const snapshot=resolveModel(readConnections());const revision=(await f.api('GET','/connections')).json().revision;
    const response=await f.api('POST','/opencode/discover',{expected_revision:revision});assert.equal(response.statusCode,200,response.body);const discovered=response.json();
    assert.equal(discovered.model_count,3);assert.equal(discovered.runtime_version,'1.19.4');assert.deepEqual(discovered.models.filter((m:any)=>m.enabled).map((m:any)=>m.provider_id+'/'+m.model_id).sort(),['corp/next','corp/shared','second/shared']);
    assert(f.calls.every(x=>x.startsWith('GET ')));assert(!response.body.includes('settings-opencode-fixture-token'));assert.equal((await f.read()).systems.opencode.llm.default_model_id,'shared');assert.deepEqual(validateModelSnapshot(readConnections(),snapshot),snapshot);
    const chosen=await f.api('PUT','/opencode/default-model',{expected_revision:discovered.connections.revision,model:{provider_id:'second',model_id:'shared'}});assert.equal(chosen.statusCode,200,chosen.body);assert.equal(resolveModel(readConnections()).provider_id,'second');assert.deepEqual(validateModelSnapshot(readConnections(),snapshot),snapshot);
    const managed=structuredClone(readConnections());managed.systems.opencode.manage_process=true;assert.deepEqual((await modelCatalog(managed)).filter(m=>m.enabled).map(m=>m.provider_id+'/'+m.model_id),['second/shared']);
    assert.equal((await f.api('PUT','/opencode/default-model',{expected_revision:chosen.json().revision,model:{provider_id:'disconnected',model_id:'hidden'}})).statusCode,400);
    const before=await fs.readFile(f.file,'utf8');f.breakDiscovery();assert.equal((await f.api('POST','/opencode/discover',{expected_revision:chosen.json().revision})).statusCode,400);assert.equal(await fs.readFile(f.file,'utf8'),before);
  }finally{await f.close();}
});

test('팀 설정의 관계·기간·비중 오류와 동시 수정을 거부하고 이전 설정 버전을 보존한다',async()=>{
  const f=await fixture();
  try{
    const t=JSON.parse(await fs.readFile('design/team-config.example.json','utf8'));t.notice=randomUUID();const saved=(await f.api('PUT','/configuration',{configuration:t})).json();
    const invalids=[(x:any)=>{x.evaluation_policy.weights.verification=.99;},(x:any)=>{x.members[0].repository_assignments[0].valid_until_exclusive=x.members[0].repository_assignments[0].valid_from;},(x:any)=>{x.sources.confluence.roots[1].root_id=x.sources.confluence.roots[0].root_id;},(x:any)=>{x.sources.confluence.roots[0].repository_ids=['missing'];},(x:any)=>{x.members[0].identities.commit_emails=['invalid-email'];}];
    for(const mutate of invalids){const bad=structuredClone(t);mutate(bad);assert.equal((await f.api('PUT','/configuration',{expected_revision:saved.id,configuration:bad})).statusCode,400);}
    const next=structuredClone(t);next.members[0].display_name='수정한 팀원';const updated=await f.api('PUT','/configuration',{expected_revision:saved.id,configuration:next});assert.equal(updated.statusCode,200,updated.body);assert.notEqual(updated.json().id,saved.id);
    assert.equal((await f.api('PUT','/configuration',{expected_revision:saved.id,configuration:t})).statusCode,409);assert.equal((await db.query('SELECT body FROM configurations WHERE id=$1',[saved.id])).rows[0].body.members[0].display_name,t.members[0].display_name);
    const reverted=await f.api('PUT','/configuration',{expected_revision:updated.json().id,configuration:t});assert.equal(reverted.statusCode,200,reverted.body);assert.equal((await f.api('GET','/configuration')).json().id,saved.id);assert.equal((await f.api('GET','/overview')).json().configuration.id,saved.id);
  }finally{await f.close();}
});
