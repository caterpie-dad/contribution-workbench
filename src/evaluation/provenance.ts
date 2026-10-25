import {TeamConfig} from '../config.js';
import {splitEvidence} from './validate.js';
import {dimensions} from './schemas.js';

export type SourceRole={person_id:string;role:string;basis:string;source_account?:string};
export type DimensionGate={eligible_evidence_ids:string[];observed_deficit_evidence_ids:string[];allowed_scores:(number|null)[];unknown_reason:string};
export type PortfolioGates=Record<string,DimensionGate>;
export function recordedRoles(e:any,t:TeamConfig):SourceRole[]{
  return splitEvidence({...e,body:''},t)[0].person_ids.map(id=>{
    const person=t.members.find(p=>p.person_id===id)!;
    const author=e.kind==='commit'&&(person.identities.commit_emails.some(email=>email.toLowerCase()===e.metadata?.author_email?.toLowerCase())||!!person.identities.github_login&&person.identities.github_login.toLowerCase()===e.metadata?.author_github_login?.toLowerCase());
    const role=e.kind==='commit'?(author?'recorded_commit_author':'recorded_coauthor'):['docs_page','wiki_page'].includes(e.kind)?'recorded_revision_editor':e.kind==='review'?'recorded_reviewer':e.kind.includes('comment')?'recorded_comment_author':'recorded_source_actor';
    const sourceAccount=e.actors.find((actor:string)=>person.identities.commit_emails.some(email=>email.toLowerCase()===actor.toLowerCase())||actor===person.identities.github_login||actor===person.identities.confluence_account_ref)||e.metadata.author_github_login||'';return {person_id:id,role,source_account:sourceAccount,basis:'confirmed_settings_identity_binding_to_source_account'};
  });
}
export function effectiveRoles(e:any,t:TeamConfig,corrections:any[]):SourceRole[]{
  const attribution=corrections.filter(c=>c.type==='attribution'&&c.target_id===e.id).at(-1);
  return attribution?attribution.after_value.person_ids.map((id:string)=>({person_id:id,role:'manager_confirmed_contributor',basis:'manager correction '+attribution.id})):recordedRoles(e,t);
}
export function sourceProfile(e:any){
  let currentPath='',inHunk=false,substantive=false,testChange=false;const paths=new Set<string>();
  for(const line of e.body.split('\n')){
    if(line.startsWith('diff --git ')){currentPath=line.match(/ b\/(.*)$/)?.[1]||'';paths.add(currentPath);inHunk=false;}
    if(line.startsWith('@@')){inHunk=true;continue;}
    if(inHunk&&/^[+-]/.test(line)&&line.slice(1).trim()){
      substantive=true;
      if(/(^|\/)(__tests__|tests?|specs?)(\/|$)|(^|\/)test_[^/]+|(?:\.test|\.spec|_test)\.[^/]+$|(^|\/)(conftest\.py|pytest\.ini)$|\.github\/workflows\//i.test(currentPath))testChange=true;
    }
  }
  const opaque=e.kind==='commit'&&!substantive;const unknownTime=e.metadata?.historical_body_known===false||e.metadata?.historical_body_known===null;
  return {inspectable_material:!opaque&&!unknownTime&&e.body.trim().length>=8,substantive_test_change:testChange,paths:[...paths].filter(Boolean),feedback:['review','review_comment','issue_comment','wiki_comment'].includes(e.kind),notice:'The source account is explicitly linked to person_id by settings. A test change does not imply successful execution; a co-author record does not imply peer review.'};
}
export function portfolioEvidence(personId:string,evidence:any[],t:TeamConfig,corrections:any[],allEvidence:any[]=evidence){
  return evidence.map((e,index)=>({evidence_ref:index+1,evidence_id:e.id,kind:e.kind,title:e.title,url:e.url,occurred_at:e.occurred_at,recorded_roles:recordedRoles(e,t),effective_roles:effectiveRoles(e,t,corrections),person_has_effective_role:effectiveRoles(e,t,corrections).some(role=>role.person_id===personId),source_profile:sourceProfile(e),body:e.body,previous_body:e.metadata.previous_revision?allEvidence.find(previous=>previous.source_id===e.source_id&&previous.object_id===e.object_id&&previous.revision===e.metadata.previous_revision)?.body??null:null,authorship_scope:e.metadata.authorship_scope||'recorded_source_role_only',previous_revision:e.metadata.previous_revision||null}));
}
export function portfolioGates(observed:ReturnType<typeof portfolioEvidence>,assessments:any[]):PortfolioGates{
  const material=observed.filter(e=>e.person_has_effective_role&&e.source_profile.inspectable_material);
  return Object.fromEntries(dimensions.map(key=>{
    const eligible=material.filter(e=>key==='collaboration'?e.source_profile.feedback:key==='verification'?e.source_profile.substantive_test_change:e.source_profile.inspectable_material).map(e=>e.evidence_id);
    const deficits=assessments.filter(a=>eligible.includes(a.evidence_id)&&a.output.parts.some((part:any)=>part.quality.level!==null&&part.quality.level<=2)).map(a=>a.evidence_id);
    const reason=key==='collaboration'?'관찰 범위에 직접적인 리뷰·댓글 상호작용 근거가 없어 협업 수준을 보류합니다. 공동 작성·다수 역할만으로 협업의 질을 추정하지 않습니다.':key==='verification'?'관찰 범위에서 해당 인물의 실질적인 테스트·검증 설정 변경이나 실행 결과를 확인하지 못해 검증 수준을 보류합니다. 미관찰은 낮은 기여가 아닙니다.':'해당 인물의 역할에 연결된 해석 가능한 변경 내용이 부족해 이 항목을 보류합니다. 바이너리 변경 표시는 내용·효과의 증거를 대신하지 않습니다.';
    return [key,{eligible_evidence_ids:eligible,observed_deficit_evidence_ids:deficits,allowed_scores:eligible.length?(deficits.length?[null,1,2,3,4,5]:[null,3,4,5]):[null],unknown_reason:reason}];
  }));
}
export function enforcePortfolioGates(output:any,gates:PortfolioGates){
  for(const key of dimensions){const value=output.dimensions[key],gate=gates[key];if(!gate.allowed_scores.includes(value.score))throw new Error(`${key}: 근거 없는 낮은 점수·미관찰 항목의 점수 부여를 허용하지 않습니다. 허용 값 ${JSON.stringify(gate.allowed_scores)}`);
    if(!gate.eligible_evidence_ids.length&&(value.reason!==gate.unknown_reason||value.evidence_ids.length))throw new Error(key+': 미관찰 항목은 코드가 제공한 보류 사유와 빈 점수 근거 목록을 사용하세요');
    if(value.score!==null&&value.evidence_ids.some((id:string)=>!gate.eligible_evidence_ids.includes(id)))throw new Error(key+': 해당 역할·평가 항목을 지지하지 않는 근거입니다');
    if(value.score!==null&&value.score<3&&!value.evidence_ids.some((id:string)=>gate.observed_deficit_evidence_ids.includes(id)))throw new Error(key+': 낮은 점수에는 관찰된 미충족 근거가 필요합니다');
  }
}
