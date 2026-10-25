import path from 'node:path';
import {execFile} from 'node:child_process';
import {db,one} from '../db.js';
import {TeamConfig,hash,root} from '../config.js';
import {git} from '../collectors/github.js';
import {saveRaw} from '../storage.js';

export type Source={id:string;title:string;url:string;body:string;raw_hash?:string;metadata?:any};
const sourceFile=/\.(py|ts|tsx|js|jsx|go|rs|java|kt|cs|c|cpp|h|hpp|rb|php|swift|scala|sql|proto|graphql|vue|svelte)$/i;
const excluded=/(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.venv|venv|__pycache__)(\/|$)/;
async function source(run:any,repositoryId:string,title:string,url:string,body:string,metadata:any):Promise<Source>{
  const raw=await saveRaw(body),id=hash(['management-context-v1',run.collection_id,repositoryId,title,metadata.anchor,raw]);
  await db.query('INSERT INTO management_sources(id,collection_id,repository_id,title,url,raw_hash,body,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[id,run.collection_id,repositoryId,title,url,raw,body,metadata]);
  return {id,title,url,body,raw_hash:raw,metadata};
}
export {source as storeManagementSource};
// Git objects are read as data. No code from the target repository is executed.
async function blobs(dir:string,ids:string[]):Promise<Buffer[]>{
  if(!ids.length)return [];
  const output=await new Promise<Buffer>((resolve,reject)=>{const child=execFile('git',['--git-dir='+dir,'cat-file','--batch'],{encoding:'buffer',maxBuffer:128*1024*1024,timeout:120000},(error,stdout)=>error?reject(error):resolve(stdout));child.stdin!.end(ids.join('\n')+'\n');});
  let cursor=0;return ids.map(()=>{const end=output.indexOf(10,cursor),header=output.subarray(cursor,end).toString(),size=Number(header.split(' ')[2]);if(!Number.isSafeInteger(size))throw new Error('Git blob batch response mismatch');cursor=end+1;const body=output.subarray(cursor,cursor+size);cursor+=size+1;return body;});
}
export async function prepareRepository(run:any,t:TeamConfig,repositoryId:string,evidence:any[]){
  const existing=(await db.query('SELECT output FROM management_snapshots WHERE evaluation_id=$1 AND repository_id=$2',[run.id,repositoryId])).rows[0];
  if(existing){const docs=(await db.query('SELECT * FROM management_sources WHERE id=ANY($1::text[])',[existing.output.source_ids])).rows;return {...existing.output,sources:existing.output.source_ids.map((id:string)=>docs.find(d=>d.id===id))};}
  const repo=t.repositories.find(r=>r.repository_id===repositoryId)!;
  const inventory=await one("SELECT details FROM inventory WHERE collection_id=$1 AND source_id=$2 AND object_key='git-ref-inventory' AND kind='population'",[run.collection_id,repositoryId]);
  const anchor=inventory.details.context_anchor;const dir=path.resolve(root,repo.mirror_path||evidence.find(e=>e.source_id===repositoryId&&e.metadata?.mirror_path)?.metadata.mirror_path||'');
  if(!anchor||dir===root)throw new Error('고정된 Git 맥락과 mirror가 필요합니다: '+repositoryId);
  const baseline=(await git(dir,['log',anchor,'--format=%H%x00%cI'])).trim().split('\n').find(line=>Date.parse(line.split('\0')[1])<Date.parse(t.period.start_inclusive))?.split('\0')[0]||null;
  const sources:Source[]=[],limitations:string[]=[];
  const entries=(await git(dir,['ls-tree','-rlz',anchor])).split('\0').filter(Boolean).map(line=>{const match=line.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/);return match?{mode:match[1],sha:match[2],bytes:Number(match[3]),path:match[4]}:null;}).filter((x):x is NonNullable<typeof x>=>!!x);
  const tree=entries.map(e=>`${e.path}\t${e.sha}\t${e.bytes}`).join('\n');
  sources.push(await source(run,repositoryId,'기간 말 파일 구조',repo.url+'/tree/'+anchor,tree,{anchor,baseline,context_only:true,kind:'repository_tree',rule:'git-ls-tree-all-blobs-v1'}));
  const selected=entries.filter(e=>sourceFile.test(e.path)&&!excluded.test(e.path)&&!e.mode.startsWith('120'));
  const eligible=selected.filter(e=>e.bytes<=2*1024*1024);for(const item of selected.filter(e=>!eligible.includes(e)))limitations.push('정적 인터페이스 분석 파일 크기 제한: '+item.path+' '+item.sha);
  const index:string[]=[];const blobSources:Record<string,{sha:string;raw_hash:string}>={};
  for(let start=0;start<eligible.length;start+=40){const batch=eligible.slice(start,start+40),contents=await blobs(dir,batch.map(e=>e.sha));for(let i=0;i<batch.length;i++){const file=batch[i],body=contents[i].toString('utf8');const raw=await saveRaw(contents[i]);blobSources[file.path]={sha:file.sha,raw_hash:raw};index.push('FILE '+file.path+' BLOB '+file.sha+' RAW '+raw);body.split('\n').forEach((line,n)=>{if(/^\s*(?:export\s+)?(?:async\s+)?(?:def |class |function |interface |type |struct |enum |trait |impl |pub |fn |func |package |import |from |(?:public|private|protected)\s)/.test(line))index.push(`${file.path}:${n+1}: ${line}`);});}}
  const indexBody=index.join('\n');for(let start=0,i=0;start<indexBody.length;start+=24000,i++)sources.push(await source(run,repositoryId,'소스 구조·인터페이스 '+(i+1),repo.url+'/tree/'+anchor,indexBody.slice(start,start+24000),{anchor,baseline,context_only:true,kind:'static_interface_index',rule:'source-interface-lines-v1',scope:'all matching source files, excluding declared generated/vendor paths; symbol index is architectural context, not full behavioral analysis'}));
  for(const contextPath of repo.context_paths){try{const body=await git(dir,['show',anchor+':'+contextPath]);for(let start=0,i=0;start<body.length;start+=24000,i++)sources.push(await source(run,repositoryId,contextPath+(body.length>24000?' · '+(i+1):''),repo.url+'/blob/'+anchor+'/'+contextPath,body.slice(start,start+24000),{anchor,baseline,context_only:true,kind:'repository_requirements',path:contextPath}));}catch{limitations.push('기간 말 등록 맥락 없음: '+contextPath);}}
  // Repository-specific wiki roots (or explicit repo URLs in a page) also
  // supply requirements context. Selecting versions and linking sources is
  // deterministic; the LLM does not choose which pages to collect.
  const membershipRows=(await db.query("SELECT details FROM inventory WHERE collection_id=$1 AND kind='root_membership'",[run.collection_id])).rows;
  const wiki=evidence.filter(e=>e.source_id===t.sources.confluence.source_id&&['wiki_page','wiki_context'].includes(e.kind)&&! /^(comments|attachments):/.test(e.object_id)&&e.occurred_at!==null&&e.occurred_at!==undefined&&Number.isFinite(new Date(e.occurred_at).getTime())&&new Date(e.occurred_at).getTime()<Date.parse(t.period.end_exclusive));
  const linkedWiki=wiki.filter(e=>{const pageId=e.metadata.page_id||e.object_id;const roots=membershipRows.filter(r=>r.details.page_id===pageId).map(r=>r.details.root);if(e.metadata.root)roots.push(e.metadata.root);return t.sources.confluence.roots.some(r=>roots.includes(r.root_id)&&r.repository_ids?.includes(repositoryId))||e.body.includes(repo.url);});
  let wikiObjects=0;for(const objectId of [...new Set(linkedWiki.map(e=>e.object_id))]){const versions=linkedWiki.filter(e=>e.object_id===objectId).sort((a,b)=>new Date(a.occurred_at).getTime()-new Date(b.occurred_at).getTime());const before=versions.filter(e=>new Date(e.occurred_at).getTime()<Date.parse(t.period.start_inclusive)).at(-1);const latest=versions.at(-1);wikiObjects++;for(const e of [before,latest].filter((e,i,all)=>e&&all.indexOf(e)===i)){for(let start=0,i=0;start<e.body.length;start+=24000,i++)sources.push(await source(run,repositoryId,'Confluence '+e.title+' @'+e.revision+(e.body.length>24000?' · '+(i+1):''),e.url,e.body.slice(start,start+24000),{anchor,source_revision:e.revision,source_evidence_id:e.id,occurred_at:e.occurred_at,context_only:true,not_personal_credit:true,kind:'wiki_system_context',temporal_scope:e===before?'latest_known_version_before_period':'latest_known_version_before_period_end',notice:'Source version context, not proof of sole authorship or goal attainment.'}));}}
  // First-parent merge patches remain integration evidence. Exact non-merge patch
  // equality can collapse branch copies without inferring intellectual ownership.
  const commits=evidence.filter(e=>e.source_id===repositoryId&&e.kind==='commit');const delivery:Record<string,any>={};
  for(const e of commits){let inDefault=false;try{await git(dir,['merge-base','--is-ancestor',e.revision,anchor]);inDefault=true;}catch{}const material=e.body.slice(e.body.indexOf('diff --git'));const patchFingerprint=material.includes('diff --git')?hash(material.replace(/^index .+$/gm,'').replace(/^@@[^@]*@@/gm,'@@')):null;delivery[e.id]={in_period_end_default_branch:inDefault,patch_fingerprint:e.metadata.merge?null:patchFingerprint,merge:e.metadata.merge===true,commit_sha:e.revision};}
  const output={version:'repository-context-v1',repository_id:repositoryId,url:repo.url,anchor,baseline,blob_sources:blobSources,source_ids:sources.map(s=>s.id),manifest_hash:hash(entries),file_population:entries.length,indexed_source_files:eligible.length,wiki_context_objects:wikiObjects,source_scope:{extensions:sourceFile.source,excluded_paths:excluded.source,max_blob_bytes:2097152},limitations,delivery};
  await db.query('INSERT INTO management_snapshots(evaluation_id,repository_id,output) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[run.id,repositoryId,output]);
  return {...output,sources};
}
