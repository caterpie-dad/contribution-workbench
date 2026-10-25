import http from 'node:http';
import {Readable} from 'node:stream';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Connections,redact} from '../config.js';
export function enforceToolSchema(body:any,strict:boolean){const result=structuredClone(body);if(!strict)return result;for(const tool of result.tools||[]){if(tool.type!=='function')continue;if(tool.function){tool.function.strict=true;}else tool.strict=true;}return result;}
export async function createGateway(llm:Connections['systems']['opencode']['llm'],modelId:string,options:{reasoning_effort?:string|null;max_output_tokens?:number|null}={}){
  const token=randomBytes(32).toString('hex');const expected=Buffer.from('Bearer '+token);let requests=0;let quotaExhausted=false;
  const server=http.createServer(async(req,res)=>{
    const provided=Buffer.from(req.headers.authorization||'');if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){res.writeHead(401);res.end();return;}
    if(quotaExhausted){res.writeHead(402,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{type:'insufficient_quota',code:'credit_balance_exhausted',message:'API_QUOTA_EXHAUSTED: restore project quota and restart the evaluation worker.'}}));return;}
    const suffix=req.url?.replace(/^\/v1/,'');if(req.method!=='POST'||!['/responses','/chat/completions'].includes(suffix||'')){res.writeHead(404);res.end();return;}
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)throw new Error('LLM 요청 크기 초과');chunks.push(chunk);}const original=JSON.parse(Buffer.concat(chunks).toString());if(original.model!==modelId)throw new Error('LLM 요청 모델이 실행의 확정 모델과 다릅니다');
      const strict=llm.strict_tools??(llm.provider_id==='openai');const body=enforceToolSchema(original,strict);if(llm.protocol==='responses')body.store=false;
      if(options.reasoning_effort){if(llm.protocol==='responses')body.reasoning={...body.reasoning,effort:options.reasoning_effort};else body.reasoning_effort=options.reasoning_effort;}
      if(options.max_output_tokens){if(llm.protocol==='responses')body.max_output_tokens=options.max_output_tokens;else{delete body.max_tokens;body.max_completion_tokens=options.max_output_tokens;}}
      const response=await fetch(llm.url.replace(/\/$/,'')+suffix,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+llm.token},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(240000)]),redirect:'error'});requests++;
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json',...(response.headers.get('x-request-id')?{'X-Request-Id':response.headers.get('x-request-id')!}:{})});
      if(!response.ok){const errorBody=await response.text();if(/insufficient_quota|credit_balance_exhausted/.test(errorBody))quotaExhausted=true;res.end(redact(errorBody));return;}if(response.body){const stream=Readable.fromWeb(response.body as any);let sse='';stream.on('data',chunk=>{if(!(response.headers.get('content-type')||'').includes('text/event-stream'))return;sse+=chunk.toString();let end:number;while((end=sse.indexOf('\n\n'))>=0){const event=sse.slice(0,end);sse=sse.slice(end+2);const data=event.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');try{const value=JSON.parse(data);if(value.type==='error'&&['insufficient_quota','credit_balance_exhausted'].includes(value.error?.code||value.code||value.error?.type))quotaExhausted=true;}catch{}}if(sse.length>1024*1024)sse='';});stream.on('error',()=>res.destroy());stream.pipe(res);}else res.end();
    }catch(error){if(res.destroyed||res.writableEnded)return;if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:redact(error),type:'gateway_error'}}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address() as any;
  return {server,url:`http://127.0.0.1:${address.port}/v1`,token,get requests(){return requests;}};
}
