import {db} from '../db.js';
import {hash,redact} from '../config.js';
import {Source} from './context.js';
import {conciseChangeFacts,uniqueQuotedSources,ManagementRunner} from './digests.js';
import {functionalFeatureSchema,correctionQuoteSources} from './feature-reports.js';
import {obj,strings,flatCatalog,bindCitations,bindDeficitCitations,validateSchema,requirePlainBrief,budgetedBatches} from './contracts.js';
import {sourceProfile} from '../evaluation/provenance.js';
import {functionalExecutionEvidence,executionObservation,rejectUnobservedExecution} from './observability.js';
import {permanentLlmError} from '../evaluation/errors.js';

export function partHasOwnSource(part:any,ids:Set<string>,allParts=new Map<string,any>(),seen=new Set<string>()):boolean{
  if(!part||seen.has(part.part_id))return false;seen.add(part.part_id);
  if(part.source_slices?.some((s:any)=>ids.has(s.source_evidence_id||s.source_id)))return true;
  if(part.citations?.some((q:any)=>!q.source_scope?.not_personal_credit&&ids.has(q.source_evidence_id||q.source_id)))return true;
  return (part.prior_part_ids||[]).some((id:string)=>partHasOwnSource(allParts.get(id),ids,allParts,new Set(seen)));
}
export function personalWorkFacts(personId:string,cases:any[],facts:Map<string,any>,evidence:any[],allParts=new Map<string,any>()){
  const changes:any[]=[],integration_records:any[]=[];
  for(const c of cases){
    const roles=c.roles.filter((r:any)=>r.person_id===personId),direct=roles.filter((r:any)=>r.contribution_scope!=='integration_only');
    const ids=new Set<string>(direct.map((r:any)=>r.evidence_id));
    const parts=facts.get(c.case_id).change_parts.filter((p:any)=>partHasOwnSource(p,ids,allParts));
    if(parts.length)changes.push({case_id:c.case_id,source_ids:[...ids],roles:direct,changes:conciseChangeFacts({change_parts:parts})});
    for(const r of roles.filter((r:any)=>r.contribution_scope==='integration_only')){const e=evidence.find(e=>e.id===r.evidence_id);integration_records.push({evidence_id:r.evidence_id,case_id:c.case_id,title:e.title,revision:e.revision,role:'integration_record_only'});}
  }
  return {person_id:personId,changes,integration_records};
}

function prose(text:string){requirePlainBrief(text);if(!/[가-힣]/.test(text)||/source_change|commit_author|person_ref|person_id|test-member-\d+/.test(text))throw new Error('관리자가 이해할 수 있는 한국어 기능·영향 문장으로 쓰세요. 내부 역할 코드·사람 ID를 설명에 쓰지 마세요');}
export function checkPersonalNarrative(text:string){prose(text);if(/주도(?:했|하|적|함)|총괄(?:했|하)|단독으로|독자적으로/.test(text))throw new Error('작성·공동 작성 기록으로 주도성·단독 소유권을 추정하지 말고 실제 변경과 역할만 설명하세요');}
export function validatePersonalDeficit(deficit:any,sources:Source[],deliveredIds:Set<string>,sourceCases:Map<string,string>){
  const quotes=bindDeficitCitations(deficit,sources),primary=quotes.filter(q=>!q.source_scope?.not_personal_credit).map(q=>q.source_evidence_id||q.source_id);
  if(deficit.status==='present_at_period_end'&&!primary.some(id=>deliveredIds.has(id)))throw new Error('기간 말 결함에는 기본 브랜치에 반영된 본인 변경의 인용이 필요합니다. 브랜치 작업은 resolution_unknown으로 구분하세요');
  if(deficit.status==='resolved_in_later_evidence'&&new Set(primary.map(id=>sourceCases.get(id)).filter(Boolean)).size<2)throw new Error('한 번의 수정은 기존 문제의 해결을 보여줄 뿐 본인이 만든 결함과 후속 해결을 증명하지 않습니다. change_summary에 수정 내용을 쓰고 이 항목은 비우세요');
  if(!deficit.failure_scenario?.trim())throw new Error('결함에는 실제 입력·실행 조건과 잘못된 결과의 구체적 정적 추론 또는 관찰을 failure_scenario에 쓰세요. 일반적인 가능성·미검증은 관찰 한계로 옮기세요');
  if(deficit.defect_kind==='syntax_error'&&!/문법|구문|파싱|파서|Syntax|pars/i.test(deficit.description+' '+deficit.failure_scenario))throw new Error('syntax_error는 코드 구문·파서 오류입니다. 일반적인 동작 위험이나 문구의 관사 교정은 이 종류의 결함이 아닙니다');
  return quotes;
}
async function attempt(call:ManagementRunner,stage:string,input:any,schema:any,validate:(out:any)=>void){const failures:string[]=[];for(let i=0;i<5;i++)try{return await call(stage,{...input,validation_feedback:failures.join('\n')},schema,validate);}catch(error){if(permanentLlmError(error)||(error as any)?.name==='AbortError'||i===4)throw error;const message=redact(error);if(!failures.includes(message))failures.push(message);}}
const quoteSource=(e:any,personId:string,body:string):Source=>({id:e.id,title:e.title,url:e.url,body,metadata:{source_evidence_id:e.id,evidence_kind:e.kind,material_role:'change',not_personal_credit:false,allowed_person_ids:[personId]}});

export function personalQuoteSource(source:Source,personId:string):Source{
  const background=source.metadata?.context_only||source.metadata?.at_period_end||source.metadata?.not_personal_credit;
  return {...source,metadata:{...source.metadata,...(background?{material_role:'existing_context',not_personal_credit:true,allowed_person_ids:[]}:{allowed_person_ids:[personId]})}};
}

function plansFor(personId:string,features:any[],cases:any[]){
  const plans:any[]=[],integrations=new Map<string,{roles:any[];cases:any[];shared_ids:string[]}>();
  for(const f of features){
    const selected=cases.filter(c=>f.case_ids.includes(c.case_id)),roles=selected.flatMap(c=>c.roles.filter((r:any)=>r.person_id===personId));if(!roles.length)continue;
    const direct=roles.filter((r:any)=>r.contribution_scope!=='integration_only');
    if(direct.length){const ids=[...new Set(direct.map((r:any)=>r.evidence_id))].sort();plans.push({feature_id:hash(['personal-feature-v1',personId,f.feature_id,ids]),repository_id:f.repository_id,source_ids:ids,roles:direct,cases:selected.filter(c=>c.roles.some((r:any)=>r.person_id===personId&&r.contribution_scope!=='integration_only')),shared_ids:[f.feature_id],grouping_review:f.grouping_review,mode:'direct'});}
    const merged=roles.filter((r:any)=>r.contribution_scope==='integration_only');if(merged.length){if(!integrations.has(f.repository_id))integrations.set(f.repository_id,{roles:[],cases:[],shared_ids:[]});const p=integrations.get(f.repository_id)!;p.roles.push(...merged);p.cases.push(...selected.filter(c=>c.roles.some((r:any)=>r.person_id===personId&&r.contribution_scope==='integration_only')));p.shared_ids.push(f.feature_id);}
  }
  for(const [repo,p] of integrations){const ids=[...new Set(p.roles.map(r=>r.evidence_id))].sort();plans.push({feature_id:hash(['personal-integration-v1',personId,repo,ids]),repository_id:repo,source_ids:ids,roles:p.roles,cases:[...new Map(p.cases.map(c=>[c.case_id,c])).values()],shared_ids:p.shared_ids,grouping_review:{status:'not_applicable_context',issues:[]},mode:'integration'});}
  return plans;
}

export async function buildPersonalFeatures(run:any,person:any,features:any[],profiles:any[],cases:any[],facts:Map<string,any>,evidence:any[],snapshots:any[],materials:Map<string,any>,call:ManagementRunner,budget:number,partIndex?:Map<string,any>){
  const views:any[]=[];const allParts=partIndex||new Map((await db.query('SELECT output FROM management_digest_parts WHERE evaluation_id=$1',[run.id])).rows.map(r=>[r.output.part_id,r.output]));
  for(const plan of plansFor(person.person_id,features,cases)){
    const existing=(await db.query('SELECT output FROM personal_feature_reports WHERE evaluation_id=$1 AND person_id=$2 AND feature_id=$3',[run.id,person.person_id,plan.feature_id])).rows[0];if(existing){views.push(existing.output);continue;}
    const rows=plan.source_ids.map((id:string)=>evidence.find(e=>e.id===id)),ownIds=new Set<string>(plan.source_ids),profile=profiles.find(p=>p.repository_id===plan.repository_id),snapshot=snapshots.find(s=>s.repository_id===plan.repository_id);
    const executions=functionalExecutionEvidence(evidence,rows,run.period_as_of);
    const delivery=rows.filter((e:any)=>e.kind==='commit').map((e:any)=>snapshot?.delivery[e.id]).filter(Boolean);
    const deliveredIds=new Set<string>(rows.filter((e:any)=>{const commit=e.kind==='commit'?e:evidence.find(c=>c.kind==='commit'&&c.source_id===e.source_id&&c.revision===(e.metadata.overlap_commit||e.metadata.linked_commit));return !!commit&&snapshot?.delivery[commit.id]?.in_period_end_default_branch;}).map((e:any)=>e.id));
    const sourceCases=new Map<string,string>(plan.cases.flatMap((c:any)=>c.evidence_ids.map((id:string)=>[id,c.case_id])));const docOnly=plan.roles.every((r:any)=>!r.implementation_eligible&&!r.substantive_test_change);
    const units=plan.cases.flatMap((c:any)=>facts.get(c.case_id).change_parts.filter((p:any)=>partHasOwnSource(p,ownIds,allParts)).map((p:any)=>({unit_id:p.part_id,case_id:c.case_id,changes:conciseChangeFacts({change_parts:[p]}),citations:p.citations.filter((q:any)=>!q.source_scope?.not_personal_credit&&ownIds.has(q.source_evidence_id||q.source_id))})));
    const inspectable=rows.some((e:any)=>sourceProfile(e).inspectable_material)&&units.length>0;
    let report:any,generation:string,review:any={unsupported_claims:[],observation_limits:[]},calls=0;
    if(plan.mode==='integration'||!inspectable){
      const integration=plan.mode==='integration';
      const text=integration?'개발 브랜치를 병합한 기록은 확인했습니다. 이 기록만으로 다른 작성자의 기능 구현을 해당 팀원의 성과로 귀속하거나 충돌 해결·검증의 수준을 판정하지 않습니다.':'변경 기록은 있으나 내용을 관찰하지 못해 기능 영향·난도·품질 판정을 보류합니다.';
      const quotes=rows.map((e:any)=>({source_id:e.id,title:e.title,url:e.url,quote:e.body.slice(0,250),source_evidence_id:e.id,source_scope:{source_evidence_id:e.id,allowed_person_ids:[person.person_id],not_personal_credit:false}})).filter((q:any)=>q.quote.trim().length>=8);
      report={title:integration?'개발 브랜치 동기화 기록':'내용 미관찰 · 기능 기여 판정 보류',previous_limitation:'직접 구현·내용·검증의 범위를 확인할 자료가 부족합니다.',change_summary:text,system_significance:integration?'개발 이력의 통합 기록입니다. 사용자 기능 개선이나 운영 효과는 이 기록만으로 확인할 수 없습니다.':text,impacts:[],difficulty:{level:null,reason:text},quality_assessment:text,observed_deficits:[],verification:{observed:executionObservation(executions),not_verified:'통합의 실제 해결 과정·변경 내용·검증 효과 추가 확인 필요'},member_contributions:integration?[{person_id:person.person_id,person_ref:1,scope:'integration',contribution:text,citations:quotes.slice(0,3)}]:[],citations:quotes.slice(0,6),counter_evidence:[],limitations:[text]};generation=integration?'rule_integration_record':'rule_insufficient_changed_material';
    }else{
      const paths=new Set(rows.flatMap((e:any)=>sourceProfile(e).paths));
      const contextIds=[...new Set(features.filter(f=>plan.shared_ids.includes(f.feature_id)).flatMap(f=>f.context_source_ids))];
      const contexts=contextIds.length?(await db.query('SELECT * FROM management_sources WHERE id=ANY($1::text[])',[contextIds])).rows.filter(s=>paths.has(s.metadata.path)):[];
      const rawSources:Source[]=rows.flatMap((e:any)=>{const material=materials.get(e.id);if(material?.source)return [{...material.source,metadata:{...material.source.metadata,source_evidence_id:e.id,material_role:'change',not_personal_credit:false,allowed_person_ids:[person.person_id]}}];return !material||material.status==='document_creation'?[quoteSource(e,person.person_id,e.body)]:[];});
      const rawFits=JSON.stringify(rawSources).length<budget/3;
      const quoted=correctionQuoteSources(run.corrections||[],rows,contexts,plan.roles);
      const endQuotes:Source[]=[];for(const unit of units)for(const q of unit.citations){if(!/^\+(?!\+)/.test(q.quote))continue;const text=q.quote.split('\n').map((line:string)=>line.startsWith('+')?line.slice(1):line).join('\n');if(text.trim().length<8)continue;for(const c of contexts)if(c.metadata.at_period_end&&c.body.includes(text))endQuotes.push({...c,body:text});}
      const synthesis=async(selected:any[],partials:any[]=[],feedback:string[]=[]):Promise<any>=>{
        const quotes=[...selected.flatMap(u=>u.citations),...partials.flatMap(allQuotes)];const excerpts=rawSources.flatMap(changedRuns);const completeRaw=JSON.stringify(flatCatalog(excerpts)).length<budget/2;const rawPool=completeRaw?excerpts:rawSources.flatMap(s=>changedRuns(s).slice(0,1));const represented=new Set(rawPool.map(s=>s.metadata.source_evidence_id||s.id));const sources=[...uniqueQuotedSources(quotes.filter((q:any)=>rawFits?!represented.has(q.source_evidence_id||q.source_id):!rawPool.some(s=>s.id===q.source_id&&s.body.includes(q.quote)))),...rawPool,...quoted,...endQuotes].filter(s=>!s.metadata?.at_period_end||deliveredIds.size>0).map(s=>personalQuoteSource(s,person.person_id));
        const schema=functionalFeatureSchema(sources,[person],plan.roles,executions);
        schema.properties.title.description='이 사람이 기여한 사용자 기능·이용자 문제 해결의 목적을 한국어로 이름 붙인다. 문서 추가·파일 수정 같은 수행 행위를 제목으로 쓰지 않는다. 실제로 없는 런타임 구현을 주장하지 않는다.';
        schema.properties.system_significance.description='이 저장소를 쓰는 사람이 어떤 구체적 업무를 더 쉽게·정확히 수행할 수 있는지 1~2문장으로 설명한다. 해당 자료에서 드러난 고유한 사용 목적을 명시한다. 문서 품질·일관성·가이드라인·유지보수성 향상이라는 일반론만으로 대신하지 않는다. 효과를 측정하지 않았다면 예상으로 구분한다.';
        schema.properties.member_contributions.properties.person_1.anyOf=schema.properties.member_contributions.properties.person_1.anyOf.filter((v:any)=>!v.properties.scope.enum.includes('integration'));
        for(const variant of schema.properties.observed_deficits.items.anyOf){variant.properties.defect_kind={type:'string',enum:['syntax_error','incorrect_behavior','data_integrity','security_regression']};variant.properties.failure_scenario={type:'string',minLength:8,description:'어떤 구체적 입력·실행 조건에서 무엇이 잘못되는지 관찰 또는 소스에 근거한 정적 추론을 쓴다. 단순한 혼동·충돌 가능성이나 검증 부재는 결함이 아니다.'};variant.required.push('defect_kind','failure_scenario');}
        schema.properties.difficulty.properties.level.description='이 사람의 실제 변경 자체의 난도. 1=국소·정형,2=일반 구현,3=여러 실제 제약,4=큰 상호작용·불확실성,5=구조적 고위험. 저장소 전체 난도·규모를 복사하지 않는다. 근거 부족은 null.';
        schema.properties.difficulty.properties.reason.description='이 사람이 변경한 구체적 동작과 해결한 제약을 근거로 설명한다. 저장소의 명성·프로토콜 수·전체 테스트 수를 국소 문구 교정의 난도 근거로 쓰지 않는다.';
        const input={personal_feature_id:plan.feature_id,person:{person_id:person.person_id,role_profile:person.role_profile},repository:{repository_id:profile.repository_id,system_purpose:profile.system_purpose,users_and_workflow:profile.users_and_workflow},own_source_ids:plan.source_ids,people:[{person_ref:1,person_id:person.person_id}],case_changes:selected.map(({citations,...u})=>u),recorded_contribution_roles:[{roles:plan.roles}],partial_feature_reports:partials.map(p=>({...p,unit_ids:undefined})),raw_owned_material:rawFits?rawSources:[],source_catalog:flatCatalog(sources),execution_evidence:executions,delivery:{default_branch_source_ids:[...deliveredIds],branch_only_source_ids:rows.filter((e:any)=>e.kind==='commit'&&!deliveredIds.has(e.id)).map((e:any)=>e.id),production_deployment:'not_observed'},revision_feedback:feedback,scope:{person_only:true,unit_count:selected.length||partials.reduce((n,p)=>n+p.unit_ids.length,0),raw_material:rawFits?'provided_when_leaf':'complete_scalar_index_and_quotes'}};
        const output=await attempt(call,'personal_feature_synthesis',input,schema,out=>{validateSchema(schema,out);if(docOnly&&/(?:문서|항목|링크|설명)\s*(?:추가|수정|업데이트)$/.test(out.title))throw new Error('현재 제목은 문서 편집 행위뿐입니다. 원문의 사용자가 무엇을 할 수 있게 되는지 기능 이름으로 다시 쓰세요. 예: 분석 도구 링크 추가 → 느린 쿼리를 조사할 분석 도구 선택 안내. 단순 문서 품질 향상 대신 대상 작업과 도움을 구체적으로 쓰고, 실제 도구나 런타임을 개발했다고 확대하지 마세요. 제목을 문서 추가로 끝내지 마세요.');const proseIssues:string[]=[];for(const [field,text] of Object.entries({title:out.title,previous_limitation:out.previous_limitation,change_summary:out.change_summary,system_significance:out.system_significance,quality_assessment:out.quality_assessment,...Object.fromEntries(Object.entries(out.member_contributions).map(([key,m]:[string,any])=>[key,m.contribution]))}))try{checkPersonalNarrative(text as string);}catch(error){proseIssues.push(field+': '+redact(error)+' 문제 문장: '+String(text).slice(0,500));}if(proseIssues.length)throw new Error(proseIssues.join('\n'));rejectUnobservedExecution([out.change_summary,out.system_significance,out.quality_assessment,...out.impacts.map((i:any)=>i.description)],executions);bindCitations(out.citations,sources);for(const d of out.observed_deficits)validatePersonalDeficit(d,sources,deliveredIds,sourceCases);});calls++;
        return {...output,unit_ids:selected.length?selected.map(u=>u.unit_id):[...new Set(partials.flatMap(p=>p.unit_ids))],citations:bindCitations(output.citations,sources),impacts:output.impacts.map((i:any)=>({...i,citations:bindCitations(i.citations,sources)})),member_contributions:Object.values(output.member_contributions).map((m:any)=>({...m,person_id:person.person_id,citations:bindCitations(m.citations,sources)})),observed_deficits:output.observed_deficits.map((d:any)=>({...d,affected_person_ids:d.affected_person_refs.length?[person.person_id]:[],citations:bindDeficitCitations(d,sources)}))};
      };
      const batches=budgetedBatches<any>(units,Math.max(5000,budget/3),u=>JSON.stringify(u));let layer:any[]=[];for(const batch of batches)layer.push(await synthesis(batch));
      while(layer.length>1){let merged=budgetedBatches<any>(layer,Math.max(5000,budget/3),p=>JSON.stringify(p));if(merged.every(b=>b.length===1))merged=Array.from({length:Math.ceil(layer.length/2)},(_,i)=>layer.slice(i*2,i*2+2));const next=[];for(const batch of merged)next.push(batch.length===1?batch[0]:await synthesis([],batch));layer=next;}report=layer[0];
      const reviewSchema=obj({unsupported_claims:strings,observation_limits:strings});
      for(let revision=0;revision<2;revision++){
        const reviewed=[];for(const batch of budgetedBatches<any>(units,Math.max(5000,budget/3),u=>JSON.stringify(u))){reviewed.push(await attempt(call,'personal_feature_grounding',{personal_feature_id:plan.feature_id,person_id:person.person_id,repository_id:plan.repository_id,own_source_ids:plan.source_ids,feature_report:report,own_change_facts:batch.map(({citations,...u}:any)=>u),raw_owned_material:rawFits?rawSources:[],source_quotes:allQuotes(report),scope:{partial:batch.length<units.length}},reviewSchema,out=>validateSchema(reviewSchema,out)));}review={unsupported_claims:[...new Set(reviewed.flatMap(r=>r.unsupported_claims))],observation_limits:[...new Set(reviewed.flatMap(r=>r.observation_limits))]};
        if(!review.unsupported_claims.length||revision===1)break;report=await synthesis([], [report],review.unsupported_claims);
      }
      generation='llm_person_scoped_feature';
    }
    const output={...report,person_id:person.person_id,feature_id:plan.feature_id,repository_id:plan.repository_id,capability_name:plan.mode==='integration'?'개발 이력 통합':'직접 기여한 기능·개선',evidence_ids:plan.source_ids,case_ids:plan.cases.map((c:any)=>c.case_id),recorded_roles:plan.roles,shared_feature_ids:plan.shared_ids,grouping_review:{status:'person_scoped_view',issues:[]},shared_grouping_review:plan.grouping_review,shared_person_ids:[...new Set(cases.flatMap(c=>c.roles.filter((r:any)=>ownIds.has(r.evidence_id)).map((r:any)=>r.person_id)))],factual_review:review,generation,execution_evidence:executions,context_source_ids:[...new Set(allQuotes(report).filter((q:any)=>q.source_scope?.at_period_end).map((q:any)=>q.source_id))],material_status:Object.fromEntries(rows.filter((e:any)=>materials.has(e.id)).map((e:any)=>[e.id,materials.get(e.id).status])),delivery:{default_branch_commits:delivery.filter((d:any)=>d.in_period_end_default_branch).map((d:any)=>d.commit_sha),branch_only_commits:delivery.filter((d:any)=>!d.in_period_end_default_branch).map((d:any)=>d.commit_sha),production_deployment:'not_observed'},deduplication:plan.cases.map((c:any)=>({case_id:c.case_id,basis:c.deduplication_basis,evidence_ids:c.evidence_ids.filter((id:string)=>ownIds.has(id))})),coverage:{mode:plan.mode,source_ids:plan.source_ids,case_ids:plan.cases.map((c:any)=>c.case_id),unit_ids:units.map((u:any)=>u.unit_id),synthesis_calls:calls,person_only:true}};
    await db.query('INSERT INTO personal_feature_reports(evaluation_id,person_id,feature_id,output) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[run.id,person.person_id,plan.feature_id,output]);views.push(output);
  }
  return views;
}
function allQuotes(report:any){return [...report.citations,...report.impacts.flatMap((i:any)=>i.citations),...report.member_contributions.flatMap((m:any)=>m.citations),...report.observed_deficits.flatMap((d:any)=>d.citations)];}

function changedRuns(source:Source):Source[]{
  const result:Source[]=[];let offset=0,start=-1;
  const finish=(end:number)=>{if(start>=0){const body=source.body.slice(start,end);if(body.trim().length>=8)result.push({...source,body,metadata:{...source.metadata,source_slice:{start,end}}});start=-1;}};
  for(const line of source.body.split('\n')){if(/^[+-](?![+-])/.test(line)){if(start<0)start=offset;}else finish(offset);offset+=line.length+1;if(start>=0&&offset-start>1200)finish(Math.min(offset,source.body.length));}finish(source.body.length);
  if(!result.length&&source.metadata?.material_role==='change'&&!source.body.includes('diff --git'))return [{...source,body:source.body.slice(0,1200)}];
  return result;
}
