import path from 'node:path';
import {db} from '../db.js';
import {redact,TeamConfig} from '../config.js';
import {git} from '../collectors/github.js';
import {storeManagementSource,Source} from './context.js';
import {DocumentMaterial} from './documents.js';
import {ManagementRunner,conciseChangeFacts,digestUnits,readDigestUnits,uniqueQuotedSources} from './digests.js';
import {arr,obj,str,strings,level,flatCatalog,citationsSchema,bindCitations,bindDeficitCitations,budgetedBatches,validateSchema,requirePlainBrief} from './contracts.js';
import {dimensions} from '../evaluation/schemas.js';
import {sourceProfile} from '../evaluation/provenance.js';
import {readableObservation} from './wording.js';
import {functionalExecutionEvidence,executionObservation,rejectUnobservedExecution} from './observability.js';

function quoteSchema(refs:number[],required=true){return {...arr(obj({citation_ref:{type:'integer',enum:refs.length?refs:[0]}})),minItems:required&&refs.length?1:0,maxItems:refs.length?6:0};}
const narrative=(description:string)=>({...str,minLength:4,description});
function checkNarrative(value:string){requirePlainBrief(value);if(!/[가-힣]/.test(value))throw new Error('커밋 제목을 복사하지 말고 실제 기능의 변화·영향·개인의 범위를 한국어 문장으로 설명하세요');}
export function functionalFeatureSchema(sources:Source[],people:any[],roles?:any[],executions?:any[]){
  const pool=flatCatalog(sources),primary=pool.filter(s=>s.source_scope?.material_role==='change'&&!s.source_scope?.not_personal_credit).flatMap(s=>s.citation_spans.map(c=>c.citation_ref));
  const end=pool.filter(s=>s.source_scope?.at_period_end).flatMap(s=>s.citation_spans.map(c=>c.citation_ref));
  const members=people.flatMap((p,i)=>{
    const ownSources=pool.filter(s=>!s.source_scope?.not_personal_credit&&s.source_scope?.allowed_person_ids?.includes(p.person_id));
    const refs=(selected:any[])=>selected.flatMap(s=>s.citation_spans.map((c:any)=>c.citation_ref));const own=refs(ownSources);if(!own.length)return [];
    const observed=roles?.filter(r=>r.person_id===p.person_id);
    const matching=(source:any)=>observed?.filter(r=>r.evidence_id===(source.source_scope?.source_evidence_id||source.source_id))||[];
    const supported=(predicate:(r:any)=>boolean)=>refs(ownSources.filter(s=>matching(s).some(predicate)));
    const choices:{scopes:string[];refs:number[]}[]=[];
    if(!roles)choices.push({scopes:['implementation','coauthored_implementation','verification','documentation','review','integration','unclear'],refs:own});
    else {
      const impl=supported(r=>r.implementation_eligible&&r.contribution_scope!=='integration_only');if(impl.length)choices.push({scopes:['implementation','coauthored_implementation'],refs:impl});
      const tests=supported(r=>r.substantive_test_change&&r.contribution_scope!=='integration_only');if(tests.length)choices.push({scopes:['verification'],refs:tests});
      const docs=supported(r=>r.contribution_scope!=='integration_only'&&['commit','wiki_page','docs_page','attachment_text'].includes(r.source_kind));if(docs.length)choices.push({scopes:['documentation'],refs:docs});
      const review=supported(r=>r.source_kind==='review'||r.source_kind.includes('comment'));if(review.length)choices.push({scopes:['review'],refs:review});
      const integration=supported(r=>r.contribution_scope==='integration_only'||r.source_kind==='commit');if(integration.length)choices.push({scopes:['integration'],refs:integration});
      choices.push({scopes:['unclear'],refs:own});
    }
    return choices.map(choice=>obj({person_ref:{type:'integer',enum:[i+1]},contribution:narrative('이 사람의 실제 변경들이 이 기능에서 어떤 역할과 효과를 가지는지 한국어 문장으로 설명한다. 커밋 제목·파일 수정 목록을 그대로 복사하지 않는다. 다른 사람의 구현·테스트를 귀속하지 않는다.'),scope:{type:'string',enum:choice.scopes},citations:quoteSchema(choice.refs)}));
  });
  const memberRefs=[...new Set(members.map(m=>m.properties.person_ref.enum[0]))];
  const memberMap=obj(Object.fromEntries(memberRefs.map(ref=>['person_'+ref,{anyOf:members.filter(m=>m.properties.person_ref.enum[0]===ref)}])));
  const general=primary.length?quoteSchema(primary):{...citationsSchema(sources,true),maxItems:6};
  const deficitOwners=[{people:[] as number[],refs:primary}];
  for(const [i,p] of people.entries()){const own=pool.filter(s=>!s.source_scope?.not_personal_credit&&s.source_scope?.allowed_person_ids?.includes(p.person_id)).flatMap(s=>s.citation_spans.map(c=>c.citation_ref));if(own.length)deficitOwners.push({people:[i+1],refs:own});}
  const deficitVariants=deficitOwners.flatMap(owner=>{
    const fields={description:str,affected_person_refs:{...arr({type:'integer',enum:owner.people.length?owner.people:[0]}),minItems:owner.people.length,maxItems:owner.people.length},affected_dimensions:arr({type:'string',enum:[...dimensions]}),citations:owner.people.length?quoteSchema(owner.refs):general};
    const past=obj({...fields,status:{type:'string',enum:['resolved_in_later_evidence','resolution_unknown']},period_end_citation_ref:{type:['integer','null'],enum:[null,...end]}});
    return end.length?[obj({...fields,status:{type:'string',enum:['present_at_period_end']},period_end_citation_ref:{type:'integer',enum:end}}),past]:[past];
  });
  const deficitItem={anyOf:deficitVariants};
  return obj({title:narrative('개발·개선한 사용자 기능의 한국어 이름. 보고·평가·분류 작업의 이름을 쓰지 않는다.'),previous_limitation:narrative('실제 변경 전 사용자의 기능 제약 또는 구현의 한계. 평가 입력·맥락 요약 방식의 설명은 쓰지 않는다. 확인할 수 없으면 그 한계를 명시한다.'),change_summary:narrative('관련 변경 전체가 합쳐져 사용자 기능에서 달라진 점. 보고서 작성 행위나 커밋 목록을 쓰지 않는다.'),system_significance:narrative('이 기능의 변화가 해당 시스템에서 가지는 의미와 범위. 실측되지 않은 효과는 예상으로 구분한다.'),impacts:{...arr(obj({kind:{type:'string',enum:['capability','reliability','security','performance','maintainability','developer_experience','verification','knowledge']},basis:{type:'string',enum:['observed_change','expected_effect','reported_outcome']},description:str,citations:general})),maxItems:6},difficulty:obj({level,reason:str}),quality_assessment:narrative('전체 변경의 정확성·완결성·검증을 관찰 근거와 한계로 설명한다. 부분 보고에서 관찰하지 못한 것이 전체 기능에 없다는 뜻은 아니다.'),observed_deficits:{...arr(deficitItem),maxItems:6},verification:obj({observed:executions?{type:'string',enum:[executionObservation(executions)]}:narrative('실제로 관찰한 코드·테스트·실행 결과의 범위. 테스트 코드와 실행 성공은 구분한다.'),not_verified:narrative('제공된 자료로 확인하지 못한 실행·운영·효과의 범위. 빈 문자열로 생략하지 않는다.')}),member_contributions:memberMap,counter_evidence:strings,limitations:{...strings,description:'전체 변경에 적용되는 관찰 한계만 쓴다. 부분 보고의 문서만 변경·로직 변경 없음 같은 범위를 전체로 일반화하지 않는다.'},citations:general});
}

async function attempt(call:ManagementRunner,stage:string,input:any,schema:any,validate:(out:any)=>void){let feedback='';for(let n=0;n<3;n++){try{return await call(stage,{...input,validation_feedback:feedback},schema,validate);}catch(error){feedback=redact(error);if(n===2)throw error;}}}
function allCitations(p:any){return [...(p.citations||[]),...(p.impacts||[]).flatMap((i:any)=>i.citations),...(p.member_contributions||[]).flatMap((m:any)=>m.citations),...(p.observed_deficits||[]).flatMap((d:any)=>d.citations)];}
export function backgroundSerialization(value:any){return JSON.stringify(value,(key,item)=>key==='reused_unit_validation'?undefined:item);}
export function existingContextAtPeriodEnd(parts:any[],sources:Source[],evidence:any[]){
  const paths=new Set(sources.filter(s=>s.metadata?.at_period_end).map(s=>s.metadata?.path).filter(Boolean)),byId=new Map(evidence.map(e=>[e.id,e]));
  const retained:any[]=[],superseded:string[]=[];
  for(const part of parts){const replaced=part.source_slices?.length&&part.source_slices.every((slice:any)=>{const e=byId.get(slice.source_evidence_id||slice.source_id);return e?.kind==='docs_page'&&paths.has(e.metadata?.path);});if(replaced)superseded.push(part.part_id);else retained.push(part);}
  return {parts:retained,superseded_part_ids:superseded};
}

export function memberChangeFacts(people:any[],cases:any[],facts:Map<string,any>){
  return Object.fromEntries(people.map((person,index)=>['person_'+(index+1),{
    person_id:person.person_id,
    changes:cases.flatMap(c=>{
      const roles=c.roles.filter((r:any)=>r.person_id===person.person_id);
      const ownIds=new Set(roles.map((r:any)=>r.evidence_id));
      const parts=facts.get(c.case_id).change_parts.filter((p:any)=>p.citations.some((q:any)=>!q.source_scope?.not_personal_credit&&ownIds.has(q.source_evidence_id||q.source_id)));
      return roles.length&&parts.length?[{case_id:c.case_id,source_ids:[...ownIds],roles,changes:conciseChangeFacts({change_parts:parts})}]:[];
    })
  }]));
}
function partialReportInput(report:any){return {...report,member_contributions:Object.fromEntries(report.member_contributions.map((m:any)=>['person_'+m.person_ref,m]))};}

export function correctionQuoteSources(corrections:any[],rows:any[],contexts:Source[],roles:any[]):Source[]{
  const result:Source[]=[];
  for(const correction of corrections)for(const citation of correction.after_value?.citations||[]){
    const row=rows.find(r=>r.id===citation.evidence_id);if(!row||!row.body.includes(citation.quote))continue;
    const primary=row.kind==='commit'&&!row.metadata.merge;
    result.push({id:row.id,title:row.title,url:row.url,body:citation.quote,metadata:{source_evidence_id:row.id,evidence_kind:row.kind,material_role:primary?'change':'existing_context',not_personal_credit:!primary,allowed_person_ids:primary?[...new Set(roles.filter(r=>r.evidence_id===row.id).map(r=>r.person_id))]:[]}});
    for(const context of contexts)if(context.metadata?.at_period_end&&context.body.includes(citation.quote))result.push({...context,body:citation.quote});
  }
  return result;
}
export async function buildFunctionalFeature(run:any,t:TeamConfig,profile:any,group:any,cases:any[],evidence:any[],snapshots:any[],facts:Map<string,any>,materials:Map<string,DocumentMaterial>,call:ManagementRunner,budget:number){
  const id=group.group_id,existing=(await db.query('SELECT output FROM feature_reports WHERE evaluation_id=$1 AND feature_id=$2',[run.id,id])).rows[0];if(existing)return existing.output;
  const ids=[...new Set(cases.flatMap(c=>c.evidence_ids))] as string[],rows=ids.map(id=>evidence.find(e=>e.id===id)!);
  const executions=functionalExecutionEvidence(evidence,rows,t.period.as_of);
  const people=t.members.filter(p=>cases.some(c=>c.roles.some((r:any)=>r.person_id===p.person_id))),peopleCatalog=people.map((p,i)=>({person_ref:i+1,person_id:p.person_id,role_profile:p.role_profile}));
  const inspectableIds=new Set(rows.filter(e=>sourceProfile(e).inspectable_material).map(e=>e.id));
  const primaryCases=cases.filter(c=>c.roles.some((r:any)=>inspectableIds.has(r.evidence_id)&&facts.get(c.case_id).change_parts.some((p:any)=>p.citations.some((q:any)=>!q.source_scope?.not_personal_credit&&(q.source_evidence_id||q.source_id)===r.evidence_id))));
  const contextCaseIds=cases.filter(c=>!primaryCases.includes(c)).map(c=>c.case_id);
  const noTeamRole=cases.every(c=>!c.roles.length),hasChangedMaterial=primaryCases.length>0;
  if(noTeamRole||!hasChangedMaterial){
    // All primary bytes were already read by collectCaseDigests. No registered
    // role, or no inspectable change, is a rule-based exclusion/deferral.
    const parts=cases.flatMap(c=>[...facts.get(c.case_id).change_parts,...facts.get(c.case_id).context_parts]);const snapshot=snapshots.find(s=>s.repository_id===profile.repository_id);
    const delivery=rows.filter(e=>e.kind==='commit').map(e=>snapshot?.delivery[e.id]).filter(Boolean);
    const reason=noTeamRole?'등록된 팀원의 역할과 연결되지 않은 변경은 배경으로 보존하며 개인 기여로 평가하지 않습니다.':'귀속 가능한 변경 또는 인용 가능한 내용이 부족해 기능 기여 판정을 보류합니다.';
    const output={title:group.name,previous_limitation:'개인의 기능 기여에 대한 판정 대상 또는 관찰 근거가 부족합니다.',change_summary:reason,system_significance:reason,impacts:[],difficulty:{level:null,reason},quality_assessment:reason,observed_deficits:[],verification:{observed:executionObservation(executions),not_verified:'개인의 기능 개선 범위·실행·성과는 이 기록만으로 확정하지 않습니다.'},member_contributions:[],counter_evidence:[],limitations:[reason],citations:parts.flatMap(p=>p.citations).slice(0,6),feature_id:id,repository_id:profile.repository_id,initiative_ids:group.initiative_ids,initiative_name:group.name,capability_id:group.capability_id,capability_name:group.capability_name,evidence_ids:ids,case_ids:cases.map(c=>c.case_id),recorded_roles:cases.flatMap(c=>c.roles),factual_review:{unsupported_claims:[],observation_limits:[reason]},grouping_review:group.grouping_review,execution_evidence:executions,context_source_ids:[],material_status:Object.fromEntries(rows.filter(e=>materials.has(e.id)).map(e=>[e.id,materials.get(e.id)!.status])),coverage:{source_ids:ids,case_fact_ids:cases.map(c=>c.case_id),digest_part_ids:cases.flatMap(c=>facts.get(c.case_id).part_ids),context_digest_part_ids:[],primary_case_ids:[],context_case_ids:cases.map(c=>c.case_id),input_kind:'full_source_digests_then_functional_report',feature_synthesis_calls:0,all_batches_processed:true},delivery:{default_branch_commits:delivery.filter(d=>d.in_period_end_default_branch).map(d=>d.commit_sha),branch_only_commits:delivery.filter(d=>!d.in_period_end_default_branch).map(d=>d.commit_sha),production_deployment:'not_observed'},deduplication:cases.map(c=>({case_id:c.case_id,basis:c.deduplication_basis,evidence_ids:c.evidence_ids})),generation:noTeamRole?'rule_context_only':'rule_insufficient_changed_material',status:noTeamRole?'context_not_personal_credit':'insufficient_changed_material'};
    await db.query('INSERT INTO feature_reports(evaluation_id,feature_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,id,profile.repository_id,output]);return output;
  }
  const contextSources:Source[]=[],contextLimitations:string[]=[];const snapshot=snapshots.find(s=>s.repository_id===profile.repository_id);
  const directContextCases=cases.filter(c=>c.roles.some((r:any)=>r.contribution_scope!=='integration_only'));
  if(!directContextCases.length)contextLimitations.push('병합 기록만으로 타인이 작성한 전체 파일을 개인 구현 품질의 근거로 확장하지 않습니다. 실제 충돌 해결·검증에는 추가 근거가 필요합니다.');
  if(snapshot?.anchor){const repo=t.repositories.find(r=>r.repository_id===profile.repository_id)!;const dir=path.resolve(repo.mirror_path||rows.find(e=>e.metadata.mirror_path)?.metadata.mirror_path||'');
    for(const file of [...new Set(directContextCases.flatMap(c=>c.files))] as string[]){if(!file||/(^|\/)(node_modules|vendor|dist|build)\//.test(file))continue;try{const body=await git(dir,['show',snapshot.anchor+':'+file]);if(body.includes('\0')||body.length>2097152){contextLimitations.push('기간 말 텍스트 분석 제한: '+file);continue;}contextSources.push(await storeManagementSource(run,profile.repository_id,'기간 말 '+file,repo.url+'/blob/'+snapshot.anchor+'/'+file,body,{anchor:snapshot.anchor,path:file,context_only:true,at_period_end:true,not_personal_credit:true,material_role:'existing_context',allowed_person_ids:[],authorship_scope:'existing_system_not_new_contribution'}));}catch{contextLimitations.push('기간 말 파일 맥락 미확보: '+file);}}
  }
  const contextUnits=contextSources.flatMap(s=>digestUnits(profile.repository_id,[s],budget));
  // Historical Git page bodies were already read in the case index. Prefer
  // the fixed period-end version of the same file for system background, while
  // retaining every version's actual delta. Wiki and missing-file contexts stay.
  const selectedContext=existingContextAtPeriodEnd(cases.flatMap(c=>facts.get(c.case_id).context_parts),contextSources,evidence);
  let backgrounds=[...selectedContext.parts,...await readDigestUnits(run,contextUnits,call,budget,1)];
  // Summarize only existing behavior; it never becomes a change report.
  while(backgrounds.length>1&&backgroundSerialization(backgrounds).length>budget/2){let batches=budgetedBatches(backgrounds,Math.max(5000,budget/4),backgroundSerialization);if(batches.every(b=>b.length===1))batches=Array.from({length:Math.ceil(backgrounds.length/2)},(_,i)=>backgrounds.slice(i*2,i*2+2));const next=[];for(const batch of batches){if(batch.length===1){next.push(batch[0]);continue;}const sources=uniqueQuotedSources(batch.flatMap(p=>p.citations));const schema=obj({existing_behavior:str,constraints:strings,limitations:strings,citations:{...citationsSchema(sources,true),maxItems:6}});const out=await attempt(call,'feature_background_merge',{repository_id:profile.repository_id,existing_context:batch.map(p=>({existing_behavior:p.existing_behavior,constraints:p.constraints,limitations:p.limitations})),source_catalog:flatCatalog(sources)},schema,out=>{validateSchema(schema,out);bindCitations(out.citations,sources);});next.push({...out,citations:bindCitations(out.citations,sources)});}backgrounds=next;}
  const caseRecords=primaryCases.map(c=>({case_id:c.case_id,title:c.title,source_ids:c.evidence_ids,changes:conciseChangeFacts(facts.get(c.case_id)),facts:facts.get(c.case_id)}));
  const repo={repository_id:profile.repository_id,system_purpose:profile.system_purpose,users_and_workflow:profile.users_and_workflow,difficulty:profile.difficulty};
  const synthesize=async(selected:any[],partials:any[]=[],revisionFeedback:any=[]):Promise<any>=>{
    const direct=selected.flatMap(c=>c.facts.change_parts.flatMap((p:any)=>p.citations));
    const citations=[...direct,...partials.flatMap(allCitations),...backgrounds.flatMap(p=>p.citations)];const sources=uniqueQuotedSources(citations);
    sources.push(...correctionQuoteSources(run.corrections||[],rows,contextSources,cases.flatMap(c=>c.roles)));
    const schema=functionalFeatureSchema(sources,people,cases.flatMap(c=>c.roles),executions);
    const input={repository:repo,execution_evidence:executions,capability:{group_id:id,name:group.name,goal:group.goal},people:peopleCatalog.filter(p=>Object.hasOwn(schema.properties.member_contributions.properties,'person_'+p.person_ref)),case_changes:selected.map(({facts,...c})=>c),existing_system_context:backgrounds.map(p=>({existing_behavior:p.existing_behavior,constraints:p.constraints,limitations:p.limitations})),partial_feature_reports:partials.map(partialReportInput),member_change_facts:memberChangeFacts(people,selected.map(c=>cases.find(original=>original.case_id===c.case_id)),facts),source_catalog:flatCatalog(sources),recorded_contribution_roles:cases.filter(c=>selected.some(s=>s.case_id===c.case_id)).map(c=>({case_id:c.case_id,roles:c.roles})),revision_feedback:revisionFeedback,scope:{case_ids:selected.map(c=>c.case_id),context_case_ids:contextCaseIds,partial:selected.length<primaryCases.length,primary_case_count:primaryCases.length,input_kind:'actual_change_facts_and_separate_existing_context'}};
    const out=await attempt(call,'feature_synthesis',input,schema,out=>{
      validateSchema(schema,out);const memberValues=Object.values(out.member_contributions) as any[];const problems:string[]=[];
      const prose:Record<string,string>={title:out.title,previous_limitation:out.previous_limitation,change_summary:out.change_summary,system_significance:out.system_significance,quality_assessment:out.quality_assessment,'verification.observed':out.verification.observed,'verification.not_verified':out.verification.not_verified,...Object.fromEntries(out.impacts.map((impact:any,i:number)=>['impacts.'+i+'.description',impact.description])),...Object.fromEntries(memberValues.map((m:any,i:number)=>['member_contributions.'+i+'.contribution',m.contribution]))};
      for(const [field,value] of Object.entries(prose))try{checkNarrative(value);}catch(error){problems.push(field+': '+redact(error));}
      for(const field of ['limitations','counter_evidence'])for(const [i,text] of out[field].entries())try{requirePlainBrief(readableObservation(text));}catch(error){problems.push(field+'.'+i+': '+redact(error));}
      try{rejectUnobservedExecution([...Object.values(prose),...out.impacts.map((i:any)=>i.description),...out.limitations,...out.counter_evidence],executions);}catch(error){problems.push('execution_claims: '+redact(error));}
      if(problems.length)throw new Error(problems.join('\n'));

      const actual=memberValues.map((m:any)=>m.person_ref);if(new Set(actual).size!==actual.length)throw new Error('개인 기여 설명의 중복');
      bindCitations(out.citations,sources);for(const impact of out.impacts)bindCitations(impact.citations,sources);
      for(const member of memberValues){const personId=people[member.person_ref-1].person_id,quotes=bindCitations(member.citations,sources),roles=cases.flatMap(c=>c.roles).filter((r:any)=>r.person_id===personId&&quotes.some(q=>(q.source_evidence_id||q.source_id)===r.evidence_id&&!q.source_scope?.not_personal_credit));if(!roles.length)throw new Error('개인 기여의 원본 역할 근거 부족');if(['implementation','coauthored_implementation'].includes(member.scope)&&!roles.some((r:any)=>r.implementation_eligible))throw new Error('구현 역할은 실제 코드 변경의 작성 근거가 필요합니다');if(member.scope==='verification'&&!roles.some((r:any)=>r.substantive_test_change&&r.contribution_scope!=='integration_only'))throw new Error('검증 역할은 해당 인물의 실질적인 테스트·검증 변경 원문이 필요합니다');}
      for(const deficit of out.observed_deficits){const quotes=bindDeficitCitations(deficit,sources);for(const ref of deficit.affected_person_refs){const personId=people[ref-1]?.person_id;if(!personId||!quotes.some(q=>!q.source_scope?.not_personal_credit&&cases.some(c=>c.roles.some((r:any)=>r.person_id===personId&&r.evidence_id===(q.source_evidence_id||q.source_id)))))throw new Error('결함의 개인 귀속에 해당 변경 근거가 필요합니다');}}
    });
    return {...out,case_ids:selected.map(c=>c.case_id),citations:bindCitations(out.citations,sources),impacts:out.impacts.map((p:any)=>({...p,citations:bindCitations(p.citations,sources)})),member_contributions:(Object.values(out.member_contributions) as any[]).map((m:any)=>({...m,person_id:people[m.person_ref-1].person_id,citations:bindCitations(m.citations,sources)})),observed_deficits:out.observed_deficits.map((d:any)=>({...d,affected_person_ids:d.affected_person_refs.map((ref:number)=>people[ref-1].person_id),citations:bindDeficitCitations(d,sources)}))};
  };
  let report:any,featureCalls=0;
  if(!caseRecords.some(c=>c.facts.change_parts.length)){
    report={title:group.name+' · 변경 귀속 미확인',previous_limitation:'이전 버전과 해당 편집의 차이를 확인할 자료가 부족합니다.',change_summary:'전체 문서의 내용은 확인했으나 해당 편집자의 새로운 변경으로 귀속할 수 있는 근거가 부족합니다.',system_significance:'기존 시스템 맥락과 개인의 신규 기여를 구분해 검토해야 합니다.',impacts:[],difficulty:{level:null,reason:'변경 범위 미확인'},quality_assessment:'개인의 변경 품질 판정 보류',observed_deficits:[],verification:{observed:'현재 문서 내용',not_verified:'개인의 변경·분석·실행 범위'},member_contributions:[],counter_evidence:[],limitations:['마지막 편집 기록만으로 전체 문서의 지적 기여를 귀속하지 않습니다.'],citations:backgrounds.flatMap(p=>p.citations).slice(0,6)};
  }else{
    const batches=budgetedBatches(caseRecords,Math.max(6000,budget/3),c=>JSON.stringify({case_id:c.case_id,title:c.title,source_ids:c.source_ids,changes:c.changes,source_catalog:flatCatalog(uniqueQuotedSources(c.facts.change_parts.flatMap((p:any)=>p.citations)))}));let layer:any[]=[];for(const batch of batches){layer.push(await synthesize(batch));featureCalls++;}
    while(layer.length>1){let batches:any[][]=budgetedBatches<any>(layer,Math.max(6000,budget/3),p=>JSON.stringify(p));if(batches.every(b=>b.length===1))batches=Array.from({length:Math.ceil(layer.length/2)},(_,i)=>layer.slice(i*2,i*2+2));const next:any[]=[];for(const batch of batches){if(batch.length===1){next.push(batch[0]);continue;}const set=new Set(batch.flatMap(p=>p.case_ids));next.push(await synthesize(caseRecords.filter(c=>set.has(c.case_id)),batch));featureCalls++;}layer=next;}report=layer[0];
  }
  const memberChecks:any=obj(Object.fromEntries(people.map((person,index)=>['person_'+(index+1),obj({claim_supported:{type:'boolean'},reason:str})])));memberChecks.description='각 사람의 기여 문장을 member_change_facts의 같은 person 키와 대조한다. 다른 사람의 변경을 가져오거나 문서 인용으로 코드·테스트 수정을 주장하면 claim_supported=false이며 unsupported_claims에 해당 사람과 잘못된 문장을 명시한다. 인용이 자신의 자료라는 것만으로 문장이 뒷받침되는 것은 아니다.';
  const reviewSchema=obj({unsupported_claims:strings,observation_limits:strings,member_claim_checks:memberChecks});let factualReview:any={unsupported_claims:[],observation_limits:[]};
  for(let revision=0;revision<2;revision++){
    factualReview=await attempt(call,'feature_grounding',{repository:repo,feature_report:report,observed_change_facts:caseRecords.map(({facts,...c})=>c),existing_system_context:backgrounds.map(p=>({existing_behavior:p.existing_behavior})),recorded_roles:cases.flatMap(c=>c.roles),member_change_facts:memberChangeFacts(people,primaryCases,facts),source_quotes:allCitations(report)},reviewSchema,out=>{validateSchema(reviewSchema,out);if(Object.values(out.member_claim_checks).some((c:any)=>!c.claim_supported)&&!out.unsupported_claims.length)throw new Error('개인별 근거 대조가 실패한 문장과 사람을 unsupported_claims에 명시하세요');});
    if(!factualReview.unsupported_claims.length||revision===1||!caseRecords.some(c=>c.facts.change_parts.length))break;
    report=await synthesize(caseRecords,[report],factualReview.unsupported_claims);featureCalls++;
  }
  const delivery=rows.filter(e=>e.kind==='commit').map(e=>snapshot?.delivery[e.id]).filter(Boolean);
  const output={...report,feature_id:id,repository_id:profile.repository_id,initiative_ids:group.initiative_ids,initiative_name:group.name,capability_id:group.capability_id,capability_name:group.capability_name,evidence_ids:ids,case_ids:cases.map(c=>c.case_id),recorded_roles:cases.flatMap(c=>c.roles),factual_review:factualReview,grouping_review:group.grouping_review,execution_evidence:executions,context_source_ids:contextSources.map(s=>s.id),material_status:Object.fromEntries(rows.filter(e=>materials.has(e.id)).map(e=>[e.id,materials.get(e.id)!.status])),limitations:[...report.limitations,...contextLimitations],coverage:{period_end_context_policy:'direct_contributor_changes_only',integration_only_cases_without_personal_file_context:cases.filter(c=>!directContextCases.includes(c)).map(c=>c.case_id),source_ids:ids,case_fact_ids:cases.map(c=>c.case_id),digest_part_ids:cases.flatMap(c=>facts.get(c.case_id).part_ids),context_digest_part_ids:contextUnits.map(u=>u.part_id),superseded_case_context_part_ids:selectedContext.superseded_part_ids,primary_case_ids:primaryCases.map(c=>c.case_id),context_case_ids:contextCaseIds,input_kind:'full_source_digests_then_functional_report',feature_synthesis_calls:featureCalls,all_batches_processed:true},delivery:{default_branch_commits:delivery.filter(d=>d.in_period_end_default_branch).map(d=>d.commit_sha),branch_only_commits:delivery.filter(d=>!d.in_period_end_default_branch).map(d=>d.commit_sha),production_deployment:'not_observed'},deduplication:cases.map(c=>({case_id:c.case_id,basis:c.deduplication_basis,evidence_ids:c.evidence_ids})),status:factualReview.unsupported_claims.length?'ai_interpretation_requires_manager_correction':'ai_functional_interpretation_requires_source_review'};
  await db.query('INSERT INTO feature_reports(evaluation_id,feature_id,repository_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,id,profile.repository_id,output]);return output;
}
