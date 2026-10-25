import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {db,one,transaction,audit} from './db.js';
import {hash,validateTeam,readConnections,resolveModel,TeamConfig,redact} from './config.js';
import {collectGithub} from './collectors/github.js';
import {collectWiki} from './collectors/confluence.js';
import {evaluate,evaluationContract} from './evaluation/engine.js';
export async function saveConfiguration(raw:unknown){const t=validateTeam(raw);const id=hash(t);await db.query('INSERT INTO configurations(id,body) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,t]);return {id,body:t};}
export async function createCollection(configurationId:string,actor='system'){await one('SELECT id FROM configurations WHERE id=$1',[configurationId]);const id=randomUUID();await transaction(async c=>{await c.query(`INSERT INTO collection_runs(id,configuration_id,status) VALUES($1,$2,'pending')`,[id,configurationId]);await c.query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'collect',$2)`,[randomUUID(),id]);});await audit(actor,'collection.created',id);return id;}
export async function cancelJob(id:string,actor:string){
  const result=await transaction(async c=>{
    const job=(await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!job)throw new Error('작업을 찾을 수 없습니다');
    if(job.status==='cancelled')return {ok:true,status:'cancelled',changed:false};
    if(!['pending','running'].includes(job.status))throw Object.assign(new Error('대기·진행 중인 작업만 중단할 수 있습니다'),{statusCode:409});
    if(!['collect','evaluate'].includes(job.kind))throw new Error('지원하지 않는 작업');
    const table=job.kind==='collect'?'collection_runs':'evaluation_runs';
    const run=(await c.query(`SELECT status FROM ${table} WHERE id=$1 FOR UPDATE`,[job.target_id])).rows[0];
    if(!run||!['pending','running'].includes(run.status))throw Object.assign(new Error('이미 종료된 작업의 결과는 중단할 수 없습니다'),{statusCode:409});
    await c.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE id=$1",[id]);
    await c.query(`UPDATE ${table} SET status='cancelled',finished_at=now() WHERE id=$1`,[job.target_id]);
    return {ok:true,status:'cancelled',changed:true};
  });
  if(result.changed)await audit(actor,'job.cancel',id);
  return result;
}
export async function createEvaluation(collectionId:string,selection?:{provider_id:string;model_id:string},actor='system',referenceRunId?:string){const collection=await one('SELECT * FROM collection_runs WHERE id=$1',[collectionId]);if(!['complete','partial'].includes(collection.status))throw new Error('완료·부분 수집 snapshot을 선택하세요');const count=await one('SELECT count(*) AS n FROM evidence WHERE collection_id=$1',[collectionId]);if(!Number(count.n))throw new Error('수집된 근거가 없습니다');const model=resolveModel(readConnections(),selection);const config=(await one('SELECT body FROM configurations WHERE id=$1',[collection.configuration_id])).body;const contract=evaluationContract(config);const parent=referenceRunId?await one('SELECT * FROM evaluation_runs WHERE id=$1',[referenceRunId]):null;if(parent&&(parent.collection_id!==collectionId||parent.configuration_id!==collection.configuration_id))throw new Error('재평가의 참조 실행은 같은 원본·설정이어야 합니다');const id=randomUUID();await transaction(async c=>{await c.query(`INSERT INTO evaluation_runs(id,collection_id,configuration_id,model,status,parent_run_id,corrections,summary) VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`,[id,collectionId,collection.configuration_id,model,parent?.id||null,JSON.stringify(parent?.corrections||[]),JSON.stringify({evaluation_contract:contract})]);await c.query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'evaluate',$2)`,[randomUUID(),id]);});await audit(actor,'evaluation.created',id,{model,reference_run_id:parent?.id||null});return id;}
export async function applyCorrection(runId:string,input:{type:string;target_id:string;after_value:any;reason:string;evidence_ids:string[]},actor:string){
  if(!['fact','attribution','interpretation'].includes(input.type)||!input.reason?.trim()||!input.target_id||!input.after_value||!Array.isArray(input.evidence_ids)||!input.evidence_ids.length)throw new Error('교정 유형·대상·변경 내용·이유·근거가 필요합니다');
  const run=await one('SELECT * FROM evaluation_runs WHERE id=$1',[runId]);if(!['review_required','finalized'].includes(run.status))throw new Error('평가 완료된 보고에서 교정하세요');
  const e=await one('SELECT * FROM evidence WHERE id=$1 AND collection_id=$2',[input.target_id,run.collection_id]);for(const id of input.evidence_ids)await one('SELECT id FROM evidence WHERE id=$1 AND collection_id=$2',[id,run.collection_id]);
  const t=(await one('SELECT body FROM configurations WHERE id=$1',[run.configuration_id])).body as TeamConfig;
  if(input.type==='attribution'&&(!Array.isArray(input.after_value.person_ids)||input.after_value.person_ids.some((id:string)=>!t.members.some(p=>p.person_id===id))))throw new Error('귀속 교정의 person_ids는 등록 팀원이어야 합니다');
  if(input.type!=='attribution'&&(typeof input.after_value.statement!=='string'||!input.after_value.statement.trim()))throw new Error('교정한 사실·해석 설명이 필요합니다');
  if(input.after_value.citations!==undefined){
    if(!Array.isArray(input.after_value.citations)||input.after_value.citations.length<1||input.after_value.citations.length>6)throw new Error('교정 인용은 1~6개 원문 구간이어야 합니다');
    for(const citation of input.after_value.citations){if(!input.evidence_ids.includes(citation.evidence_id)||typeof citation.quote!=='string'||citation.quote.trim().length<8||citation.quote.length>2000)throw new Error('교정 인용의 근거 ID와 8~2000자 원문이 필요합니다');const source=await one('SELECT body FROM evidence WHERE id=$1 AND collection_id=$2',[citation.evidence_id,run.collection_id]);if(!source.body.includes(citation.quote))throw new Error('교정 인용이 보존 원문과 일치하지 않습니다');}
  }
  const old=(await db.query('SELECT output FROM assessments WHERE evaluation_id=$1 AND evidence_id=$2',[runId,e.id])).rows[0]?.output||{actors:e.actors};
  const correctionId=randomUUID(),newRun=randomUUID();const correction={id:correctionId,...input,before_value:old,actor};const corrections=[...run.corrections,correction];
  let duplicate:any;await transaction(async c=>{await c.query('SELECT id FROM evaluation_runs WHERE id=$1 FOR UPDATE',[runId]);const previous=(await c.query('SELECT * FROM corrections WHERE evaluation_id=$1 LIMIT 1',[runId])).rows[0];if(previous){if(previous.type===input.type&&previous.target_id===input.target_id&&previous.reason===input.reason&&isDeepStrictEqual(previous.after_value,input.after_value)&&isDeepStrictEqual(previous.evidence_ids,input.evidence_ids)){duplicate=previous;return;}throw Object.assign(new Error('이 보고는 이미 교정되었습니다. 최신 교정 실행에서 이어서 수정하세요'),{statusCode:409});}await c.query(`INSERT INTO evaluation_runs(id,collection_id,configuration_id,model,status,parent_run_id,corrections,summary) VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`,[newRun,run.collection_id,run.configuration_id,run.model,runId,JSON.stringify(corrections),JSON.stringify({evaluation_contract:evaluationContract(t)})]);await c.query(`INSERT INTO corrections(id,evaluation_id,type,target_id,before_value,after_value,reason,evidence_ids,actor,successor_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[correctionId,runId,input.type,input.target_id,old,input.after_value,input.reason,JSON.stringify(input.evidence_ids),actor,newRun]);await c.query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'evaluate',$2)`,[randomUUID(),newRun]);});if(duplicate)return {correction_id:duplicate.id,evaluation_id:duplicate.successor_run_id,affected_people:t.members.map(p=>p.person_id)};await audit(actor,'correction.applied',correctionId,{original_run:runId,successor_run:newRun,affected_people:t.members.map(p=>p.person_id)});return {correction_id:correctionId,evaluation_id:newRun,affected_people:t.members.map(p=>p.person_id)};
}
export async function runJob(job:any,signal?:AbortSignal){
  signal?.throwIfAborted();
  if(job.kind==='collect'){const run=await one('SELECT * FROM collection_runs WHERE id=$1',[job.target_id]);const t=(await one('SELECT body FROM configurations WHERE id=$1',[run.configuration_id])).body as TeamConfig;await db.query(`UPDATE collection_runs SET status='running' WHERE id=$1`,[run.id]);await collectGithub(run.id,t,readConnections());if(signal?.aborted)throw new Error('수집 취소');await collectWiki(run.id,t,readConnections());const rows=(await db.query('SELECT status,count(*)::int AS count FROM inventory WHERE collection_id=$1 GROUP BY status',[run.id])).rows;const gaps=(await db.query(`SELECT source_id,object_key,details FROM inventory WHERE collection_id=$1 AND status IN ('partial','failed')`,[run.id])).rows;const summary={inventory:rows,gaps,unknown_population:gaps.some(g=>g.details.population_known===false),evidence_count:Number((await one('SELECT count(*) AS n FROM evidence WHERE collection_id=$1',[run.id])).n),notice:t.demo?.provenance_notice||null};await db.query(`UPDATE collection_runs SET status=$2,summary=$3,finished_at=now() WHERE id=$1`,[run.id,gaps.length?'partial':'complete',summary]);}
  else if(job.kind==='evaluate')await evaluate(job.target_id,signal);else throw new Error('알 수 없는 작업');
}
export async function claimJob(owner:string){return transaction(async c=>{const result=await c.query(`SELECT * FROM jobs WHERE status='pending' OR (status='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);const job=result.rows[0];if(!job)return null;if(job.status==='running'&&job.kind==='evaluate')await c.query("UPDATE ai_traces SET status='interrupted',error='worker lease expired; provider completion unknown' WHERE evaluation_id=$1 AND status='running'",[job.target_id]);await c.query(`UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1`,[job.id,owner]);return job;});}
export async function executeJob(job:any,owner:string,shutdownSignal?:AbortSignal){
  const controller=new AbortController();const signal=shutdownSignal?AbortSignal.any([controller.signal,shutdownSignal]):controller.signal;
  const heartbeat=setInterval(()=>{void db.query(`UPDATE jobs SET lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='running' RETURNING id`,[job.id,owner]).then(result=>{if(!result.rowCount)controller.abort();}).catch(()=>controller.abort());},10000);
  try{
    await runJob(job,signal);
    await transaction(async c=>{const owned=(await c.query("SELECT * FROM jobs WHERE id=$1 AND lease_owner=$2 AND status='running' FOR UPDATE",[job.id,owner])).rows[0];if(!owned)return;
      if(job.kind==='evaluate')await c.query("UPDATE ai_traces SET status='interrupted',error='uncommitted response after worker interruption' WHERE evaluation_id=$1 AND status='running'",[job.target_id]);
      await c.query("UPDATE jobs SET status='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
    });
  }catch(error){
    let restored=false;
    await transaction(async c=>{const owned=(await c.query('SELECT * FROM jobs WHERE id=$1 AND lease_owner=$2 FOR UPDATE',[job.id,owner])).rows[0];if(!owned||!['running','cancelled'].includes(owned.status))return;
      const table=job.kind==='collect'?'collection_runs':'evaluation_runs';
      if(shutdownSignal?.aborted&&owned.status==='running'){
        await c.query("UPDATE jobs SET status='pending',lease_owner=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1",[job.id]);
        await c.query(`UPDATE ${table} SET status='pending',summary=(summary-'error')||'{"worker_recovery":"worker stopped; validated results retained"}'::jsonb WHERE id=$1`,[job.target_id]);restored=true;
      }else{
        await c.query("UPDATE jobs SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,error=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,redact(error)]);
        await c.query(`UPDATE ${table} SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,summary=summary||$2::jsonb WHERE id=$1`,[job.target_id,JSON.stringify({error:redact(error)})]);
      }
      if(job.kind==='evaluate')await c.query("UPDATE ai_traces SET status='interrupted',error='worker stopped before response was committed' WHERE evaluation_id=$1 AND status='running'",[job.target_id]);
    });
    if(restored)await audit('worker','job.worker_stopped',job.id,{target_id:job.target_id,validated_results_retained:true});
  }finally{clearInterval(heartbeat);}
}
