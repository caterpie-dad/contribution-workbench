import fs from 'node:fs/promises';
import {db,one} from '../src/db.js';
import {readConnections,resolveModel} from '../src/config.js';
import {splitEvidence,checkAssessments} from '../src/evaluation/validate.js';
import {unitSchema,citationSpans} from '../src/evaluation/schemas.js';
import {rubric} from '../src/evaluation/engine.js';
import {reviewAssessment} from '../src/evaluation/review.js';
import {callOpenCode,stopOpenCode} from '../src/evaluation/opencode.js';
import {saveRaw} from '../src/storage.js';

const manifest=JSON.parse(await fs.readFile('runtime/verification/demo-run.json','utf8'));
const run=await one('SELECT * FROM evaluation_runs WHERE id=$1',[manifest.evaluation_id]);
const team=(await one('SELECT body FROM configurations WHERE id=$1',[run.configuration_id])).body;
const results:any[]=[];
const cancellation=new AbortController();process.once('SIGTERM',()=>cancellation.abort());process.once('SIGINT',()=>cancellation.abort());
try{
  const evidence=(await db.query('SELECT * FROM evidence WHERE collection_id=$1',[run.collection_id])).rows;
  const model=resolveModel(readConnections());if(model.model_id!==run.model.model_id)throw new Error('검증 모델은 실행 모델과 같아야 합니다');
  const binary=evidence.find(e=>e.kind==='commit'&&/^Binary files /m.test(e.body));
  const blank=evidence.find(e=>reviewAssessment(e,{parts:[{citations:[]}]}).some(f=>f.code==='blank_line_change_only'));
  const substantive=evidence.filter(e=>e.kind==='commit'&&splitEvidence(e,team)[0].person_ids.length&&e.body.length<8000&&!reviewAssessment(e,{parts:[{citations:[]}]}).length).sort((a,b)=>a.body.length-b.body.length)[0];
  for(const scenario of [{name:'binary_without_content',evidence:binary},{name:'blank_line_only',evidence:blank},{name:'counts_1',evidence:substantive,count:1},{name:'counts_1000',evidence:substantive,count:1000}]){
    if(!scenario.evidence)throw new Error('검증 표본이 없습니다: '+scenario.name);
    const e=scenario.evidence,unit=splitEvidence(e,team)[0];
    const input={required_unit_ids:[unit.unit_id],allowed_person_ids:unit.person_ids,units:[{...unit,citation_spans:citationSpans(unit.body)}],repository_context:evidence.filter(c=>c.source_id===e.source_id&&c.kind==='context').map(c=>({evidence_id:c.id,body:c.body,context_role:'repository_requirements'})),applied_corrections:[],source_observation_flags:reviewAssessment(e,{parts:[{citations:[]}]}),validation_feedback:'',...(scenario.count?{sensitivity_test_metadata:{notice:'Synthetic count for isolated sensitivity test; not actual activity.',non_scoring_commit_count:scenario.count}}:{}),instructions:'Assess the supplied unit with exact source span IDs. Use all required unit IDs and only allowed person IDs. Activity counts are not quality, difficulty, or contribution scores.'};
    const schema=unitSchema(unit),prompt=rubric+'\nTASK: evidence_assessment\nINPUT_JSON:\n'+JSON.stringify(input);
    const response=await callOpenCode(prompt,schema,model,{system:rubric,signal:cancellation.signal});const checked=checkAssessments(response.output,[unit],new Map([[e.id,e.body]]));
    const inputRef=await saveRaw(JSON.stringify({input,prompt,system:rubric,schema})),responseRef=await saveRaw(JSON.stringify(response.raw));
    results.push({scenario:scenario.name,evidence_id:e.id,assessment:checked[0],input_ref:inputRef,response_ref:responseRef,session_id:response.sessionId,observed_model:response.observedModel});
    console.log(JSON.stringify({scenario:scenario.name,difficulty:checked[0].difficulty.level,quality:checked[0].quality.level,session_id:response.sessionId}));
  }
  const base=results.find(r=>r.scenario==='counts_1').assessment,inflated=results.find(r=>r.scenario==='counts_1000').assessment;
  const report={created_at:new Date().toISOString(),evaluation_id:run.id,model,results,binary_quality_deferred:results[0].assessment.quality.level===null,count_pair_levels_equal:base.difficulty.level===inflated.difficulty.level&&base.quality.level===inflated.quality.level,notice:'실제 OpenCode·OpenAI 호출의 제한된 표본 관찰입니다. 합성 활동 수는 감도 시험에만 사용하며 평가 DB의 판정·점수·원본은 바꾸지 않습니다. 동일 점수는 일반적인 편향 부재를 증명하지 않습니다.'};
  await fs.writeFile('runtime/verification/process-verification.json',JSON.stringify(report,null,2));if(!report.binary_quality_deferred)process.exitCode=1;
}finally{await stopOpenCode();await db.end();}
