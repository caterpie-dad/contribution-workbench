import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {connectionsFile,readConnections,validateConnections,safeConnections,hash,Connections} from './config.js';
import {transaction} from './db.js';

const url=z.string().url();
const optionalUrl=z.union([url,z.literal('')]).optional();
export const connectionEdits=z.object({
  github:z.object({url,deployment:z.enum(['cloud','enterprise_server']),api_url:optionalUrl}).strict(),
  confluence:z.object({url,deployment:z.enum(['cloud','data_center']),transport:z.enum(['rest','mcp']),mcp_url:optionalUrl}).strict(),
  opencode:z.object({server_url:url,manage_process:z.boolean(),transport:z.enum(['sdk','cli']),llm_url:url,protocol:z.enum(['responses','chat_completions'])}).strict()
}).strict();

// The database lock serializes app instances; revision checks also catch file edits.
// Write the original document so credentials and unedited MCP bindings survive.
export async function updateConnections(expectedRevision:string,change:(raw:any,current:Connections)=>void,options:{idle?:boolean}={}){
  if(typeof expectedRevision!=='string'||!expectedRevision)throw new Error('연결 설정 revision이 필요합니다');
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(82739106)');
    const current=readConnections();
    if(hash(current)!==expectedRevision)throw Object.assign(new Error('연결 설정이 변경되었습니다. 다시 불러온 뒤 저장하세요.'),{statusCode:409});
    if(options.idle&&(await client.query("SELECT 1 FROM jobs WHERE status IN ('pending','running') LIMIT 1")).rowCount)throw Object.assign(new Error('수집·평가 실행 중에는 연결 주소를 바꿀 수 없습니다. 작업 완료 또는 중단 후 저장하세요.'),{statusCode:409});
    const filename=connectionsFile(),raw=JSON.parse(fs.readFileSync(filename,'utf8'));
    change(raw,current);const validated=validateConnections(raw);
    const temp=filename+'.tmp-'+randomUUID();
    try{
      const fd=fs.openSync(temp,'wx',0o600);
      try{fs.writeFileSync(fd,JSON.stringify(raw,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(hash(readConnections())!==expectedRevision)throw Object.assign(new Error('저장 도중 연결 파일이 변경되었습니다. 다시 불러오세요.'),{statusCode:409});
      fs.renameSync(temp,filename);
      const dir=fs.openSync(path.dirname(filename),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    }finally{fs.rmSync(temp,{force:true});}
    return safeConnections(validated);
  });
}

export async function saveConnectionEdits(expectedRevision:string,raw:unknown){
  const result=connectionEdits.safeParse(raw);
  if(!result.success)throw new Error('연결 설정 입력을 확인하세요: '+result.error.issues.map(x=>x.path.join('.')).join(', '));
  const edits=result.data;
  return updateConnections(expectedRevision,document=>{
    const systems=document.systems;
    for(const key of ['github','confluence'] as const)Object.assign(systems[key],{url:edits[key].url,deployment:edits[key].deployment});
    if(edits.github.api_url)systems.github.api_url=edits.github.api_url;else delete systems.github.api_url;
    systems.confluence.transport=edits.confluence.transport;
    if(edits.confluence.mcp_url)systems.confluence.mcp={...systems.confluence.mcp,url:edits.confluence.mcp_url};else if(systems.confluence.mcp)delete systems.confluence.mcp.url;
    Object.assign(systems.opencode,{server_url:edits.opencode.server_url,manage_process:edits.opencode.manage_process,transport:edits.opencode.transport});
    Object.assign(systems.opencode.llm,{url:edits.opencode.llm_url,protocol:edits.opencode.protocol});
  },{idle:true});
}

export async function saveDefaultModel(expectedRevision:string,selection:{provider_id:string;model_id:string}){
  return updateConnections(expectedRevision,(raw,current)=>{
    const llm=current.systems.opencode.llm;
    const selected=llm.models.find(m=>(m.provider_id||llm.provider_id)===selection.provider_id&&m.model_id===selection.model_id&&m.enabled&&m.available!==false);
    if(!selected)throw new Error('OpenCode에서 불러온 사용 가능한 모델을 선택하세요');
    if(current.systems.opencode.manage_process&&selection.provider_id!==llm.provider_id)throw new Error('연결된 공급자의 모델을 선택하세요');
    for(const model of raw.systems.opencode.llm.models)model.provider_id=model.provider_id||llm.provider_id;
    raw.systems.opencode.llm.strict_tools=llm.strict_tools??(llm.provider_id==='openai');
    raw.systems.opencode.llm.provider_id=selection.provider_id;
    raw.systems.opencode.llm.default_model_id=selection.model_id;
  });
}
