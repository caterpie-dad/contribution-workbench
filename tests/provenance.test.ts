import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {recordedRoles,portfolioEvidence,portfolioGates,enforcePortfolioGates,sourceProfile} from '../src/evaluation/provenance.js';
const team=JSON.parse(fs.readFileSync('design/team-config.example.json','utf8'));
const image={id:'image',kind:'commit',source_id:'repo-platform',title:'Update graphic',body:'Binary files a/logo.png and b/logo.png differ',actors:['member-a@company.example'],metadata:{author_email:'member-a@company.example'}};
test('바이너리 작성자를 AI의 조사 보조로 바꾸지 않고 내용·검증·협업을 미확인으로 보류한다',()=>{
  assert.equal(recordedRoles(image,team)[0].role,'recorded_commit_author');const observed=portfolioEvidence('member-a',[image],team,[]);const gates=portfolioGates(observed,[]);assert(Object.values(gates).every(gate=>gate.allowed_scores.length===1&&gate.allowed_scores[0]===null));
});
test('기존 assert 주변 빈 줄만 바뀌면 신규 테스트·협업 근거가 되지 않는다',()=>{
  const whitespace={...image,id:'space',body:'diff --git a/test_boundary.py b/test_boundary.py\n@@ -1,2 +1,3 @@\n assert boundary(1)\n+\n'};
  assert.equal(sourceProfile(whitespace).substantive_test_change,false);const code={...image,id:'code',body:'diff --git a/code.py b/code.py\n@@ -1 +1 @@\n-return 0\n+return 1\n'};const gates=portfolioGates(portfolioEvidence('member-a',[code,whitespace],team,[]),[]);assert.deepEqual(gates.verification.allowed_scores,[null]);assert.deepEqual(gates.collaboration.allowed_scores,[null]);assert.deepEqual(gates.problem_solving.allowed_scores,[null,3,4,5]);
});
test('실제 테스트 변경만 검증 기여 후보로 연결하고 미제공 CI를 낮은 점수로 바꾸지 않는다',()=>{
  const change={...image,id:'tests',body:'diff --git a/test_boundary.py b/test_boundary.py\n@@ -0,0 +1 @@\n+assert boundary(1)\n'};const gates=portfolioGates(portfolioEvidence('member-a',[change],team,[]),[]);assert.deepEqual(gates.verification.eligible_evidence_ids,['tests']);assert(!gates.verification.allowed_scores.includes(2));const dimensions=Object.fromEntries(Object.keys(gates).map(key=>[key,{score:null,reason:gates[key].unknown_reason,evidence_ids:[]}]));enforcePortfolioGates({dimensions},gates);dimensions.verification.score=2 as any;assert.throws(()=>enforcePortfolioGates({dimensions},gates),/근거 없는/);
});
test('관리자 귀속 교정은 원본의 작성자 기록을 보존하며 새로운 기여자의 유효 역할을 분리한다',()=>{
  const observed=portfolioEvidence('member-b',[image],team,[{id:'correction',type:'attribution',target_id:'image',after_value:{person_ids:['member-b']}}]);assert.equal(observed[0].recorded_roles[0].person_id,'member-a');assert.equal(observed[0].effective_roles[0].person_id,'member-b');assert.equal(observed[0].effective_roles[0].role,'manager_confirmed_contributor');
});
