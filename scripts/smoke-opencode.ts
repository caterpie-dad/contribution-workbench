import {readConnections,resolveModel} from '../src/config.js';
import {callOpenCode,stopOpenCode} from '../src/evaluation/opencode.js';
try{const response=await callOpenCode('Reply with status=ok and value=42. This is an installation smoke test.',{type:'object',properties:{status:{type:'string',enum:['ok']},value:{type:'integer'}},required:['status','value'],additionalProperties:false},resolveModel(readConnections()));console.log(JSON.stringify({output:response.output,sessionId:response.sessionId,model:response.observedModel,version:response.version}));}finally{await stopOpenCode();}
