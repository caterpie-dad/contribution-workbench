import {db,transaction} from '../db.js';
import {hash,redact} from '../config.js';
import {arr,obj,str,strings,budgetedBatches,validateSchema,requirePlainBrief} from './contracts.js';
import {ManagementRunner,conciseChangeFacts} from './digests.js';
import {mapLimit} from '../evaluation/cases.js';

export function requireFunctionalGoal(name:string,goal:string){
  requirePlainBrief(name);requirePlainBrief(goal);
  if(/다양한\s*기능\s*개선|기능\s*개선\s*묶음|단일\s*그룹|기능\s*묶음.*(?:통합|관리|집계)/.test(name+' '+goal))throw new Error('분류·검토·집계 작업을 기능 목표로 쓰지 마세요. 실제 사용자 기능과 바뀐 동작을 구체적으로 쓰고 목적이 다른 기능은 별도 묶음으로 나누세요');
}
function partition(expected:string[],groups:any[],key:string){const actual=groups.flatMap(g=>g[key]),missing=expected.filter(id=>!actual.includes(id)),duplicates=[...new Set(actual.filter((id,i)=>actual.indexOf(id)!==i))],unknown=actual.filter(id=>!expected.includes(id));if(missing.length||duplicates.length||unknown.length)throw new Error('기능 묶음의 사례 누락·중복·알 수 없는 참조: '+JSON.stringify({missing,duplicates,unknown}));}
async function invoke(call:ManagementRunner,stage:string,input:any,schema:any,validate:(out:any)=>void){let feedback='';for(let attempt=0;attempt<3;attempt++){try{return await call(stage,{...input,validation_feedback:feedback},schema,validate);}catch(error){feedback=redact(error);if(attempt===2)throw error;}}}

export async function groupFunctionalCases(run:any,profile:any,cases:any[],facts:Map<string,any>,call:ManagementRunner,budget:number,parallel=2){
  if(!cases.length)return [];
  const saved=(await db.query('SELECT output FROM feature_plan_groups WHERE evaluation_id=$1 AND repository_id=$2',[run.id,profile.repository_id])).rows.map(r=>r.output);
  if(saved.length&&saved.flatMap(g=>g.case_ids||[]).length===cases.length&&cases.every(c=>saved.some(g=>g.case_ids?.includes(c.case_id))))return saved;
  const personalCases=cases.filter(c=>c.roles?.length),contextCases=cases.filter(c=>!c.roles?.length);
  const catalog=personalCases.map((c,i)=>({case_ref:'case_'+(i+1),source_ids:c.evidence_ids,title:c.title,files:c.files,changes:conciseChangeFacts(facts.get(c.case_id)),context_only:!facts.get(c.case_id).change_parts.length}));
  const repo={repository_id:profile.repository_id,system_purpose:profile.system_purpose,capabilities:profile.capabilities};
  const chunks=budgetedBatches(catalog,Math.max(6000,budget-16000),x=>JSON.stringify(x)).flatMap(batch=>Array.from({length:Math.ceil(batch.length/6)},(_,i)=>batch.slice(i*6,i*6+6)));let groups:any[]=[];
  const groupSchema=(refs:string[],field='case_refs')=>obj({groups:arr(obj({name:str,goal:str,capability_ref:{type:'integer',enum:profile.capabilities.map((c:any)=>c.capability_ref)},[field]:arr({type:'string',enum:refs})}))});
  for(const batch of chunks){const refs=batch.map(c=>c.case_ref),schema=groupSchema(refs);const out=await invoke(call,'functional_case_grouping',{repository:repo,cases:batch},schema,out=>{validateSchema(schema,out);partition(refs,out.groups,'case_refs');for(const g of out.groups){requireFunctionalGoal(g.name,g.goal);}});groups.push(...out.groups);}
  // Even one input batch can fragment implementation, follow-up, tests and
  // documentation. Always compare their goals before creating final reports.
  const consolidate=async(initial:any[])=>{
    let layer=initial;
    for(let round=0;round<3&&layer.length>1;round++){
      const before=layer.length;
      const registry=layer.map((g,i)=>({group_ref:'group_'+(i+1),name:g.name,goal:g.goal,capability_ref:g.capability_ref,case_count:g.case_refs.length,change_goals:catalog.filter(c=>g.case_refs.includes(c.case_ref)).map(c=>({case_ref:c.case_ref,functional_goals:c.changes.map((p:any)=>p.functional_goal)}))}));
      const batches=budgetedBatches(registry,Math.max(6000,budget-12000),g=>JSON.stringify(g));const next:any[]=[];
      for(const batch of batches){
        const refs=batch.map(g=>g.group_ref);
        // Select a real development goal. The model cannot replace all goals
        // with an invented report about its own grouping/management activity.
        const schema=obj({groups:arr(obj({canonical_ref:{type:'string',enum:refs},group_refs:arr({type:'string',enum:refs})}))});
        const out=await invoke(call,'functional_group_merge',{repository:repo,groups:batch},schema,out=>{validateSchema(schema,out);partition(refs,out.groups,'group_refs');for(const g of out.groups)if(!g.group_refs.includes(g.canonical_ref))throw new Error('기능 통합의 대표 목표는 해당 묶음에 포함된 실제 과제여야 합니다');});
        for(const g of out.groups){const canonical=layer[Number(g.canonical_ref.slice(6))-1];next.push({...canonical,case_refs:g.group_refs.flatMap((ref:string)=>layer[Number(ref.slice(6))-1].case_refs)});}
      }
      // Once all candidates were compared together, further contraction would
      // hide their different goals behind the chosen representative names.
      layer=next;if(batches.length===1||layer.length===before)break;
    }
    return layer;
  };
  groups=await consolidate(groups);
  partition(catalog.map(c=>c.case_ref),groups,'case_refs');
  let reviews:any[]=[];
  for(let attempt=0;attempt<2;attempt++){
    const work=groups.flatMap((group,index)=>{const selected=catalog.filter(c=>group.case_refs.includes(c.case_ref));const batches=budgetedBatches(selected,Math.max(6000,budget-16000),c=>JSON.stringify(c)).flatMap(batch=>Array.from({length:Math.ceil(batch.length/6)},(_,i)=>batch.slice(i*6,i*6+6)));return batches.map(batch=>({group,index,batch,partial:batches.length>1}));});
    reviews=new Array(work.length);
    await mapLimit(work,parallel,async(item)=>{const {group,index,batch,partial}=item;const schema=obj({acceptable:{type:'boolean'},issues:arr(obj({case_refs:arr({type:'string',enum:batch.map(c=>c.case_ref)}),reason:str}))});const review=await invoke(call,'functional_group_review',{repository:repo,group:{name:group.name,goal:group.goal},cases:batch,scope:{group_index:index+1,partial_group:partial}},schema,out=>validateSchema(schema,out));reviews[work.indexOf(item)]={group_index:index,...review};});
    const issues=reviews.flatMap(r=>r.issues);if(!issues.length||attempt===1||chunks.length>1)break;
    // This is the corrective partition with all change facts and the critic's
    // reasons. Do not merge it again from representative names alone.
    const refs=catalog.map(c=>c.case_ref),schema=groupSchema(refs);const out=await invoke(call,'functional_case_grouping',{repository:repo,cases:catalog,previous_groups:groups,review_feedback:issues},schema,out=>{validateSchema(schema,out);partition(refs,out.groups,'case_refs');for(const g of out.groups)requireFunctionalGoal(g.name,g.goal);});groups=out.groups;
  }
  const result=groups.map((g,index)=>{const ids=g.case_refs.map((ref:string)=>personalCases[Number(ref.slice(5))-1].case_id).sort();const cap=profile.capabilities.find((c:any)=>c.capability_ref===g.capability_ref);const checked=reviews.filter(r=>r.group_index===index),issues=checked.flatMap(r=>r.issues);const id=hash([profile.repository_id,ids]);return {...g,group_id:id,initiative_id:id,initiative_ids:[id],initiative_ref:index+1,repository_id:profile.repository_id,case_ids:ids,capability_id:cap.capability_id,capability_name:cap.name,grouping_generation:'llm_atomic_case_goal_grouping',grouping_review:{status:issues.length||checked.some(r=>r.acceptable===false)?'needs_manager_review':'reviewed_by_ai',issues,review_count:checked.length,all_cases_reviewed:true}};});
  if(contextCases.length){
    const ids=contextCases.map(c=>c.case_id).sort(),id=hash([profile.repository_id,ids]),cap=profile.capabilities.find((c:any)=>c.name==='유지보수·통합')||profile.capabilities[0];
    result.push({name:'다른 작성자의 변경 · 시스템 배경',goal:'등록된 팀원의 역할이 없는 변경은 전체 원문 색인과 시스템 배경으로 보존하며 개인 성과로 평가하지 않는다.',group_id:id,initiative_id:id,initiative_ids:[id],initiative_ref:result.length+1,repository_id:profile.repository_id,case_ids:ids,capability_ref:cap.capability_ref,capability_id:cap.capability_id,capability_name:cap.name,grouping_generation:'rule_unassigned_context',grouping_review:{status:'not_applicable_context',issues:[],review_count:0,all_cases_reviewed:true}});
  }
  await transaction(async client=>{for(const group of result){await client.query('INSERT INTO feature_plans(evaluation_id,initiative_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,group.group_id,profile.repository_id,group]);await client.query('INSERT INTO feature_plan_groups(evaluation_id,group_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,group.group_id,profile.repository_id,group]);for(const caseId of group.case_ids){const c=cases.find(c=>c.case_id===caseId)!;await client.query('INSERT INTO feature_assignments(evaluation_id,case_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,caseId,profile.repository_id,{case_id:caseId,initiative_id:group.group_id,capability_id:group.capability_id,capability_name:group.capability_name,reason:group.goal,evidence_ids:c.evidence_ids}]);}}});
  return result;
}
