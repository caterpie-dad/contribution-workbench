import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGrounding} from '../src/evaluation/grounding.js';
test('개인 종합은 원문 역할 검사에서 계정 혼동·평가 업무 귀속·지원하지 않는 검토 주장이 발견되면 수용하지 않는다',()=>{
  const valid={identity_mapping_respected:true,no_evaluator_activity_attribution:true,no_unobserved_review_or_execution_claims:true,issues:[]};checkGrounding(valid);checkGrounding({...valid,observation_limits:['CI 결과 미제공은 초안의 사실 오류를 뜻하지 않음']});
  for(const key of ['identity_mapping_respected','no_evaluator_activity_attribution','no_unobserved_review_or_execution_claims'])assert.throws(()=>checkGrounding({...valid,[key]:false}),/사실 검증/);
  assert.throws(()=>checkGrounding({...valid,issues:['Git 작성자를 별도 분석 보조로 오인함']}),/사실 검증/);
});
