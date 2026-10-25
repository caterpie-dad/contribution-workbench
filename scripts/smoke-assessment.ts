import {db} from '../src/db.js';
import {readConnections,resolveModel} from '../src/config.js';
import {readRaw} from '../src/storage.js';
import {unitSchema,citationSpans} from '../src/evaluation/schemas.js';
import {callOpenCode,stopOpenCode} from '../src/evaluation/opencode.js';
import {checkAssessments} from '../src/evaluation/validate.js';
try{const trace=(await db.query("SELECT * FROM ai_traces WHERE stage='evidence_assessment' ORDER BY created_at DESC LIMIT 1")).rows[0];const saved=JSON.parse((await readRaw(trace.input_ref)).toString());const input=saved.input||saved;input.units[0].citation_spans=citationSpans(input.units[0].body);input.instructions='Use citations with span_id from the source catalog. Do not return copied quote strings. Use exactly schema properties.';input.validation_feedback='';const response=await callOpenCode('한국어로 자료의 의도·난도·품질을 평가하고 인용 구간 ID를 제공하라. '+JSON.stringify(input),unitSchema(input.units[0]),resolveModel(readConnections()));const raw=(await db.query('SELECT id,body FROM evidence WHERE collection_id=(SELECT collection_id FROM evaluation_runs WHERE id=$1)',[trace.evaluation_id])).rows;const checked=checkAssessments(response.output,input.units,new Map(raw.map(x=>[x.id,x.body])));console.log('Actual evidence assessment validated',response.sessionId,JSON.stringify(checked));}finally{await stopOpenCode();await db.end();}
