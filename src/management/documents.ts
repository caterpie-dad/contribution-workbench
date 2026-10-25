import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtime} from '../config.js';
import {storeManagementSource,Source} from './context.js';
const exec=promisify(execFile);
export type DocumentMaterial={status:'document_diff'|'document_creation'|'change_unknown'|'no_content_change';source:Source|null;previous_id:string|null};
export async function documentDifference(previous:string,current:string,titleBefore:string,titleAfter:string,mode:'line'|'html_words'='line'){
  await fs.mkdir(path.join(runtime,'document-diffs'),{recursive:true});const folder=await fs.mkdtemp(path.join(runtime,'document-diffs','view-'));
  try{const before=path.join(folder,'before'),after=path.join(folder,'after');await fs.writeFile(before,previous,{mode:0o600});await fs.writeFile(after,current,{mode:0o600});let patch='';try{patch=(await exec('git',['diff','--no-index','--no-color','--text','--no-ext-diff','--no-textconv','--unified=5',...(mode==='html_words'?['--word-diff=porcelain','--word-diff-regex=[^<>[:space:]]+|<[^>]+>']:[]),'--',before,after],{cwd:folder,maxBuffer:128*1024*1024,timeout:30000})).stdout;}catch(error){const e=error as any;if(e.code!==1)throw error;patch=e.stdout;}
    const lines=patch.split('\n').filter(line=>!/^diff --git |^index |^--- |^\+\+\+ /.test(line));return (titleBefore!==titleAfter?'문서 제목 변경\n- '+titleBefore+'\n+ '+titleAfter+'\n':'')+lines.join('\n').trim();
  }finally{await fs.rm(folder,{recursive:true,force:true});}
}
export async function documentMaterials(run:any,evidence:any[],cases:any[]):Promise<Map<string,DocumentMaterial>>{
  const result=new Map<string,DocumentMaterial>();
  for(const row of evidence.filter(e=>['docs_page','wiki_page'].includes(e.kind)&&cases.some(c=>c.evidence_ids.includes(e.id)))){
    const previous=row.metadata.previous_revision?evidence.find(p=>p.source_id===row.source_id&&p.object_id===row.object_id&&p.revision===row.metadata.previous_revision):null;
    const linked=evidence.find(e=>e.kind==='commit'&&e.source_id===row.source_id&&e.revision===row.metadata.overlap_commit);const section=linked&&row.metadata.path?linked.body.split('diff --git ').find((text:string)=>text.startsWith('a/'+row.metadata.path+' b/'+row.metadata.path+'\n')):null;
    const creation=row.metadata.is_creation===true||!!section&&/^--- \/dev\/null$/m.test(section);
    if(!previous){result.set(row.id,{status:creation?'document_creation':'change_unknown',source:null,previous_id:null});continue;}
    const mode=row.kind==='wiki_page'?'html_words':'line';const body=await documentDifference(previous.body,row.body,previous.title,row.title,mode);if(!body){result.set(row.id,{status:'no_content_change',source:null,previous_id:previous.id});continue;}
    const repoId=cases.find(c=>c.evidence_ids.includes(row.id))!.repository_id;
    const source=await storeManagementSource(run,repoId,row.title+' · 변경 전후 비교',row.url,body,{anchor:row.revision,kind:'document_change_view',source_evidence_id:row.id,previous_evidence_id:previous.id,derived_from:[previous.id,row.id],derivation:mode==='html_words'?'git-word-diff-porcelain-v1':'git-no-index-unified-5-v1',context_only:false,authorship_scope:'recorded_revision_delta_not_entire_page',occurred_at:row.occurred_at});
    result.set(row.id,{status:'document_diff',source,previous_id:previous.id});
  }
  return result;
}
