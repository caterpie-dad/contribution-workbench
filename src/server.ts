import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import {randomBytes,timingSafeEqual,createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {readConnections,safeConnections,resolveModel,root,redact,hash} from './config.js';
import {db,one,migrate,audit,transaction} from './db.js';
import {saveConfiguration,createCollection,createEvaluation,applyCorrection,cancelJob} from './jobs.js';
import {stopOpenCode} from './evaluation/opencode.js';
import {readRaw} from './storage.js';
import {RestWiki,McpWiki} from './collectors/confluence.js';
import {request,authHeaders} from './collectors/common.js';
import {finalizeReport} from './reports.js';
import {modelCatalog,checkModel,discoverModels} from './evaluation/models.js';
import {saveConnectionEdits,saveDefaultModel} from './settings.js';
import {reviewAssessment} from './evaluation/review.js';
import {reviewGrounding} from './grounding-reviews.js';
import {validateExecutiveText,validateMemberBrief} from './management/executive.js';

async function executiveBriefs(id:string){
  const rows=(await db.query('SELECT DISTINCT ON(kind,subject_id) kind,subject_id,output FROM executive_briefs WHERE evaluation_id=$1 ORDER BY kind,subject_id,created_at DESC,revision',[id])).rows;
  return rows.filter(r=>{try{if(r.kind==='member')validateMemberBrief({activities:r.output.activities.map((a:any)=>({title:a.title,outcome:a.outcome}))});else validateExecutiveText({purpose:r.output.purpose,capabilities:r.output.capabilities,technology_stack:r.output.technology_stack,difficulty:r.output.difficulty});return true;}catch{return false;}});
}

export async function buildServer(){
  await migrate();const app=Fastify({logger:false,bodyLimit:2*1024*1024});await app.register(cookie,{secret:readConnections().application.session_secret});
  const sessionToken=(req:any)=>{const raw=req.cookies.session;if(!raw)return null;const unsigned=req.unsignCookie(raw);return unsigned.valid?unsigned.value:null;};
  const failedLogins=new Map<string,{count:number;reset:number}>();
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','same-origin').header('Cache-Control','no-store');
    if(!req.url.startsWith('/api/'))return;
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      if(req.headers['x-contribution-request']!=='1')return reply.code(403).send({error:'동일 출처 요청 헤더가 필요합니다'});
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return reply.code(403).send({error:'다른 출처의 변경 요청은 허용하지 않습니다'});
    }
    if(['/api/health','/api/login'].includes(req.url.split('?')[0]))return;
    const token=sessionToken(req);const session=token?(await db.query('SELECT username FROM sessions WHERE id=$1 AND expires_at>now()',[hash(token)])).rows[0]:null;
    if(!session)return reply.code(401).send({error:'로그인이 필요합니다'});
    (req as any).username=session.username;
  });
  app.setErrorHandler((error,req,reply)=>{reply.code((error as any).statusCode||400).send({error:redact(error)});});
  app.get('/api/health',async()=>{await db.query('SELECT 1');return {status:'ok',database:'ready'};});
  app.post('/api/login',async(req,reply)=>{const now=Date.now();const failure=failedLogins.get(req.ip);if(failure&&failure.reset>now&&failure.count>=10)return reply.code(429).send({error:'로그인 재시도 한도. 잠시 후 시도하세요'});const input=req.body as any;const c=readConnections();const digest=(s:string)=>createHash('sha256').update(s).digest();if(input?.username!==c.application.admin_username||typeof input.password!=='string'||!timingSafeEqual(digest(input.password),digest(c.application.admin_password))){failedLogins.set(req.ip,{count:(failure?.reset||0)>now?(failure?.count||0)+1:1,reset:now+60000});return reply.code(401).send({error:'계정 또는 비밀번호가 잘못되었습니다'});}failedLogins.delete(req.ip);const token=randomBytes(32).toString('hex');await db.query(`INSERT INTO sessions(id,username,expires_at) VALUES($1,$2,now()+interval '8 hours')`,[hash(token),input.username]);reply.setCookie('session',token,{signed:true,httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:28800});await audit(input.username,'session.login','');return {username:input.username};});
  app.post('/api/logout',async(req,reply)=>{const token=sessionToken(req);if(token)await db.query('DELETE FROM sessions WHERE id=$1',[hash(token)]);reply.clearCookie('session',{path:'/'});return {ok:true};});
  app.get('/api/me',async req=>({username:(req as any).username,role:'manager'}));
  app.get('/api/connections',async()=>safeConnections(readConnections()));
  app.put('/api/connections',async req=>{const input=req.body as any;const result=await saveConnectionEdits(input?.expected_revision,input?.connections);await audit((req as any).username,'connections.saved','connections');return result;});
  app.post('/api/opencode/discover',async req=>discoverModels((req.body as any)?.expected_revision,(req as any).username));
  app.put('/api/opencode/default-model',async req=>{const input=req.body as any;const result=await saveDefaultModel(input?.expected_revision,input?.model||{});await audit((req as any).username,'model.default_saved','opencode',{provider_id:result.opencode.provider_id,model_id:result.opencode.default_model_id});return result;});
  app.get('/api/evaluation-models',async()=>modelCatalog(readConnections()));
  app.post('/api/connections/test',async req=>{const input=req.body as any;const c=readConnections();if(input?.source==='github'){const base=c.systems.github.api_url||(c.systems.github.deployment==='cloud'?'https://api.github.com':c.systems.github.url+'/api/v3');await request(base+'/rate_limit',authHeaders(c.systems.github.auth));return {ok:true,source:'github'};}if(input?.source==='confluence'){const adapter=c.systems.confluence.transport==='mcp'?new McpWiki(c.systems.confluence):new RestWiki(c.systems.confluence);try{const id=await adapter.resolve(input.page_url,input.page_id);const page=await adapter.page(id);return {ok:true,source:'confluence',page_id:page.id,version:page.version};}finally{await adapter.close();}}return checkModel(resolveModel(c,input?.model),(req as any).username);});
  app.get('/api/configuration',async()=>{const r=await db.query('SELECT * FROM configurations ORDER BY activated_at DESC,created_at DESC LIMIT 1');return r.rows[0]||{id:null,body:JSON.parse(fs.readFileSync(path.join(root,'design/team-config.example.json'),'utf8'))};});
  app.put('/api/configuration',async req=>{const input=req.body as any;const result=await transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(82739107)');if(Object.hasOwn(input,'expected_revision')){const last=(await client.query('SELECT id FROM configurations ORDER BY activated_at DESC,created_at DESC LIMIT 1')).rows[0];if((last?.id||null)!==input.expected_revision)throw Object.assign(new Error('설정 revision 충돌. 화면을 새로 불러오세요'),{statusCode:409});}return saveConfiguration(input.configuration,client);});await audit((req as any).username,'configuration.saved',result.id);return result;});
  app.get('/api/overview',async()=>{const configurations=(await db.query('SELECT id,body,created_at FROM configurations ORDER BY activated_at DESC,created_at DESC LIMIT 1')).rows;const collections=(await db.query('SELECT * FROM collection_runs ORDER BY created_at DESC')).rows;const evaluations=(await db.query('SELECT * FROM evaluation_runs ORDER BY created_at DESC')).rows;const reports=(await db.query('SELECT * FROM reports ORDER BY created_at DESC')).rows;const jobs=(await db.query(`SELECT * FROM jobs WHERE status IN ('pending','running') OR id IN (SELECT id FROM jobs ORDER BY created_at DESC LIMIT 30) ORDER BY created_at DESC`)).rows;return {configuration:configurations[0]||null,collections,evaluations,reports,jobs};});
  app.post('/api/collection-runs',async req=>({id:await createCollection((req.body as any).configuration_id,(req as any).username)}));
  app.get('/api/collection-runs/:id/coverage',async req=>{const id=(req.params as any).id;return {run:await one('SELECT * FROM collection_runs WHERE id=$1',[id]),inventory:(await db.query('SELECT * FROM inventory WHERE collection_id=$1 ORDER BY source_id,object_key',[id])).rows};});
  app.post('/api/evaluation-runs',async req=>({id:await createEvaluation((req.body as any).collection_run_id,(req.body as any).model,(req as any).username,(req.body as any).reference_run_id)}));
  app.get('/api/evaluation-runs/:id',async req=>{const id=(req.params as any).id;const run=await one('SELECT * FROM evaluation_runs WHERE id=$1',[id]);const config=await one('SELECT body FROM configurations WHERE id=$1',[run.configuration_id]);return {run,configuration:config.body,executive_briefs:await executiveBriefs(id),repository_profiles:(await db.query('SELECT repository_id,output FROM repository_profiles WHERE evaluation_id=$1 ORDER BY repository_id',[id])).rows,feature_reports:(await db.query('SELECT feature_id,repository_id,output FROM feature_reports WHERE evaluation_id=$1 ORDER BY repository_id,feature_id',[id])).rows,personal_feature_reports:(await db.query('SELECT person_id,feature_id,output FROM personal_feature_reports WHERE evaluation_id=$1 ORDER BY person_id,feature_id',[id])).rows,portfolios:(await db.query('SELECT * FROM portfolios WHERE evaluation_id=$1 ORDER BY person_id',[id])).rows,grounding_reviews:(await db.query('SELECT * FROM grounding_reviews WHERE evaluation_id=$1 ORDER BY person_id',[id])).rows,corrections:(await db.query('SELECT * FROM corrections WHERE evaluation_id=$1 OR successor_run_id=$1 OR id=ANY($2::text[]) ORDER BY created_at',[id,(run.corrections||[]).map((c:any)=>c.id)])).rows,collection:await one('SELECT * FROM collection_runs WHERE id=$1',[run.collection_id]),traces:(await db.query('SELECT id,stage,session_id,requested_model,observed_model,runtime_version,status,error,created_at FROM ai_traces WHERE evaluation_id=$1 ORDER BY created_at',[id])).rows};});
  app.get('/api/evaluation-runs/:id/cases',async req=>(await db.query("SELECT id,output-'assessments' AS output FROM contribution_cases WHERE evaluation_id=$1 ORDER BY id",[(req.params as any).id])).rows);
  app.get('/api/evidence',async req=>{const q=req.query as any;const result=await db.query('SELECT id,source_id,object_id,revision,kind,title,url,occurred_at,actors,metadata,CASE WHEN $2::boolean THEN NULL ELSE body END AS body,length(body) AS body_length FROM evidence WHERE collection_id=$1 ORDER BY occurred_at DESC NULLS LAST,id',[q.collection_id,q.compact==='1']);const assessments=q.evaluation_id?(q.compact==='1'?(await db.query("SELECT evidence_id,output->>'assessment_status' AS assessment_status FROM assessments WHERE evaluation_id=$1",[q.evaluation_id])).rows:(await db.query('SELECT evidence_id,output FROM assessments WHERE evaluation_id=$1',[q.evaluation_id])).rows):[];return result.rows.map(e=>{const record=assessments.find(a=>a.evidence_id===e.id);const assessment=record?.output||null;const {body,...fields}=e;return {...fields,assessment,has_assessment:!!record,assessment_status:record?.assessment_status||assessment?.assessment_status,review_flags:q.compact==='1'?[]:reviewAssessment(e,assessment),review_flags_pending:q.compact==='1'};});});
  app.get('/api/evidence/:id',async req=>{const e=await one('SELECT * FROM evidence WHERE id=$1',[(req.params as any).id]);const evalId=(req.query as any).evaluation_id;const assessment=evalId?(await db.query('SELECT output FROM assessments WHERE evaluation_id=$1 AND evidence_id=$2',[evalId,e.id])).rows[0]?.output||null:null;return {...e,assessment,review_flags:reviewAssessment(e,assessment),raw_verified:(await readRaw(e.raw_hash)).toString()===e.body};});
  app.post('/api/evaluation-runs/:id/people/:personId/grounding-review',async req=>{const {id,personId}=req.params as any;return reviewGrounding(id,personId,req.body,(req as any).username);});
  app.get('/api/management-sources/:id',async req=>{const e=await one('SELECT * FROM management_sources WHERE id=$1',[(req.params as any).id]);return {...e,kind:e.metadata.kind==='document_change_view'?'document_change_view':'context',revision:e.metadata.anchor,actors:[],raw_verified:(await readRaw(e.raw_hash)).toString()===e.body};});
  app.post('/api/corrections',async req=>{const input=req.body as any;return applyCorrection(input.evaluation_id,input,(req as any).username);});
  app.post('/api/evaluation-runs/:id/finalize',async req=>finalizeReport((req.params as any).id,req.body,(req as any).username));
  app.post('/api/jobs/:id/:action',async req=>{const {id,action}=req.params as any;const job=await one('SELECT * FROM jobs WHERE id=$1',[id]);const table=job.kind==='collect'?'collection_runs':'evaluation_runs';if(action==='cancel'){return cancelJob(id,(req as any).username);}else if(action==='resume'){if(!['failed','cancelled'].includes(job.status))throw new Error('실패·취소 작업만 재개할 수 있습니다');await db.query(`UPDATE jobs SET status='pending',lease_until=NULL,lease_owner=NULL,error=NULL WHERE id=$1`,[id]);await db.query(`UPDATE ${table} SET status='pending' WHERE id=$1`,[job.target_id]);}else throw new Error('지원하지 않는 작업');await audit((req as any).username,'job.'+action,id);return {ok:true};});
  app.get('/api/audit',async()=>({events:(await db.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 200')).rows}));
  if(fs.existsSync(path.join(root,'dist/index.html'))){await app.register(staticFiles,{root:path.join(root,'dist')});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'API가 없습니다'}):reply.sendFile('index.html'));}
  app.addHook('onClose',async()=>{await stopOpenCode();});return app;
}
if(process.argv[1]?.endsWith('server.ts')){const app=await buildServer();await app.listen({host:process.env.HOST||'127.0.0.1',port:Number(process.env.PORT||3100)});console.log('Contribution dashboard http://'+(process.env.HOST||'127.0.0.1')+':'+(process.env.PORT||3100));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>db.end());});}
