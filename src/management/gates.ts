import {portfolioGates} from '../evaluation/provenance.js';

// A commit-level quality guess is not the person's functional outcome.
// A low recommendation requires a cited, unresolved end-state defect tied to
// the person's own changed source and the relevant evaluation dimension.
export function functionalGates(personId:string,observed:any[],features:any[]){
  const gates=portfolioGates(observed.map(e=>features.some(f=>['change_unknown','no_content_change'].includes(f.material_status?.[e.evidence_id]))?{...e,source_profile:{...e.source_profile,inspectable_material:false}}:e),[]);
  const integrationIds=new Set(features.flatMap(f=>f.recorded_roles.filter((r:any)=>r.person_id===personId&&r.contribution_scope==='integration_only').map((r:any)=>r.evidence_id)));
  for(const key of ['problem_solving','implementation_scope_and_consistency','verification','reusable_knowledge']){const gate=gates[key];gate.eligible_evidence_ids=gate.eligible_evidence_ids.filter(id=>!integrationIds.has(id));if(!gate.eligible_evidence_ids.length){gate.allowed_scores=[null];gate.unknown_reason='병합 기록만으로 다른 사람이 구현한 해결·테스트·지식을 해당 팀원의 성과로 귀속할 수 없어 이 항목을 보류합니다. 통합의 실제 해결·검증 근거가 추가로 필요합니다.';}}
  for(const feature of features)for(const deficit of feature.observed_deficits||[]){
    if(deficit.status!=='present_at_period_end'||!deficit.affected_person_ids.includes(personId)||!deficit.citations.some((c:any)=>c.source_scope?.at_period_end===true))continue;
    for(const key of deficit.affected_dimensions){const gate=gates[key];if(!gate)throw new Error('알 수 없는 기능 평가 항목');
      const linked=deficit.citations.filter((c:any)=>!c.source_scope?.not_personal_credit).map((c:any)=>c.source_evidence_id||c.source_id).filter((id:string)=>gate.eligible_evidence_ids.includes(id)&&feature.recorded_roles.some((r:any)=>r.person_id===personId&&r.evidence_id===id));
      if(linked.length){gate.observed_deficit_evidence_ids=[...new Set([...gate.observed_deficit_evidence_ids,...linked])];gate.allowed_scores=[null,1,2,3,4,5];}
    }
  }
  return gates;
}
