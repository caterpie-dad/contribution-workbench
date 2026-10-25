import {test,expect} from '@playwright/test';
import {browserSystem} from '../fixtures/browser-system.js';
test('보고 화면에서 평가를 중단하고 중간 결과를 보존하며 종료된 평가의 진행 문구는 숨긴다',async({page})=>{
  const system=await browserSystem();
  try{
    await page.goto(system.url);await page.getByLabel('계정',{exact:true}).fill(system.username);await page.getByLabel('비밀번호',{exact:true}).fill(system.password);await page.getByRole('button',{name:'로그인',exact:true}).click();
    await expect(page.getByRole('heading',{name:'팀원 기여도',exact:true})).toBeVisible();
    await page.evaluate(async configuration=>{await fetch('/api/configuration',{method:'PUT',headers:{'Content-Type':'application/json','X-Contribution-Request':'1'},body:JSON.stringify({configuration})});},system.configuration);
    const seeded=await system.seedEvaluation();await page.getByRole('button',{name:'새로고침',exact:true}).click();await expect(page.getByLabel('평가 이력')).toHaveValue(seeded.id);
    await expect(page.locator('.analysis-progress')).toContainText('평가 진행 중');await expect(page.locator('.workspace')).not.toContainText('저장소 전체 구현·기술 스택 분석');
    await expect(page.locator('.person-card .representative-activity-heading')).toHaveCount(2);await expect(page.locator('.people-grid')).not.toContainText('기여 활동 요약');
    const get=(url:string)=>page.evaluate(async path=>await(await fetch('/api'+path)).json(),url);
    const before=JSON.stringify((await get('/evaluation-runs/'+seeded.id)).portfolios);
    await page.getByRole('button',{name:'평가 중단',exact:true}).click();await expect(page.locator('.evaluation-state')).toHaveText('중단');await expect(page.locator('.analysis-progress')).toHaveCount(0);
    expect((await get('/overview')).jobs.find((j:any)=>j.id===seeded.job).status).toBe('cancelled');expect(JSON.stringify((await get('/evaluation-runs/'+seeded.id)).portfolios)).toBe(before);
    const completed=await system.seedEvaluation('review_required');await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByLabel('평가 이력').selectOption(completed.id);await expect(page.locator('.evaluation-state')).toHaveText('관리자 검토 대기');await expect(page.locator('.analysis-progress')).toHaveCount(0);await expect(page.getByRole('button',{name:'평가 중단',exact:true})).toHaveCount(0);
    await page.screenshot({path:'runtime/verification/evaluation-controls-completed.png',fullPage:true});
  }finally{await system.close();}
});
