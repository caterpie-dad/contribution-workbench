import {randomUUID} from 'node:crypto';
import {db,audit} from '../db.js';
import {Connections,ResolvedModel,resolveModel,redact,hash,readConnections} from '../config.js';
import {callOpenCode,ensureOpenCode} from './opencode.js';
import {createOpencodeClient} from '@opencode-ai/sdk/v2/client';
import {updateConnections} from '../settings.js';

export async function discoverModels(expectedRevision:string,actor:string){
  const c=readConnections();
  if(hash(c)!==expectedRevision)throw Object.assign(new Error('연결 설정을 다시 불러오세요'),{statusCode:409});
  if(c.systems.opencode.manage_process&&!c.systems.opencode.llm.token)throw new Error('연결 파일에 LLM 토큰을 설정하세요');
  const instance=await ensureOpenCode(resolveModel(c,undefined,true),c);
  const client=createOpencodeClient({baseUrl:instance.url,headers:instance.headers,directory:instance.directory});
  const response=await client.provider.list({directory:instance.directory},{throwOnError:true,signal:AbortSignal.timeout(15000)});
  const data=response.data;
  if(!data||!Array.isArray(data.all)||!Array.isArray(data.connected))throw new Error('OpenCode 모델 목록 형식이 올바르지 않습니다');
  const discovered:NonNullable<Connections['systems']['opencode']['llm']['models']>=[];
  for(const provider of data.all){
    if(!data.connected.includes(provider.id)||(c.systems.opencode.manage_process&&provider.id!==c.systems.opencode.llm.provider_id))continue;
    for(const [id,model] of Object.entries(provider.models||{})){
      if(model.status==='deprecated'||model.capabilities?.toolcall===false||model.capabilities?.output?.text===false)continue;
      discovered.push({provider_id:provider.id,model_id:id,display_name:model.name||id,enabled:true,available:true,context_limit_tokens:model.limit?.context>0?model.limit.context:null,max_output_tokens:model.limit?.output>0?Math.min(model.limit.output,16384):null});
    }
  }
  if(!discovered.length)throw new Error('연결된 OpenCode에 구조화된 평가를 지원하는 모델이 없습니다');
  const connections=await updateConnections(expectedRevision,(raw,current)=>{
    const llm=current.systems.opencode.llm;
    const key=(m:typeof llm.models[number])=>(m.provider_id||llm.provider_id)+'/'+m.model_id;
    const found=new Map(discovered.map(m=>[key(m),m]));
    const models=llm.models.map(old=>({...old,provider_id:old.provider_id||llm.provider_id,available:found.has(key(old))}));
    const known=new Set(models.map(key));
    // Keep configured limits/reasoning and old entries for immutable run snapshots.
    for(const model of discovered)if(!known.has(key(model)))models.push(model as typeof models[number]);
    raw.systems.opencode.llm.models=models;
  });
  await audit(actor,'opencode.models_discovered','opencode',{model_count:discovered.length,runtime_version:instance.version,providers:[...new Set(discovered.map(m=>m.provider_id))]});
  return {connections,model_count:discovered.length,runtime_version:instance.version,models:await modelCatalog(readConnections())};
}

export async function modelCatalog(c:Connections){
  const checks=(await db.query('SELECT * FROM (SELECT DISTINCT ON(requested_model) * FROM model_checks ORDER BY requested_model,created_at DESC) latest ORDER BY created_at DESC')).rows;
  const traces=(await db.query('SELECT * FROM (SELECT DISTINCT ON(requested_model) requested_model,status,created_at FROM ai_traces ORDER BY requested_model,created_at DESC) latest ORDER BY created_at DESC')).rows;
  return c.systems.opencode.llm.models.map(model=>{
    const snapshot={provider_id:model.provider_id||c.systems.opencode.llm.provider_id,model_id:model.model_id,endpoint:c.systems.opencode.llm.url,protocol:c.systems.opencode.llm.protocol,strict_tools:c.systems.opencode.llm.strict_tools??(c.systems.opencode.llm.provider_id==='openai'),context_limit_tokens:model.context_limit_tokens??null,reasoning_effort:model.reasoning_effort??null,max_output_tokens:model.max_output_tokens??null};
    const matches=(row:any)=>Object.entries(snapshot).every(([key,value])=>(row.requested_model[key]??null)===value);
    const check=checks.find(matches),trace=traces.find(matches);
    return {...model,enabled:model.enabled&&model.available!==false&&(!c.systems.opencode.manage_process||snapshot.provider_id===c.systems.opencode.llm.provider_id),provider_id:snapshot.provider_id,is_default:snapshot.provider_id===c.systems.opencode.llm.provider_id&&model.model_id===c.systems.opencode.llm.default_model_id,
      availability:check?.status||'not_checked',checked_at:check?.created_at||null,check_error:check?.error?redact(check.error):null,
      last_evaluation_status:trace?.status||null,last_evaluation_at:trace?.created_at||null};
  });
}

export async function checkModel(model:ResolvedModel,actor:string){
  const id=randomUUID();
  await db.query("INSERT INTO model_checks(id,requested_model,status,actor) VALUES($1,$2,'running',$3)",[id,model,actor]);
  try{
    const result=await callOpenCode('Return ok=true for connection check.',{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},model);
    if((result.output as any)?.ok!==true)throw new Error('모델 연결 시험이 ok=true를 반환하지 않았습니다');
    if(result.observedModel?.provider_id!==model.provider_id||result.observedModel?.model_id!==model.model_id)throw new Error('모델 연결 시험에서 응답 모델을 확인하지 못했습니다');
    await db.query("UPDATE model_checks SET status='succeeded',observed_model=$2,runtime_version=$3 WHERE id=$1",[id,result.observedModel,result.version]);
    await audit(actor,'model.checked',id,{requested_model:model,status:'succeeded'});
    return {ok:true,requested_model:model,observed_model:result.observedModel,runtime_version:result.version};
  }catch(error){
    await db.query("UPDATE model_checks SET status='failed',error=$2 WHERE id=$1",[id,redact(error)]);
    await audit(actor,'model.checked',id,{requested_model:model,status:'failed'});
    throw error;
  }
}
