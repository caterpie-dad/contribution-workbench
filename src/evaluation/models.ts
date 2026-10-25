import {randomUUID} from 'node:crypto';
import {db,audit} from '../db.js';
import {Connections,ResolvedModel,resolveModel,redact} from '../config.js';
import {callOpenCode} from './opencode.js';

export async function modelCatalog(c:Connections){
  const checks=(await db.query('SELECT * FROM (SELECT DISTINCT ON(requested_model) * FROM model_checks ORDER BY requested_model,created_at DESC) latest ORDER BY created_at DESC')).rows;
  const traces=(await db.query('SELECT * FROM (SELECT DISTINCT ON(requested_model) requested_model,status,created_at FROM ai_traces ORDER BY requested_model,created_at DESC) latest ORDER BY created_at DESC')).rows;
  return c.systems.opencode.llm.models.map(model=>{
    const snapshot={provider_id:c.systems.opencode.llm.provider_id,model_id:model.model_id,endpoint:c.systems.opencode.llm.url,protocol:c.systems.opencode.llm.protocol,strict_tools:c.systems.opencode.llm.strict_tools??(c.systems.opencode.llm.provider_id==='openai'),context_limit_tokens:model.context_limit_tokens??null,reasoning_effort:model.reasoning_effort??null,max_output_tokens:model.max_output_tokens??null};
    const matches=(row:any)=>Object.entries(snapshot).every(([key,value])=>(row.requested_model[key]??null)===value);
    const check=checks.find(matches),trace=traces.find(matches);
    return {...model,provider_id:snapshot.provider_id,is_default:model.model_id===c.systems.opencode.llm.default_model_id,
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
