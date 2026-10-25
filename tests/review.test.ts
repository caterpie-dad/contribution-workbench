import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAssessment} from '../src/evaluation/review.js';
test('원문 인용 일치와 정성 평가를 구분하고 바이너리·빈 줄 변경·변경하지 않은 인용을 재검토 표시한다',()=>{
  const assessment={parts:[{citations:[{quote:'     assert result.exit_code == 0'}],quality:{level:5}}]};const original=structuredClone(assessment);
  assert.equal(reviewAssessment({kind:'commit',body:'Binary files a/image.png and b/image.png differ'},assessment)[0].code,'binary_content_unobserved');
  const patch='diff --git a/a.py b/a.py\n@@ -1,2 +1,3 @@\n     assert result.exit_code == 0\n+\n';
  assert.equal(reviewAssessment({kind:'commit',body:patch},assessment)[0].code,'blank_line_change_only');
  const change='diff --git a/a.py b/a.py\n@@ -1,2 +1,3 @@\n     assert result.exit_code == 0\n+    assert result.value == 42\n';
  assert.equal(reviewAssessment({kind:'commit',body:change},assessment)[0].code,'changed_lines_not_cited');
  assert.deepEqual(reviewAssessment({kind:'commit',body:change},{parts:[{citations:[{quote:'+    assert result.value == 42'}]}]}),[]);
  assert.deepEqual(assessment,original);
  assert.deepEqual(reviewAssessment({kind:'wiki_page',body:patch},assessment),[]);
});
