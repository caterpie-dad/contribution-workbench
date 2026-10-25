import {db} from '../db.js';
import {isDeepStrictEqual} from 'node:util';
import {readRaw} from '../storage.js';
import {canonicalValue} from '../evaluation/reuse.js';
import {hash,redact} from '../config.js';
import {Source} from './context.js';
import {DocumentMaterial} from './documents.js';
import {arr,obj,str,strings,citationsSchema,flatCatalog,bindCitations,sourceSlices,budgetedBatches,validateSchema,managementPolicies} from './contracts.js';
import {mapLimit} from '../evaluation/cases.js';
import {permanentLlmError} from '../evaluation/errors.js';

export type ManagementRunner=(stage:string,input:any,schema:any,validate:(output:any)=>void)=>Promise<any>;
export type DigestUnit={part_id:string;case_id?:string;repository_id:string;material_kind:'change'|'existing_context';sources:Source[];input_kind?:'derived_change_summary';prior_change_facts?:any[];prior_part_ids?:string[]};
const short={...str,maxLength:650};
function readingScope(scope:any){const {allowed_person_ids,...facts}=scope||{};return facts;}
function readingCatalog(sources:Source[]){return flatCatalog(sources).map(s=>({...s,source_scope:readingScope(s.source_scope)}));}
export function digestSchema(unit:DigestUnit){
  const citations={...citationsSchema(unit.sources,true),minItems:flatCatalog(unit.sources).some(s=>s.citation_spans.length)?1:0,maxItems:5};
  if(!flatCatalog(unit.sources).some(s=>s.citation_spans.length)){citations.items={type:'object',properties:{citation_ref:{type:'integer',enum:[0]}},required:['citation_ref'],additionalProperties:false};citations.maxItems=0;}
  if(unit.material_kind==='existing_context')return obj({existing_behavior:short,constraints:{...strings,maxItems:5},limitations:{...strings,maxItems:5},citations});
  return obj({functional_goal:short,change_summary:short,behavior_before:short,behavior_after:short,knowledge_kind:{type:'string',enum:['code_change','usage_guidance','reasoned_analysis','reference_or_note','opaque_or_unclear']},verification_observed:short,limitations:{...strings,maxItems:5},citations});
}
export function changedCitationRefs(unit:DigestUnit){return unit.material_kind==='change'?flatCatalog(unit.sources).flatMap(s=>s.citation_spans.filter(c=>c.quote.trim().length>=8&&/^[+-](?![+-])/m.test(c.quote)).map(c=>c.citation_ref)):[];}
export function validateDigestOutput(unit:DigestUnit,value:any){
  validateSchema(digestSchema(unit),value);const quotes=bindCitations(value.citations,unit.sources);
  if(flatCatalog(unit.sources).some(s=>s.citation_spans.length)&&!quotes.length)throw new Error('원문 의미 색인에 해당 입력의 정확한 인용이 필요합니다');
  const changed=changedCitationRefs(unit);if(changed.length&&!value.citations.some((c:any)=>changed.includes(c.citation_ref)))throw new Error('변경 사실에는 실제 추가·삭제 줄의 인용이 필요합니다. 선택 가능한 변경 인용: '+changed.join(','));
  return quotes;
}
export function uniqueQuotedSources(citations:any[]):Source[]{
  const unique=new Map<string,Source>();
  for(const c of citations){const scope=c.source_scope||{};const concise=Object.fromEntries(['material_role','not_personal_credit','source_evidence_id','allowed_person_ids','at_period_end','path','anchor','context_only','source_slice','evidence_kind','authorship_scope'].filter(k=>scope[k]!==undefined).map(k=>[k,scope[k]]));const key=JSON.stringify([c.source_id,c.quote,c.source_evidence_id,!!scope.not_personal_credit,!!scope.at_period_end,scope.allowed_person_ids||[]]);if(!unique.has(key))unique.set(key,{id:c.source_id,title:c.title,url:c.url,body:c.quote,metadata:concise});}
  return [...unique.values()];
}

// Only primary changes have a change question. A complete page/file used as
// background gets a different schema that cannot produce a contribution.
export function digestUnits(repositoryId:string,sources:Source[],budget:number,caseId?:string):DigestUnit[]{
  const result:DigestUnit[]=[];
  const allSlices=sourceSlices(sources,Math.max(1000,Math.min(8000,Math.floor(budget/8))),true).map(s=>{
    if(s.metadata?.material_role!=='change'||s.metadata?.derivation!=='git-word-diff-porcelain-v1')return s;
    const leading=s.metadata.source_slice.leading_line_kind,changed=leading==='added'||leading==='removed'||/^[+-](?![+-])/m.test(s.body);
    return changed?s:{...s,metadata:{...s.metadata,material_role:'existing_context',not_personal_credit:true,allowed_person_ids:[]}};
  });
  for(const kind of ['change','existing_context'] as const){
    const slices=allSlices.filter(s=>(s.metadata?.material_role==='change')===(kind==='change'));
    const batches=budgetedBatches(slices,Math.max(6000,Math.min(24000,budget/2)),s=>JSON.stringify(flatCatalog([s])));
    for(const batch of batches){const identity=batch.map(s=>({id:s.id,body_hash:hash(s.body),scope:readingScope(s.metadata)}));result.push({part_id:hash(['source-digest-v2-isolated',repositoryId,caseId||null,kind,identity]),case_id:caseId,repository_id:repositoryId,material_kind:kind,sources:batch});}
  }
  return result;
}

type PendingDigest={promise:Promise<any>;resolve:(value:any)=>void;reject:(error:any)=>void;done:boolean};
const digestMemo=new Map<string,PendingDigest>();
export async function readDigestUnits(run:any,units:DigestUnit[],call:ManagementRunner,budget:number,parallel:number){
  const owned:{key:string;unit:DigestUnit;entry:PendingDigest}[]=[];
  const futures=units.map(unit=>{const key=run.id+':'+unit.part_id;let entry=digestMemo.get(key);if(!entry){let resolve!:(value:any)=>void,reject!:(error:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});entry={promise,resolve,reject,done:false};digestMemo.set(key,entry);owned.push({key,unit,entry});}return entry.promise;});
  if(owned.length){try{const results=await produceDigestUnits(run,owned.map(o=>o.unit),call,budget,parallel);for(let i=0;i<owned.length;i++){owned[i].entry.done=true;owned[i].entry.resolve(results[i]);}}catch(error){for(const item of owned){digestMemo.delete(item.key);item.entry.reject(error);}throw error;}}
  if(digestMemo.size>10000)for(const [key,value] of digestMemo){if(digestMemo.size<=10000)break;if(value.done)digestMemo.delete(key);}
  return Promise.all(futures);
}
function readerInput(unit:DigestUnit){return {unit_key:'unit_'+unit.part_id,repository_id:unit.repository_id,material_kind:unit.material_kind,source_catalog:readingCatalog(unit.sources),required_change_citation_refs:changedCitationRefs(unit),...(unit.input_kind?{input_kind:unit.input_kind,prior_change_facts:unit.prior_change_facts,prior_part_ids:unit.prior_part_ids}:{})};}
function digestResult(unit:DigestUnit,value:any){return {...value,part_id:unit.part_id,case_id:unit.case_id,repository_id:unit.repository_id,material_kind:unit.material_kind,input_kind:unit.input_kind||'full_source',...(unit.prior_part_ids?{prior_part_ids:unit.prior_part_ids}:{}),citations:bindCitations(value.citations,unit.sources),source_slices:unit.sources.map(s=>({source_id:s.id,source_evidence_id:s.metadata?.source_evidence_id,position:s.metadata?.source_slice,material_role:s.metadata?.material_role}))};}
async function reuseLiteralUnits(run:any,units:DigestUnit[],outputs:Map<string,any>){
  if(!run.parent_run_id||units.every(u=>outputs.has(u.part_id)))return;
  const parent=(await db.query('SELECT id FROM evaluation_runs WHERE id=$1 AND collection_id=$2 AND configuration_id=$3 AND model=$4::jsonb',[run.parent_run_id,run.collection_id,run.configuration_id,JSON.stringify(run.model)])).rows[0];if(!parent)return;
  const pending=new Map(units.filter(u=>!outputs.has(u.part_id)).map(u=>['unit_'+u.part_id,u]));
  const traces=(await db.query("SELECT * FROM ai_traces WHERE evaluation_id=$1 AND stage='source_digest_batch' AND status IN ('succeeded','reused') AND response_ref IS NOT NULL ORDER BY created_at DESC",[parent.id])).rows;
  for(const trace of traces){if(!pending.size)break;const pack=JSON.parse((await readRaw(trace.input_ref)).toString());if(pack.input.units?.length!==1||pack.parser_version!=='functional-impact-v1'||pack.system!==managementPolicies.source_digest_batch||pack.prompt_revision!==hash(managementPolicies.source_digest_batch))continue;
    const response=JSON.parse((await readRaw(trace.response_ref)).toString());if(response.info?.modelID!==run.model.model_id||response.info?.providerID!==run.model.provider_id)continue;
    for(const old of pack.input.units||[]){const unit=pending.get(old.unit_key);if(!unit||!isDeepStrictEqual(canonicalValue(readerInput(unit)),canonicalValue(old)))continue;
      const value=response.info?.structured?.results?.[old.unit_key];try{validateDigestOutput(unit,value);}catch{continue;}
      // Preserve the actual original batch request, schema and response. The
      // new unit's current contract is checked separately; no new call is claimed.
      await db.query("INSERT INTO ai_traces(id,evaluation_id,stage,input_hash,input_ref,response_ref,session_id,requested_model,observed_model,runtime_version,status,reused_from_trace) VALUES($1,$2,'source_digest_batch',$3,$4,$5,$6,$7,$8,$9,'reused',$10) ON CONFLICT DO NOTHING",[hash([run.id,'literal-unit-reuse',trace.id]),run.id,trace.input_hash,trace.input_ref,trace.response_ref,trace.session_id,run.model,trace.observed_model,trace.runtime_version,trace.id]);
      const result={...digestResult(unit,value),reused_unit_validation:{from_trace_id:trace.id,contract_hash:hash(canonicalValue(digestSchema(unit))),version:'literal-source-unit-validated-v1'}};
      const inserted=(await db.query('INSERT INTO management_digest_parts(evaluation_id,part_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING output',[run.id,unit.part_id,unit.repository_id,result])).rows[0];outputs.set(unit.part_id,inserted?.output||(await db.query('SELECT output FROM management_digest_parts WHERE evaluation_id=$1 AND part_id=$2',[run.id,unit.part_id])).rows[0].output);pending.delete(old.unit_key);
    }
  }
}
async function produceDigestUnits(run:any,units:DigestUnit[],call:ManagementRunner,budget:number,parallel:number){
  const saved=(await db.query('SELECT part_id,output FROM management_digest_parts WHERE evaluation_id=$1',[run.id])).rows;
  const outputs=new Map<string,any>(saved.map(r=>[r.part_id,r.output]));
  await reuseLiteralUnits(run,units,outputs);
  await db.query("UPDATE evaluation_runs SET summary=summary||jsonb_build_object('source_digest_parts_complete',(SELECT count(*) FROM management_digest_parts WHERE evaluation_id=$1 AND output->>'case_id' IS NOT NULL AND COALESCE(output->>'input_kind','full_source')='full_source'),'context_digest_parts_complete',(SELECT count(*) FROM management_digest_parts WHERE evaluation_id=$1 AND output->>'case_id' IS NULL)) WHERE id=$1",[run.id]);
  // Preserve batch boundaries on resume so completed units do not reshuffle
  // the remaining reader inputs and invalidate exact source-read reuse.
  const batches=budgetedBatches(units,Math.max(6000,budget-8000),u=>JSON.stringify({unit_key:'unit_'+u.part_id,repository_id:u.repository_id,material_kind:u.material_kind,source_catalog:readingCatalog(u.sources)})).flatMap(batch=>Array.from({length:Math.ceil(batch.length/1)},(_,i)=>batch.slice(i,i+1))).filter(batch=>batch.some(u=>!outputs.has(u.part_id)));
  await mapLimit(batches,parallel,async batch=>{
    const properties=Object.fromEntries(batch.map(u=>['unit_'+u.part_id,digestSchema(u)]));const schema=obj({results:obj(properties)});
    const input={repository_id:batch[0].repository_id,units:batch.map(readerInput)};
    const validate=(out:any)=>{validateSchema(schema,out);for(const unit of batch){const value=out.results['unit_'+unit.part_id];validateDigestOutput(unit,value);}};
    let output:any,lastError:any,feedback='';for(let attempt=0;attempt<3;attempt++){try{output=await call('source_digest_batch',{...input,validation_feedback:feedback},schema,validate);break;}catch(error){lastError=error;feedback=redact(error);if(permanentLlmError(error)||(error as any)?.name==='AbortError'||/operation (?:was )?aborted/i.test(feedback))throw error;}}
    if(!output){if(batch.length===1)throw lastError;for(const unit of batch){const [result]=await produceDigestUnits(run,[unit],call,budget,1);outputs.set(unit.part_id,result);}return;}
    for(const unit of batch){const value=output.results['unit_'+unit.part_id];const result={...value,part_id:unit.part_id,case_id:unit.case_id,repository_id:unit.repository_id,material_kind:unit.material_kind,input_kind:unit.input_kind||'full_source',...(unit.prior_part_ids?{prior_part_ids:unit.prior_part_ids}:{}),citations:bindCitations(value.citations,unit.sources),source_slices:unit.sources.map(s=>({source_id:s.id,source_evidence_id:s.metadata?.source_evidence_id,position:s.metadata?.source_slice,material_role:s.metadata?.material_role}))};const inserted=(await db.query('INSERT INTO management_digest_parts(evaluation_id,part_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING output',[run.id,unit.part_id,unit.repository_id,result])).rows[0];const persisted=inserted?.output||(await db.query('SELECT output FROM management_digest_parts WHERE evaluation_id=$1 AND part_id=$2',[run.id,unit.part_id])).rows[0].output;outputs.set(unit.part_id,persisted);}
    await db.query("UPDATE evaluation_runs SET summary=summary||jsonb_build_object('source_digest_parts_complete',(SELECT count(*) FROM management_digest_parts WHERE evaluation_id=$1 AND output->>'case_id' IS NOT NULL AND COALESCE(output->>'input_kind','full_source')='full_source'),'context_digest_parts_complete',(SELECT count(*) FROM management_digest_parts WHERE evaluation_id=$1 AND output->>'case_id' IS NULL)) WHERE id=$1",[run.id]);
  });
  return units.map(u=>outputs.get(u.part_id));
}

export async function collectCaseDigests(run:any,cases:any[],evidence:any[],materials:Map<string,DocumentMaterial>,call:ManagementRunner,budget:number,parallel:number){
  const prepared=new Map<string,DigestUnit[]>();
  for(const c of cases){
    const sources:Source[]=[];
    for(const id of c.evidence_ids){const row=evidence.find(e=>e.id===id)!;const doc=materials.get(id);const primary=!doc||doc.status==='document_creation';const allowed=[...new Set(c.roles.filter((r:any)=>r.evidence_id===id).map((r:any)=>r.person_id))];
      sources.push({id:row.id,title:row.title,url:row.url,body:row.body,metadata:{...row.metadata,evidence_kind:row.kind,material_role:primary?'change':'existing_context',not_personal_credit:!primary,allowed_person_ids:primary?allowed:[],source_evidence_id:row.id}});
      if(doc?.source)sources.push({...doc.source,metadata:{...doc.source.metadata,material_role:'change',not_personal_credit:false,allowed_person_ids:allowed}});
    }
    prepared.set(c.case_id,digestUnits(c.repository_id,sources,budget,c.case_id));
  }
  await db.query("UPDATE evaluation_runs SET summary=summary||jsonb_build_object('source_digest_parts_expected',$2::int,'source_reader_contract','isolated-unit-v2','source_reader_prompt_revision',$3::text) WHERE id=$1",[run.id,[...prepared.values()].flat().length,hash(managementPolicies.source_digest_batch)]);
  const correctionIds=new Set((run.corrections||[]).flatMap((c:any)=>c.evidence_ids||[]));
  const priority=(u:DigestUnit)=>[u.sources.some(s=>correctionIds.has(s.metadata?.source_evidence_id||s.id))?0:1,u.sources.some(s=>s.metadata?.allowed_person_ids?.length)?0:1,u.material_kind==='change'?0:1,u.sources.reduce((n,s)=>n+s.body.length,0)];
  const readingOrder=[...prepared.values()].flat().sort((a,b)=>{const x=priority(a),y=priority(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return a.part_id.localeCompare(b.part_id);});
  const all=await readDigestUnits(run,readingOrder,call,budget,parallel);const byId=new Map(all.map(p=>[p.part_id,p]));const facts=new Map<string,any>();
  for(const c of cases){const parts=prepared.get(c.case_id)!.map(u=>byId.get(u.part_id));let changes=parts.filter(p=>p.material_kind==='change');
    const size=(p:any)=>JSON.stringify({facts:conciseChangeFacts({change_parts:[p]}),quotes:uniqueQuotedSources(p.citations)});
    while(changes.length>1&&changes.reduce((n,p)=>n+size(p).length,0)>Math.max(3000,budget/3)){let groups=budgetedBatches(changes,Math.max(3000,budget/4),size);if(groups.every(g=>g.length===1))groups=Array.from({length:Math.ceil(changes.length/2)},(_,i)=>changes.slice(i*2,i*2+2));const next:any[]=[];for(const group of groups){if(group.length===1){next.push(group[0]);continue;}const sources=uniqueQuotedSources(group.flatMap(p=>p.citations));const unit:DigestUnit={part_id:hash(['derived-change-summary-v1',c.case_id,group.map(p=>p.part_id)]),case_id:c.case_id,repository_id:c.repository_id,material_kind:'change',sources,input_kind:'derived_change_summary',prior_change_facts:conciseChangeFacts({change_parts:group}),prior_part_ids:group.map(p=>p.part_id)};next.push(...await readDigestUnits(run,[unit],call,budget,1));}changes=next;}
    const value={case_id:c.case_id,repository_id:c.repository_id,evidence_ids:c.evidence_ids,change_parts:changes,context_parts:parts.filter(p=>p.material_kind==='existing_context'),part_ids:parts.map(p=>p.part_id),summary_part_ids:changes.map(p=>p.part_id),coverage_complete:true};await db.query('INSERT INTO management_case_facts(evaluation_id,case_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,c.case_id,c.repository_id,value]);facts.set(c.case_id,value);}
  return facts;
}

export function conciseChangeFacts(fact:any){return fact.change_parts.map((p:any)=>({functional_goal:p.functional_goal,change_summary:p.change_summary,behavior_before:p.behavior_before,behavior_after:p.behavior_after,knowledge_kind:p.knowledge_kind,verification_observed:p.verification_observed,limitations:p.limitations}));}
