import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {readConnections} from '../src/config.js';
const settings=readConnections();
const manifest=JSON.parse(await fs.readFile('runtime/verification/demo-run.json','utf8'));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const report:any={evaluation_id:manifest.evaluation_id,started_at:new Date().toISOString(),checks:[],screenshots:[],members:[]};
const forbidden=/show_default|core\.py|termui\.py|CHANGES|변경에서 확인|해결하려던 제약|자료가? 부족|이 기록만으로 확인|공개 가상 팀원|자동화 에이전트|독립적인 사람의 검토/;
async function capture(name:string){await page.screenshot({path:'runtime/verification/'+name,fullPage:true});report.screenshots.push(name);}
async function managerContent(selector:string){const text=await page.locator(selector).innerText();if(forbidden.test(text))throw new Error('관리자 화면에 코드 세부 내용 또는 시험 설명이 남았습니다');await expect(page.locator(selector+' table,'+selector+' details')).toHaveCount(0);}
async function width(){if(!await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))throw new Error('모바일 화면 가로 넘침');}
try{
  await page.goto(process.env.DASHBOARD_URL||'http://127.0.0.1:3100');
  await page.getByLabel('계정',{exact:true}).fill(settings.application.admin_username);await page.getByLabel('비밀번호',{exact:true}).fill(settings.application.admin_password);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.getByLabel('평가 이력').selectOption(manifest.evaluation_id);
  const d=await page.evaluate(async id=>await(await fetch('/api/evaluation-runs/'+id)).json(),manifest.evaluation_id);
  const repoBriefs=d.executive_briefs.filter((b:any)=>b.kind==='repository'),members=d.executive_briefs.filter((b:any)=>b.kind==='member');
  if(repoBriefs.length!==d.configuration.repositories.length||members.length!==d.configuration.members.length)throw new Error('전체 저장소·팀원 카드 분석이 아직 완료되지 않았습니다');
  await expect(page.locator('.person-card')).toHaveCount(d.configuration.members.length);
  await managerContent('.executive-people-grid');await capture('executive-members-desktop.png');
  await page.getByRole('button',{name:'저장소 평가',exact:true}).click();await expect(page.locator('.repository-card')).toHaveCount(repoBriefs.length);
  await managerContent('.repository-evaluation');
  for(const b of repoBriefs){const card=page.locator('#repository-'+b.subject_id);await expect(card.locator('.repo-card-purpose')).toHaveText(b.output.purpose);await expect(card.locator('.tech-stack span')).toHaveCount(b.output.technology_stack.length);await expect(card.locator('.repo-functions>div>div')).toHaveCount(b.output.capabilities.length);await expect(card.locator('.difficulty-scale')).toContainText(b.output.difficulty.level+' / 5');if(!b.output.coverage.analyzed_files||!b.output.coverage.manifest_hash)throw new Error('전체 저장소 분석 범위 기록 누락');const related=d.configuration.members.filter((p:any)=>p.repository_assignments.some((a:any)=>a.repository_id===b.subject_id));for(const p of related)await expect(card.locator('.participant-chip').filter({hasText:p.display_name})).toHaveCount(1);}
  await capture('executive-repositories-desktop.png');report.checks.push('Every configured repository has an expanded system card with stack, capabilities, difficulty and mapped team members.');
  for(const p of d.configuration.members){
    await page.getByRole('button',{name:'팀원 기여도',exact:true}).click();const brief=members.find((b:any)=>b.subject_id===p.person_id).output;
    const card=page.locator('.person-card[data-person-id="'+p.person_id+'"]');await expect(card.locator('.repo-chips')).not.toBeEmpty();await expect(card.locator('.activity-item')).toHaveCount(brief.activities.length);await card.locator('.person-open').click();
    await expect(page.locator('.member-activities')).not.toBeEmpty();await managerContent('.member-detail');await expect(page.locator('.member-activities .activity-item')).toHaveCount(brief.activities.length);
    const allowed=d.personal_feature_reports.filter((f:any)=>f.person_id===p.person_id).map((f:any)=>f.feature_id);
    if(brief.activities.some((a:any)=>a.feature_ids.some((id:string)=>!allowed.includes(id))))throw new Error('다른 팀원의 활동이 표시됨: '+p.person_id);
    if(['test-member-03','test-member-06','test-member-08','test-member-09'].includes(p.person_id))await capture('executive-'+p.person_id+'.png');
    report.members.push({person_id:p.person_id,summary:brief.summary,activities:brief.activities.map((a:any)=>({title:a.title,kind:a.kind,repository_id:a.repository_id,quality_note:a.quality_note}))});
  }
  report.checks.push('All member cards and details show only own representative activities and participating repositories; no commit lists or audit boilerplate.');
  await page.getByRole('button',{name:'근거 보기 ↗',exact:true}).click();await page.locator('.evidence-list button').first().click();await expect(page.getByText('원본 해시 대조 완료')).toBeVisible();await expect(page.locator('.source-body')).not.toBeEmpty();
  await page.getByRole('button',{name:'사실 · 귀속 교정',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'교정 닫기',exact:true}).click();report.checks.push('Evidence navigation, original hash verification and correction dialog remain available separately.');
  await page.getByRole('button',{name:'변경 이력',exact:true}).click();if(d.corrections.length)await expect(page.locator('.audit-correction')).toHaveCount(d.corrections.length);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'저장소 평가',exact:true}).click();await width();await capture('executive-repositories-mobile.png');
  await page.getByRole('button',{name:'팀원 기여도',exact:true}).click();await width();await capture('executive-members-mobile.png');await page.locator('.person-open').first().click();await width();await capture('executive-member-mobile.png');
  if(errors.length)throw new Error(errors.join('\n'));report.checks.push('Repository, member list and member detail fit mobile width with no browser errors.');report.passed=true;
}catch(e){report.passed=false;report.error=String(e);process.exitCode=1;await capture('executive-browser-failure.png');}
finally{await browser.close();report.finished_at=new Date().toISOString();await fs.writeFile('runtime/verification/management-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,people:report.members.length,screenshots:report.screenshots,error:report.error}));}
