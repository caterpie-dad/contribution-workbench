import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {db,migrate} from '../src/db.js';
import {saveConfiguration,createCollection,cancelJob} from '../src/jobs.js';
after(()=>db.end());
test('평가 중단은 작업·실행 상태를 함께 바꾸고 저장된 결과를 보존하며 반복 요청은 안전하다',async()=>{
  await migrate();const c=await saveConfiguration(JSON.parse(fs.readFileSync('design/team-config.example.json','utf8')));
  const collection=await createCollection(c.id,'cancel-contract');const collectionJob=(await db.query('SELECT id FROM jobs WHERE target_id=$1',[collection])).rows[0];await cancelJob(collectionJob.id,'cancel-contract');
  for(const status of ['pending','running']){
    const id=randomUUID(),job=randomUUID(),partial={summary:'보존할 중간 결과',score:3};
    await db.query('INSERT INTO evaluation_runs(id,collection_id,configuration_id,model,status) VALUES($1,$2,$3,$4,$5)',[id,collection,c.id,{},status]);
    await db.query("INSERT INTO jobs(id,kind,target_id,status) VALUES($1,'evaluate',$2,$3)",[job,id,status]);
    await db.query('INSERT INTO portfolios(evaluation_id,person_id,output) VALUES($1,$2,$3)',[id,'member-a',partial]);
    assert.equal((await cancelJob(job,'cancel-contract')).status,'cancelled');assert.equal((await cancelJob(job,'cancel-contract')).changed,false);
    assert.equal((await db.query('SELECT status FROM evaluation_runs WHERE id=$1',[id])).rows[0].status,'cancelled');
    assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[job])).rows[0].status,'cancelled');
    assert.deepEqual((await db.query('SELECT output FROM portfolios WHERE evaluation_id=$1',[id])).rows[0].output,partial);
    assert.equal((await db.query("SELECT count(*) n FROM audit_events WHERE target_id=$1 AND action='job.cancel'",[job])).rows[0].n,'1');
  }
});
test('완료 직후 중단 요청이 도착해도 완료된 평가를 취소 상태로 바꾸지 않는다',async()=>{
  await migrate();const c=await saveConfiguration(JSON.parse(fs.readFileSync('design/team-config.example.json','utf8')));const collection=await createCollection(c.id);const collectJob=(await db.query('SELECT id FROM jobs WHERE target_id=$1',[collection])).rows[0];await cancelJob(collectJob.id,'cancel-contract');
  const id=randomUUID(),job=randomUUID();await db.query("INSERT INTO evaluation_runs(id,collection_id,configuration_id,model,status) VALUES($1,$2,$3,$4,'review_required')",[id,collection,c.id,{}]);await db.query("INSERT INTO jobs(id,kind,target_id,status) VALUES($1,'evaluate',$2,'running')",[job,id]);
  await assert.rejects(()=>cancelJob(job,'cancel-contract'),/이미 종료/);assert.equal((await db.query('SELECT status FROM evaluation_runs WHERE id=$1',[id])).rows[0].status,'review_required');
  await db.query("UPDATE jobs SET status='succeeded' WHERE id=$1",[job]);await assert.rejects(()=>cancelJob(job,'cancel-contract'),/대기·진행/);
});
