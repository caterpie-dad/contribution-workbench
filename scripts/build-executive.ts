import fs from 'node:fs/promises';
import {db,one,migrate} from '../src/db.js';
import {aiCall} from '../src/evaluation/engine.js';
import {buildExecutiveBriefs} from '../src/management/executive.js';
import {stopOpenCode} from '../src/evaluation/opencode.js';
try{
  await migrate();const demo=JSON.parse(await fs.readFile('runtime/verification/demo-run.json','utf8'));
  const run=await one('SELECT * FROM evaluation_runs WHERE id=$1',[process.argv[2]||demo.evaluation_id]);
  const t=(await one('SELECT body FROM configurations WHERE id=$1',[run.configuration_id])).body;
  const evidence=(await db.query('SELECT * FROM evidence WHERE collection_id=$1',[run.collection_id])).rows;
  console.log('저장소·팀원 카드 분석 시작:',run.id,'모델:',run.model.model_id);
  await buildExecutiveBriefs(run,t,evidence,(stage,input,schema,validate)=>aiCall(run,stage,input,schema,undefined,validate));
  console.log('저장소·팀원 카드 분석 완료');
}catch(e){console.error((e as Error).message);process.exitCode=1;}finally{await stopOpenCode();await db.end();}
