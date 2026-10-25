import {isDeepStrictEqual as equal} from 'node:util';
import {db} from '../src/db.js';
import {readRaw} from '../src/storage.js';
import {canonicalValue} from '../src/evaluation/reuse.js';
import {conciseChangeFacts} from '../src/management/digests.js';
import {bindCitations,bindDeficitCitations,validateSchema} from '../src/management/contracts.js';
import {partHasOwnSource,personalWorkFacts} from '../src/management/personal-features.js';
import {effectiveRoles} from '../src/evaluation/provenance.js';
import {functionalExecutionEvidence,rejectUnobservedExecution} from '../src/management/observability.js';

type Check=(name:string,passed:boolean,details?:any)=>void;
const sameSet=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(id=>b.includes(id));
export async function auditPersonalFeatures(run:any,t:any,evidence:any[],cases:any[],facts:Map<string,any>,views:any[],people:any[],packs:any[],raw:Map<string,any>,quoteValid:(q:any)=>boolean,check:Check){
  const parts=new Map((await db.query('SELECT output FROM management_digest_parts WHERE evaluation_id=$1',[run.id])).rows.map(r=>[r.output.part_id,r.output]));
  const assessed=new Set((await db.query('SELECT evidence_id FROM assessments WHERE evaluation_id=$1',[run.id])).rows.map(r=>r.evidence_id));
  for(const person of t.members){
    const own=views.filter(v=>v.person_id===person.person_id),required=evidence.filter(e=>assessed.has(e.id)&&effectiveRoles(e,t,run.corrections).some(r=>r.person_id===person.person_id)).map(e=>e.id);
    check('personal_views_cover_own_sources_once_'+person.person_id,sameSet(own.flatMap(v=>v.evidence_ids),required),{views:own.length,sources:required.length});
  }
  for(const view of views){
    const ids=new Set<string>(view.evidence_ids),roles=cases.flatMap(c=>c.roles).filter(r=>r.person_id===view.person_id&&ids.has(r.evidence_id));
    check('personal_view_has_only_recorded_own_roles_'+view.feature_id,equal(view.recorded_roles.map((r:any)=>JSON.stringify(canonicalValue(r))).sort(),roles.map(r=>JSON.stringify(canonicalValue(r))).sort()));
    const all=[...view.citations,...view.impacts.flatMap((i:any)=>i.citations),...view.member_contributions.flatMap((m:any)=>m.citations),...view.observed_deficits.flatMap((d:any)=>d.citations)];
    check('personal_view_exact_original_quotes_'+view.feature_id,all.every(quoteValid));
    check('personal_view_positive_quotes_are_own_'+view.feature_id,view.member_contributions.every((m:any)=>m.person_id===view.person_id&&m.citations.every((q:any)=>!q.source_scope?.not_personal_credit&&ids.has(q.source_evidence_id||q.source_id)&&roles.some(r=>r.evidence_id===(q.source_evidence_id||q.source_id)))));
    try{rejectUnobservedExecution([view.title,view.change_summary,view.system_significance,view.quality_assessment,...view.member_contributions.map((m:any)=>m.contribution)],functionalExecutionEvidence(evidence,evidence.filter(e=>ids.has(e.id)),t.period.as_of));check('personal_view_execution_observability_'+view.feature_id,true);}catch(error){check('personal_view_execution_observability_'+view.feature_id,false,{error:String(error)});}
    if(view.generation==='rule_integration_record'){
      check('integration_record_does_not_claim_implementation_quality_'+view.feature_id,roles.every(r=>r.contribution_scope==='integration_only')&&view.difficulty.level===null&&view.impacts.length===0&&view.observed_deficits.length===0&&view.coverage.synthesis_calls===0&&view.member_contributions.every((m:any)=>m.scope==='integration'));continue;
    }
    if(view.generation==='rule_insufficient_changed_material'){
      check('opaque_personal_view_defers_quality_'+view.feature_id,view.difficulty.level===null&&view.impacts.length===0&&view.member_contributions.length===0&&view.coverage.synthesis_calls===0);continue;
    }
    const ownCases=cases.filter(c=>view.case_ids.includes(c.case_id));
    const expectedUnits=ownCases.flatMap(c=>facts.get(c.case_id).change_parts.filter((p:any)=>partHasOwnSource(p,ids,parts)).map((p:any)=>p.part_id));
    check('personal_view_complete_own_fact_units_'+view.feature_id,sameSet(view.coverage.unit_ids,expectedUnits));
    const calls=packs.filter(({trace,pack})=>trace.stage==='personal_feature_synthesis'&&pack.input.personal_feature_id===view.feature_id&&pack.input.person.person_id===view.person_id),seen:string[]=[];
    let exactOrigin=false;
    for(const {trace,pack} of calls){
      const input=pack.input,rawOutput=JSON.parse((await readRaw(trace.response_ref)).toString()).info?.structured;
      check('personal_input_contains_only_own_sources_'+trace.id,sameSet(input.own_source_ids,view.evidence_ids)&&input.people.length===1&&input.people[0].person_id===view.person_id&&input.source_catalog.every((s:any)=>{const original=raw.get(s.source_id);if(!original||!original.body.includes(s.body)||original.url!==s.url)return false;return s.source_scope?.not_personal_credit===true||ids.has(s.source_scope?.source_evidence_id||s.source_id)&&equal(s.source_scope.allowed_person_ids,[view.person_id]);}));
      for(const unit of input.case_changes){seen.push(unit.unit_id);const part=parts.get(unit.unit_id);check('personal_input_uses_actual_own_fact_'+trace.id+'_'+unit.unit_id,!!part&&expectedUnits.includes(unit.unit_id)&&equal(unit.changes,canonicalValue(conciseChangeFacts({change_parts:[part]}))));const ownQuotes=(part?.citations||[]).filter((q:any)=>!q.source_scope?.not_personal_credit&&ids.has(q.source_evidence_id||q.source_id));check('personal_input_preserves_fact_quotes_'+trace.id+'_'+unit.unit_id,ownQuotes.every((q:any)=>[...input.source_catalog,...(input.raw_owned_material||[])].some((s:any)=>(s.source_id||s.id)===q.source_id&&s.body.includes(q.quote))));}
      for(const source of input.raw_owned_material||[])check('personal_raw_material_'+trace.id+'_'+source.id,raw.get(source.id)?.body===source.body&&ids.has(source.metadata?.source_evidence_id||source.id));
      if(rawOutput&&['title','previous_limitation','change_summary','system_significance','difficulty','quality_assessment','verification','limitations','counter_evidence'].every(key=>equal(rawOutput[key],view[key]))){
        validateSchema(pack.schema,rawOutput);
        const sources=input.source_catalog.map((s:any)=>({id:s.source_id,title:s.title,url:s.url,body:s.body,metadata:s.source_scope}));
        const members=Object.values(rawOutput.member_contributions).map((m:any)=>({...m,person_id:view.person_id,citations:bindCitations(m.citations,sources)}));
        const deficits=rawOutput.observed_deficits.map((d:any)=>({...d,affected_person_ids:d.affected_person_refs.length?[view.person_id]:[],citations:bindDeficitCitations(d,sources)}));
        const impacts=rawOutput.impacts.map((i:any)=>({...i,citations:bindCitations(i.citations,sources)}));
        if(equal(canonicalValue(impacts),view.impacts)&&equal(canonicalValue(members),view.member_contributions)&&equal(canonicalValue(deficits),view.observed_deficits)&&equal(canonicalValue(bindCitations(rawOutput.citations,sources)),view.citations))exactOrigin=true;
      }
    }
    check('personal_view_all_fact_batches_reached_model_'+view.feature_id,sameSet([...new Set(seen)],expectedUnits));
    check('personal_view_exact_model_origin_'+view.feature_id,exactOrigin);
    const reviews=packs.filter(({trace,pack})=>trace.stage==='personal_feature_grounding'&&pack.input.personal_feature_id===view.feature_id&&['title','previous_limitation','change_summary','system_significance','difficulty','quality_assessment','verification','member_contributions','impacts','observed_deficits','citations','limitations','counter_evidence'].every(key=>equal(canonicalValue(pack.input.feature_report[key]),view[key])));
    const outputs=[];for(const {trace} of reviews)outputs.push(JSON.parse((await readRaw(trace.response_ref)).toString()).info.structured);
    check('personal_view_has_own_independent_review_'+view.feature_id,reviews.length>0&&equal([...new Set(outputs.flatMap(o=>o.unsupported_claims))],view.factual_review.unsupported_claims)&&equal([...new Set(outputs.flatMap(o=>o.observation_limits))],view.factual_review.observation_limits));
    for(const d of view.observed_deficits){
      const primary=d.citations.filter((q:any)=>!q.source_scope?.not_personal_credit&&ids.has(q.source_evidence_id||q.source_id));
      check('personal_defect_has_concrete_failure_'+view.feature_id,typeof d.failure_scenario==='string'&&d.failure_scenario.trim().length>=8);
      if(d.status==='present_at_period_end')check('personal_end_state_defect_'+view.feature_id,d.citations.some((q:any)=>q.source_scope?.at_period_end&&raw.get(q.source_id)?.metadata.at_period_end)&&d.affected_person_ids.every((id:string)=>id===view.person_id)&&primary.some((q:any)=>{const e=raw.get(q.source_evidence_id||q.source_id);return view.delivery.default_branch_commits.includes(e?.kind==='commit'?e.revision:e?.metadata?.overlap_commit||e?.metadata?.linked_commit);}));
      if(d.status==='resolved_in_later_evidence')check('personal_defect_resolution_has_distinct_events_'+view.feature_id,new Set(primary.map((q:any)=>cases.find(c=>c.evidence_ids.includes(q.source_evidence_id||q.source_id))?.case_id).filter(Boolean)).size>=2);
    }
  }
  for(const person of people.filter(p=>p.output.management?.personal_feature_views&&p.output.generation.startsWith('llm_'))){
    const own=views.filter(v=>v.person_id===person.person_id),ownCases=cases.filter(c=>own.some(v=>v.case_ids.includes(c.case_id))),expected=canonicalValue(personalWorkFacts(person.person_id,ownCases,facts,evidence,parts));
    check('portfolio_receives_personal_facts_and_views_'+person.person_id,packs.some(({trace,pack})=>trace.stage==='management_portfolio'&&pack.input.person.person_id===person.person_id&&equal(pack.input.person_change_facts,expected)&&pack.input.functional_contributions.every((f:any)=>own.some(v=>v.title===f.title&&v.change_summary===f.change_summary&&v.system_significance===f.system_significance))));
  }
}
