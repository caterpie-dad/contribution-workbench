import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const connections=JSON.parse(fs.readFileSync('config/connections.local.json','utf8'));
test('관리자 로그인, 실제 자료·10명, 모델 선택, 원본 탐색, 비밀 미노출',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.getByRole('heading',{name:'작업 공간 열기'})).toBeVisible();
  await page.getByLabel('계정',{exact:true}).fill(connections.application.admin_username);await page.getByLabel('비밀번호',{exact:true}).fill(connections.application.admin_password);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.getByRole('heading',{name:'팀원 기여도',exact:true})).toBeVisible();
  await expect(page.locator('.person-card')).toHaveCount(10);
  await page.screenshot({path:'runtime/verification/dashboard-desktop.png',fullPage:true});
  await expect(page.getByLabel('평가 이력')).toBeVisible();await expect(page.getByLabel('평가 모델',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'평가 시작',exact:true})).toHaveCount(0);await expect(page.locator('.person-card .representative-activity-heading')).toHaveCount(10);await expect(page.locator('.people-grid')).not.toContainText('기여 활동 요약');
  await page.getByRole('button',{name:'수집 현황',exact:true}).click();await page.getByLabel('평가 모델',{exact:true}).selectOption(connections.systems.opencode.llm.default_model_id);await expect(page.getByLabel('평가 모델',{exact:true})).toHaveValue(connections.systems.opencode.llm.default_model_id);
  await page.getByRole('button',{name:'근거 탐색',exact:false}).click();await expect(page.locator('.evidence-list button').first()).toBeVisible();await page.locator('.evidence-list button').first().click();await expect(page.getByText('원본 해시 대조 완료')).toBeVisible();await expect(page.locator('.source-body')).not.toBeEmpty();
  await page.screenshot({path:'runtime/verification/evidence-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'설정 · 모델',exact:false}).click();await expect(page.getByRole('heading',{name:'OpenCode 모델 선택'})).toBeVisible();await expect(page.getByRole('radio')).toHaveCount(connections.systems.opencode.llm.models.length);
  const safe=await page.evaluate(async()=>await (await fetch('/api/connections')).text());expect(safe).not.toContain(connections.systems.opencode.llm.token);expect(safe).not.toContain(connections.application.admin_password);expect(errors).toEqual([]);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'팀원 기여도',exact:false}).click();await page.screenshot({path:'runtime/verification/dashboard-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});
