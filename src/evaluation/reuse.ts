import {isDeepStrictEqual} from 'node:util';
import {db} from '../db.js';
import {hash} from '../config.js';
import {readRaw} from '../storage.js';

export function canonicalValue(value:any):any {if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonicalValue);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonicalValue(value[key])]));return value;}
// A literal source-reader response may already satisfy a newly explicit
// citation minimum. No other schema, source, prompt or model change is allowed.
export function tightenedSourceCitations(prior:any,current:any){
  const before=structuredClone(prior),after=structuredClone(current);let tightened=false;
  const oldUnits=before.properties?.results?.properties,newUnits=after.properties?.results?.properties;
  if(!oldUnits||!newUnits)return false;
  for(const key of Object.keys(newUnits)){
    const oldCites=oldUnits[key]?.properties?.citations,newCites=newUnits[key]?.properties?.citations;
    if(!oldCites||!newCites)return false;
    if(newCites.minItems===1&&(oldCites?.minItems===undefined||oldCites.minItems===0)){delete newCites.minItems;delete oldCites.minItems;tightened=true;}
  }
  return tightened&&isDeepStrictEqual(before,after);
}
export function sameLiteralReaderInput(prior:any,current:any){
  const before={...prior},after={...current};delete before.validation_feedback;delete after.validation_feedback;return isDeepStrictEqual(before,after);
}
// JSONB may reorder object keys. Reuse compares the actual input values, policy,
// schema and model, preserving array order and the original provider trace.
export async function reusableManagementCall(run:any,stage:string,envelope:any,id:string,inputRef:string){
  const candidates=(await db.query("SELECT tr.* FROM ai_traces tr JOIN evaluation_runs r ON r.id=tr.evaluation_id WHERE tr.evaluation_id=ANY($1::text[]) AND r.collection_id=$2 AND r.configuration_id=$3 AND r.model=$4::jsonb AND tr.stage=$5 AND tr.status IN ('succeeded','reused') AND tr.response_ref IS NOT NULL ORDER BY (tr.input_hash=$6) DESC,(tr.evaluation_id=$7) DESC,tr.created_at DESC",[[run.id,...(run.parent_run_id?[run.parent_run_id]:[])],run.collection_id,run.configuration_id,JSON.stringify(run.model),stage,hash(envelope),run.id])).rows;
  for(const previous of candidates){const prior=JSON.parse((await readRaw(previous.input_ref)).toString());const sourceReader=stage==='source_digest_batch',tightened=sourceReader&&tightenedSourceCitations(prior.schema,envelope.schema),feedbackOnly=(sourceReader||['personal_feature_synthesis','personal_feature_grounding','management_portfolio'].includes(stage))&&sameLiteralReaderInput(prior.input,envelope.input);if(prior.prompt_revision!==envelope.prompt_revision||prior.system!==envelope.system||prior.parser_version!==envelope.parser_version||(!isDeepStrictEqual(prior.input,envelope.input)&&!feedbackOnly)||(!isDeepStrictEqual(prior.schema,envelope.schema)&&!tightened))continue;const response=JSON.parse((await readRaw(previous.response_ref)).toString());if(!response.info?.structured||response.info.modelID!==run.model.model_id||response.info.providerID!==run.model.provider_id)continue;
    return {output:response.info.structured,commit:async()=>{if(previous.evaluation_id!==run.id||previous.input_hash!==hash(envelope))await db.query(`INSERT INTO ai_traces(id,evaluation_id,stage,input_hash,input_ref,response_ref,session_id,requested_model,observed_model,runtime_version,status,reused_from_trace,reuse_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reused',$11,$12)`,[id,run.id,stage,hash(envelope),inputRef,previous.response_ref,previous.session_id,run.model,previous.observed_model,previous.runtime_version,previous.id,tightened||sourceReader&&feedbackOnly&&!isDeepStrictEqual(prior.input,envelope.input)?'literal_source_reader_revalidated':feedbackOnly&&!isDeepStrictEqual(prior.input,envelope.input)?'validated_repair_feedback_reuse':null]);}};
  }
  return null;
}
