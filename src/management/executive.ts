import {db} from '../db.js';
import {hash,TeamConfig} from '../config.js';
import {prepareRepository,storeManagementSource,Source} from './context.js';
import {repositoryCatalog} from './repository-catalog.js';
import {executivePolicies} from './executive-contracts.js';
import {obj,arr,str,strings,level,validateSchema,budgetedBatches,catalog,flatCatalog,sourceSlices,citationsSchema,bindCitations} from './contracts.js';
import {mapLimit} from '../evaluation/cases.js';
import {permanentLlmError} from '../evaluation/errors.js';
import {assignedRepositories} from './participation.js';

type Runner=(stage:string,input:any,schema:any,validate:(output:any)=>void)=>Promise<any>;
const text=(maxLength:number)=>({...str,maxLength});
const list=(maxItems:number,item:any=text(28))=>({...arr(item),maxItems});
const forbidden=/변경에서 확인|공개 가상 팀원|자동화 에이전트|독립적인 사람의 검토|직접 구현·내용·검증|자료가? 부족|확인할 수 없|이 기록만으로|show_default|core\.py|termui\.py|CHANGES|\.py\b|\.tsx?\b|\.rst\b|\.md\b|feature_ref|source_ref/i;
export function validateExecutiveText(output:any){
  const fields=(value:any,path=''):any[]=>typeof value==='string'?[{path,text:value}]:Array.isArray(value)?value.flatMap((v,i)=>fields(v,path+'.'+i)):value&&typeof value==='object'?Object.entries(value).flatMap(([k,v])=>fields(v,path+'.'+k)):[];
  const bad=fields(output).filter(s=>!s.path.startsWith('.technology_stack.')&&(forbidden.test(s.text)||(/주도|총괄|단독|독자적|test-member-\d|member-\w+|\b\w+_\w+\b/.test(s.text))));
  if(bad.length)throw new Error('관리자 카드에서 다음 문장을 사용자 기능/작업 목적으로 바꾸세요. 코드 식별자·소유권 추정·시험 설명을 제거하세요: '+bad.map(s=>s.path+'='+s.text).join('\n'));
}
export function confirmedQualityNote(features:any[]){
  const deficits=features.flatMap(f=>f.observed_deficits||[]).filter(d=>d.status==='present_at_period_end');
  if(!deficits.length)return '';
  if(deficits.some(d=>d.defect_kind==='syntax_error'))return '예제 문법 오류 수정 필요';
  if(deficits.some(d=>d.defect_kind==='security_regression'))return '보안 오류 수정 필요';
  return '동작 오류 수정 필요';
}
export function validateMemberBrief(output:any){
  validateExecutiveText(output);
  const words=new Set(['http','https','api','cli','url','python','ai','confluence','github','git']);
  const issues:string[]=[];
  for(const [i,a] of output.activities.entries())for(const field of ['title','outcome']){
    const value=a[field],terms=(value.match(/[A-Za-z][A-Za-z0-9_]*/g)||[]).filter((s:string)=>!words.has(s.toLowerCase()));
    if(terms.length||/다타입|제네릭|시그니처|컨텍스트|의존성|경로.{0,5}로딩|실무적으로|협력적으로|커버리지.{0,8}(향상|강화)/.test(value))issues.push(`activities.${i}.${field}=${value}`);
  }
  if(issues.length)throw new Error(issues.join('\n')+'\n코드 용어와 구현 수단을 제거하고 사용자가 할 수 있게 된 일/산출물을 짧고 완결되게 쓰세요.');
}
async function generate(call:Runner,stage:string,input:any,schema:any,check:(o:any)=>void){
  const feedback:string[]=[];for(let attempt=0;attempt<3;attempt++){try{return await call(stage,{...input,validation_feedback:feedback.join('\n')},schema,o=>{validateSchema(schema,o);validateExecutiveText(o);check(o);});}catch(e){if(permanentLlmError(e)||(e as any).name==='AbortError'||attempt===2)throw e;if(!feedback.includes((e as Error).message))feedback.push((e as Error).message);}}
}
async function saved(run:any,kind:string,subject:string,input:any){
  const revision=hash({policy:executivePolicies[kind==='repository'?'repository_brief':'member_brief'],input});
  const row=(await db.query('SELECT output FROM executive_briefs WHERE evaluation_id=$1 AND kind=$2 AND subject_id=$3 AND revision=$4',[run.id,kind,subject,revision])).rows[0];
  return {revision,output:row?.output};
}
async function persist(run:any,kind:string,subject:string,revision:string,output:any){
  const value={...output,revision,model:{provider_id:run.model.provider_id,model_id:run.model.model_id}};
  await db.query('INSERT INTO executive_briefs(evaluation_id,kind,subject_id,revision,output) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[run.id,kind,subject,revision,value]);return value;
}
export function executiveFeatureInput(f:any,index:number,personId:string,evidence:any[]){
  const contributions=f.member_contributions.filter((c:any)=>c.person_id===personId);
  const ownedIds=new Set(f.recorded_roles.filter((r:any)=>r.person_id===personId).map((r:any)=>r.evidence_id));
  const words=new Set(['http','https','api','cli','url','python']);
  const technical=(f.title.match(/[A-Za-z][A-Za-z0-9_]*/g)||[]).some((word:string)=>!words.has(word.toLowerCase()));
  const quotes=(f.citations||[]).filter((q:any)=>!q.source_scope?.not_personal_credit&&ownedIds.has(q.source_evidence_id||q.source_id)).map((q:any)=>({source_id:q.source_evidence_id||q.source_id,quote:q.quote}));
  // A technical artifact headline is especially prone to becoming a copied
  // executive headline. Resolve its meaning from owned original records instead
  // of copying the prior model's implementation vocabulary.
  const meaning=technical&&quotes.length?{original_intents:[...new Set(evidence.filter(e=>ownedIds.has(e.id)&&e.kind==='commit').map(e=>e.title))],changed_source_quotes:quotes,member_scopes:contributions.map((c:any)=>c.scope)}:{title:f.title,change_summary:f.change_summary,member_contributions:contributions.map(({scope,contribution}:any)=>({scope,contribution}))};
  return {feature_ref:index+1,repository_id:f.repository_id,...meaning,difficulty:f.difficulty.level,delivery:{default_branch:f.delivery.default_branch_commits.length>0,branch_only:f.delivery.branch_only_commits.length>0}};
}

export async function buildExecutiveBriefs(run:any,t:TeamConfig,evidence:any[],call:Runner,phase:'all'|'repositories'|'members'='all'){
  const profiles=(await db.query('SELECT output FROM repository_profiles WHERE evaluation_id=$1 ORDER BY repository_id',[run.id])).rows.map(r=>r.output);
  const portfolios=(await db.query('SELECT output FROM portfolios WHERE evaluation_id=$1 ORDER BY person_id',[run.id])).rows.map(r=>r.output);
  // Personal views are mandatory. Global shared prose is never used as a
  // substitute for one person's work, even when feature IDs are shared.
  const personal=(await db.query('SELECT output FROM personal_feature_reports WHERE evaluation_id=$1 ORDER BY person_id,feature_id',[run.id])).rows.map(r=>r.output);
  const reviews=(await db.query('SELECT person_id,reviewed_summary FROM grounding_reviews WHERE evaluation_id=$1',[run.id])).rows;
  const repositoryBriefs:any[]=[];
  const budget=Math.max(48000,Math.min(550000,((run.model.context_limit_tokens||32000)-(run.model.max_output_tokens||8192)-8000)*1.25));
  await db.query("UPDATE evaluation_runs SET summary=summary||jsonb_build_object('executive_status','running') WHERE id=$1",[run.id]);
  if(phase==='members')repositoryBriefs.push(...(await db.query("SELECT DISTINCT ON(subject_id) output FROM executive_briefs WHERE evaluation_id=$1 AND kind='repository' ORDER BY subject_id,created_at DESC,revision",[run.id])).rows.map(r=>r.output));
  if(phase!=='members'){
  for(const repo of t.repositories){
    const profile=profiles.find(p=>p.repository_id===repo.repository_id);if(!profile)throw new Error('저장소 분석이 먼저 완료되어야 합니다: '+repo.repository_id);
    const snapshot=await prepareRepository(run,t,repo.repository_id,evidence);
    const context=await repositoryCatalog(run,t,snapshot);
    const input={repository_id:repo.repository_id,profile,technical_facts:context.technical_facts,coverage:context.coverage,source_ids:context.sources.map(s=>s.id),corrections:(run.corrections||[]).filter((c:any)=>c.after_value.scope?.kind==='repository'&&c.after_value.scope.repository_id===repo.repository_id).map((c:any)=>c.after_value)};
    const cache=await saved(run,'repository',repo.repository_id,input);if(cache.output){repositoryBriefs.push(cache.output);continue;}
    let sources:Source[]=[...context.sources,...snapshot.sources.filter((s:Source)=>s.metadata?.kind==='wiki_system_context')];
    const batches=budgetedBatches(sourceSlices(sources,Math.min(40000,Math.floor(budget/4))),budget,s=>JSON.stringify(catalog([s])));
    if(batches.length>1){sources=[];for(const batch of batches){
      const schema=obj({summary:str,capabilities:strings,constraints:strings,limitations:strings,citations:citationsSchema(batch,true)});
      let result:any,feedback='';for(let attempt=0;attempt<3;attempt++){try{result=await call('repository_context_digest',{repository_id:repo.repository_id,source_catalog:flatCatalog(batch),purpose:'Entire application source and manifests for concise system catalog',validation_feedback:feedback},schema,o=>{validateSchema(schema,o);bindCitations(o.citations,batch);});break;}catch(e){if(permanentLlmError(e)||attempt===2)throw e;feedback=(e as Error).message;}}
      const quotes=bindCitations(result.citations,batch);sources.push(...quotes.map((c:any)=>({id:c.source_id,title:c.title,url:c.url,body:c.quote})));sources.push(await storeManagementSource(run,repo.repository_id,'저장소 구조 분석',repo.url,JSON.stringify(result),{anchor:snapshot.anchor,context_only:true,kind:'repository_catalog_digest',source_ids:quotes.map((c:any)=>c.source_id)}));
    }}
    const schema=obj({system_type:text(32),purpose:text(110),technology_stack:{...list(7,text(24)),minItems:1},capabilities:{...list(5,text(36)),minItems:3},difficulty:obj({level,reason:text(120)}),source_refs:{...arr({type:'integer',minimum:1,maximum:sources.length}),minItems:1}});
    const result=await generate(call,'repository_brief',{...input,source_catalog:sources.map((s,i)=>({source_ref:i+1,title:s.title,body:s.body}))},schema,o=>{if(!new Set(o.source_refs).size)throw new Error('시스템 설명 근거가 필요합니다');});
    repositoryBriefs.push(await persist(run,'repository',repo.repository_id,cache.revision,{...result,repository_id:repo.repository_id,display_name:profile.display_name||repo.repository_id,url:repo.url,technical_facts:context.technical_facts,coverage:context.coverage,source_ids:result.source_refs.map((n:number)=>sources[n-1].id),generation:'llm_repository_brief'}));
  }
  }
  if(phase==='repositories')return;
  if(repositoryBriefs.length!==t.repositories.length)throw new Error('전체 저장소 카드 분석이 완료되어야 팀원 요약을 생성할 수 있습니다');
  await mapLimit(t.members,Math.max(1,Math.min(2,Number(t.opencode?.max_parallel_requests)||2)),async person=>{
    const portfolio=portfolios.find(p=>p.person_id===person.person_id);if(!portfolio)throw new Error('팀원 평가가 먼저 완료되어야 합니다: '+person.person_id);
    const own=personal.filter(f=>f.person_id===person.person_id&&f.generation!=='rule_integration_record');
    const repoIds=[...new Set([...assignedRepositories(person,t.period),...own.map(f=>f.repository_id)])];
    const ownFeatures=own.filter(f=>f.generation==='llm_person_scoped_feature');
    const input={person_id:person.person_id,repositories:repositoryBriefs.filter(r=>repoIds.includes(r.repository_id)).map(({repository_id,system_type,purpose,capabilities,difficulty})=>({repository_id,system_type,purpose,capabilities,difficulty})),own_features:ownFeatures.map((f,i)=>executiveFeatureInput(f,i,person.person_id,evidence)),source_hash:portfolio.validation_hash,manager_review:reviews.find(r=>r.person_id===person.person_id)?.reviewed_summary||'',corrections:(run.corrections||[]).filter((c:any)=>own.some(f=>f.evidence_ids.includes(c.target_id)||c.after_value.scope?.feature_id===f.feature_id)).map((c:any)=>c.after_value)};
    const cache=await saved(run,'member',person.person_id,input);if(cache.output)return;
    if(!ownFeatures.length){
      const changed=evidence.filter(e=>portfolio.considered_evidence_ids.includes(e.id));
      const images=changed.some(e=>(e.metadata.files||[]).some((p:string)=>/\.(png|jpe?g|gif|svg|webp)$/i.test(p)));
      await persist(run,'member',person.person_id,cache.revision,{person_id:person.person_id,repository_ids:repoIds,summary:images?'프로젝트 이미지 자료를 갱신했습니다.':own.length?'프로젝트 자료를 갱신했습니다.':'저장소 유지관리 활동을 기록했습니다.',activities:own.slice(0,1).map(f=>({title:images?'이미지 자료 갱신':'프로젝트 자료 갱신',outcome:'프로젝트에서 사용하는 자료 업데이트',kind:'assets',repository_id:f.repository_id,feature_ids:[f.feature_id],difficulty:null,delivery:'recorded',quality_note:''})),generation:'rule_source_activity_brief'});return;
    }
    const schema=obj({activities:{...list(Math.min(3,ownFeatures.length),obj({title:{...text(40),description:'일상적인 한국어로 기능 또는 작업의 목적. 코드의 이름과 구현 수단 대신 사용자가 할 수 있는 일.'},outcome:{...text(85),description:'구체적으로 바뀐 기능이나 제공한 산출물을 완결된 한국어 한 문장으로. 코드 용어 및 추정 성과 금지.'},kind:{type:'string',enum:['development','improvement','documentation','quality','maintenance','design','assets']},feature_refs:{...arr({type:'integer',minimum:1,maximum:ownFeatures.length}),minItems:1,maxItems:1}})),minItems:1}});
    const result=await generate(call,'member_brief',input,schema,o=>{validateMemberBrief(o);const refs=o.activities.flatMap((a:any)=>a.feature_refs);if(new Set(refs).size!==refs.length)throw new Error('같은 기능을 여러 활동으로 중복하지 마세요');for(const a of o.activities){const fs=a.feature_refs.map((n:number)=>ownFeatures[n-1]);const repos=new Set(fs.map((f:any)=>f.repository_id));if(repos.size!==1)throw new Error('각 활동은 하나의 저장소에 연결하세요');const claims=fs.flatMap((f:any)=>f.member_contributions.filter((c:any)=>c.person_id===person.person_id));if(claims.length&&claims.every((c:any)=>c.scope==='documentation')&&['development','improvement'].includes(a.kind))throw new Error('문서 기여를 기능 구현으로 표시하지 마세요. documentation을 사용하세요');}});
    const activities=result.activities.map((a:any)=>{const fs=a.feature_refs.map((n:number)=>ownFeatures[n-1]);const branch=fs.some((f:any)=>f.delivery.branch_only_commits.length>0),integrated=fs.some((f:any)=>f.delivery.default_branch_commits.length>0);return {...a,quality_note:confirmedQualityNote(fs),feature_ids:fs.map((f:any)=>f.feature_id),repository_id:fs[0].repository_id,difficulty:Math.max(...fs.map((f:any)=>f.difficulty.level||0))||null,delivery:branch?(integrated?'mixed':'branch'):'integrated'};});
    await persist(run,'member',person.person_id,cache.revision,{...result,summary:activities[0].outcome,person_id:person.person_id,repository_ids:repoIds,activities,generation:'llm_member_brief'});
  });
  await db.query("UPDATE evaluation_runs SET summary=summary||jsonb_build_object('executive_status','complete') WHERE id=$1",[run.id]);
}
