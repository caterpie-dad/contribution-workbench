import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {technologyFacts} from '../src/management/repository-catalog.js';
import {validateExecutiveText,validateMemberBrief,confirmedQualityNote,executiveFeatureInput} from '../src/management/executive.js';
import {db} from '../src/db.js';
import {mirror,git} from '../src/collectors/github.js';
import {readConnections} from '../src/config.js';
import {fixtureGit} from './fixtures/git.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
after(()=>db.end());
test('지정한 mirror 경로를 재사용해도 원격의 새 이력을 갱신한다',async()=>{
  const fixture=await fixtureGit();const exec=promisify(execFile);
  try{const work=(await git(fixture.bare,['remote','get-url','origin'])).trim();await fs.appendFile(path.join(work,'code.py'),'\n# follow-up change\n');await exec('git',['-C',work,'add','.']);await exec('git',['-C',work,'-c','user.name=Contract Author','-c','user.email=a@example.test','commit','-m','New remote change']);const sha=(await exec('git',['-C',work,'rev-parse','HEAD'])).stdout.trim();assert.notEqual((await git(fixture.bare,['rev-parse','HEAD'])).trim(),sha);const c=structuredClone(readConnections());c.systems.github.url='https://github.fixture';await mirror({repository_id:'repo',source_id:'github-main',url:'https://github.fixture/team/repo',mirror_path:fixture.bare,context_paths:[],docs_paths:[]},c);assert.equal((await git(fixture.bare,['rev-parse','HEAD'])).trim(),sha);}finally{await fixture.cleanup();}
});
test('기술 스택은 실제 파일과 의존성 선언에서 수집하며 이름의 부분 일치로 프레임워크를 만들지 않는다',()=>{
  const facts=technologyFacts([{path:'package.json',body:JSON.stringify({dependencies:{react:'19',fastify:'5','reactive-unrelated':'1'}})}],['src/app.tsx','src/api.ts','tests/foo.py','vendor/foo.go','README.md']);
  assert.deepEqual(facts.map(f=>f.name),['TypeScript','react','fastify']);
  assert.deepEqual(technologyFacts([{path:'pyproject.toml',body:'[project]\ndependencies = ["httpcore>=1", "anyio", "pytest"]'}],['httpx/client.py']).map(f=>f.name),['Python','httpcore','anyio','pytest']);
  assert(!technologyFacts([{path:'package.json',body:'{"dependencies":{"reactive":"1"}}'}],[]).length);
  assert(!technologyFacts([{path:'pyproject.toml',body:'[tool.release]\nnext = "1.2.0"\n[project]\nname = "next"'}],[]).length);
});
test('확인된 기간 말 오류만 품질 표시로 만들며 검증 미실행이나 추정은 결함으로 표시하지 않는다',()=>{
  assert.equal(confirmedQualityNote([{observed_deficits:[{status:'resolution_unknown',defect_kind:'incorrect_behavior'}]}]),'');
  assert.equal(confirmedQualityNote([{observed_deficits:[{status:'resolved_in_later_evidence',defect_kind:'syntax_error'}]}]),'');
  assert.equal(confirmedQualityNote([{observed_deficits:[{status:'present_at_period_end',defect_kind:'syntax_error'}]}]),'예제 문법 오류 수정 필요');
});
test('관리자 카드에서 코드 수준 내용과 반복 면책 문장을 검증 단계에서 거부한다',()=>{
  assert.doesNotThrow(()=>validateExecutiveText({summary:'입력 선택 기능을 확장하고 검증 기반을 보강했습니다.',activities:[{title:'선택형 입력 확장',quality_note:'예제 오류 수정 필요'}]}));
  for(const text of ['core.py의 변경','show_default 문자열 지원','자료가 부족해 확인할 수 없습니다.','변경에서 확인','공개 가상 팀원 시스템의 교정 기능 시험입니다.'])assert.throws(()=>validateExecutiveText({summary:text}));
  assert.doesNotThrow(()=>validateExecutiveText({technology_stack:['Python','flit_core']}));
  assert.throws(()=>validateMemberBrief({activities:[{title:'Choice 제네릭 확장',outcome:'입력값 처리 개선'}]}));
  assert.doesNotThrow(()=>validateMemberBrief({activities:[{title:'명령줄 선택형 입력 확장',outcome:'문자 이외의 선택값도 입력받도록 확장했습니다.'}]}));
});
test('전문 용어의 의미를 재해석할 때 해당 사람의 원문과 의도만 전달한다',()=>{
  const f={title:'Choice expansion',repository_id:'repo',difficulty:{level:3},delivery:{default_branch_commits:['own'],branch_only_commits:[]},recorded_roles:[{person_id:'p',evidence_id:'own'},{person_id:'q',evidence_id:'other'}],member_contributions:[{person_id:'p',scope:'implementation',contribution:'기능 확장'},{person_id:'q',scope:'implementation',contribution:'다른 기능'}],citations:[{source_id:'own',quote:'own actual change'},{source_id:'other',quote:'other contribution'},{source_id:'own',quote:'existing behavior',source_scope:{not_personal_credit:true}}]};
  const input=executiveFeatureInput(f,0,'p',[{id:'own',kind:'commit',title:'Support non-string input'},{id:'other',kind:'commit',title:'Other feature'}]);
  assert.deepEqual(input.original_intents,['Support non-string input']);assert.deepEqual(input.changed_source_quotes,[{source_id:'own',quote:'own actual change'}]);assert(!JSON.stringify(input).includes('other'));assert.deepEqual(input.member_scopes,['implementation']);
});
