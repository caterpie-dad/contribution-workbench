import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TeamConfig,Connections,runtime,hash,root} from '../config.js';
import {storeEvidence,inventory,gap,paginate,request,authHeaders} from './common.js';
import {db} from '../db.js';
const exec=promisify(execFile);
export async function git(dir:string,args:string[]){return (await exec('git',['--git-dir='+dir,...args],{maxBuffer:128*1024*1024,timeout:120000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout;}
export async function mirror(repo:TeamConfig['repositories'][number],c:Connections){
  if(new URL(repo.url).origin!==new URL(c.systems.github.url).origin)throw new Error('레포 URL과 GitHub 연결 호스트가 다릅니다');
  const dir=repo.mirror_path?path.resolve(root,repo.mirror_path):path.join(runtime,'repos',hash(repo.url).slice(0,16)+'.git');
  await fs.mkdir(path.dirname(dir),{recursive:true});
  const askpass=path.join(runtime,'git-askpass.sh');await fs.writeFile(askpass,'#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *) printf "%s\\n" "$CONTRIB_GIT_TOKEN";; esac\n',{mode:0o700});
  const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:askpass,CONTRIB_GIT_TOKEN:c.systems.github.auth.token||''};
  const exists=await fs.access(path.join(dir,'HEAD')).then(()=>true,()=>false);
  if(exists){const remotes=(await exec('git',['--git-dir='+dir,'remote'],{env})).stdout.trim();if(remotes)await exec('git',['--git-dir='+dir,'remote','update','--prune'],{env,timeout:120000,maxBuffer:1e7});}else await exec('git',['clone','--mirror',repo.url,dir],{env,timeout:180000,maxBuffer:1e7});
  return dir;
}
export function commitActors(author:string,message:string){return [...new Set([author,...Array.from(message.matchAll(/^Co-authored-by:\s*.*?<([^>]+)>/gim),x=>x[1])].map(x=>x.toLowerCase()))];}
export async function collectGithub(run:string,t:TeamConfig,c:Connections){
  const seen=new Set<string>();
  for(const repo of t.repositories){if(seen.has(repo.url))continue;seen.add(repo.url);const source=repo.repository_id;
    try{
      const dir=await mirror(repo,c);const previous=(await db.query("SELECT details FROM inventory WHERE collection_id=$1 AND source_id=$2 AND object_key='git-ref-inventory' AND kind='population'",[run,source])).rows[0]?.details;
      const head=previous?.head||(await git(dir,['rev-parse','HEAD'])).trim();const scope=t.sources.github.ref_scope;
      const prefixes=[...(scope.includes('all_visible_branch_heads')?['refs/heads']:[]),...(scope.includes('pull_request_heads')?['refs/pull']:[])];
      const refs=previous?.refs??(prefixes.length?(await git(dir,['for-each-ref','--format=%(refname) %(objectname)',...prefixes])).trim():'');
      const selectedRefs=[...new Set([...(scope.includes('default_branch')?[head]:[]),...refs.split('\n').filter(Boolean).map((x:string)=>x.split(' ')[1])])];
      const allMetadata=(await git(dir,['log',...selectedRefs,'--format=%H%x00%cI'])).trim().split('\n').filter(Boolean);
      const commits=allMetadata.filter(line=>{const date=Date.parse(line.split('\0')[1]);return date>=Date.parse(t.period.start_inclusive)&&date<Date.parse(t.period.end_exclusive);}).map(line=>line.split('\0')[0]);
      const contextAnchor=previous?.context_anchor||(await git(dir,['log',head,'--format=%H%x00%cI'])).trim().split('\n').find(line=>Date.parse(line.split('\0')[1])<Date.parse(t.period.end_exclusive))?.split('\0')[0];
      if(!contextAnchor)throw new Error('평가 시점 이전의 맥락 snapshot이 없습니다');
      await inventory(run,source,'git-ref-inventory','population','complete',{head,refs,selected_refs:selectedRefs,context_anchor:contextAnchor,commits:commits.length,period:t.period,population_known:true,notice:'전체 선택 ref의 commit metadata를 열거 후 [start,end) committer-date로 필터링; 시계 역전에도 graph pruning 없음'});
      for(const sha of [...new Set(commits)]){
        await inventory(run,source,sha,'commit','pending');
        try{const meta=(await git(dir,['show','-s','--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B',sha])).split('\0');
          const [revision,parents,author,email,date,committed,message]=meta;
          if(Date.parse(committed)<Date.parse(t.period.start_inclusive)||Date.parse(committed)>=Date.parse(t.period.end_exclusive)){await inventory(run,source,sha,'commit','excluded',{reason:'outside_committer_time'});continue;}
          const patch=await git(dir,['show','--format=fuller','--find-renames','--no-ext-diff','--root','--first-parent',sha]);
          const files=(await git(dir,['diff-tree','--no-commit-id','--name-only','-r','--root',sha])).trim().split('\n').filter(Boolean);
          let verifiedLogin:string|null=null,identityRaw:string|null=null;
          if(t.demo?.github_api!==false){try{const identity=await request(githubEndpoint(repo,c)+'/commits/'+sha,{...authHeaders(c.systems.github.auth),'User-Agent':'contribution-workbench'});verifiedLogin=identity.body.author?.login||null;identityRaw=identity.rawHash;}catch(error){await gap(run,source,'identity:'+sha,error,true);}}
          const id=await storeEvidence(run,{source_id:source,object_id:sha,revision,kind:'commit',title:message.trim().split('\n')[0],url:repo.url+'/commit/'+sha,occurred_at:committed,actors:commitActors(email,message),body:patch,metadata:{repository_id:source,mirror_path:path.relative(root,dir),parents:parents.split(' ').filter(Boolean),author_name:author,author_email:email,author_github_login:verifiedLogin,identity_raw_hash:identityRaw,authored_at:date,committed_at:committed,files,merge:parents.split(' ').length>1}});
          await inventory(run,source,sha,'commit','complete',{evidence_id:id});
        }catch(e){await inventory(run,source,sha,'commit','failed',{reason:String(e)});}
      }
      for(const contextPath of repo.context_paths){try{const body=await git(dir,['show',contextAnchor+':'+contextPath]);await storeEvidence(run,{source_id:source,object_id:contextPath,revision:contextAnchor,kind:'context',title:contextPath,url:repo.url+'/blob/'+contextAnchor+'/'+contextPath,occurred_at:null,actors:[],body,metadata:{context_only:true,repository_id:source,as_of_period_end:true}});}catch{await gap(run,source,'context:'+contextPath,'등록된 맥락 문서를 해당 snapshot에서 읽을 수 없음',true);}}
      if(t.demo?.docs_surrogate)await collectDocs(run,t,repo,dir,contextAnchor);
      if(t.demo?.github_api===false){await gap(run,source,'github-api','명시적으로 Git 전용 범위를 선택함: PR·리뷰·CI는 미수집');}else await collectApi(run,t,c,repo);
    }catch(e){await gap(run,source,'repository',e);}
  }
}
async function collectDocs(run:string,t:TeamConfig,repo:TeamConfig['repositories'][number],dir:string,head:string){
  const roots=repo.docs_paths||['docs'];if(!roots.length){await inventory(run,repo.repository_id,'docs-tree','population','excluded',{population_known:true,reason:'configured_empty_docs_scope'});return;}const paths=(await git(dir,['ls-tree','-r','--name-only',head,...roots])).trim().split('\n').filter(x=>/\.(md|mdx|rst|txt)$/i.test(x));
  await inventory(run,repo.repository_id,'docs-tree','population','complete',{head,roots,pages:paths.length,population_known:true,surrogate:true});
  for(const file of paths){
    const versions=(await git(dir,['log','--format=%H','--since='+t.period.start_inclusive,'--until='+t.period.end_exclusive,head,'--',file])).trim().split('\n').filter(Boolean);
    const before=(await git(dir,['log','-1','--format=%H','--before='+t.period.start_inclusive,head,'--',file])).trim();
    const parents:Record<string,string>={};for(const sha of versions){try{parents[sha]=(await git(dir,['rev-parse',sha+'^'])).trim();}catch{}}
    for(const sha of [...new Set([...versions,...Object.values(parents),...(before?[before]:[]),head])]){
      try{const body=await git(dir,['show',sha+':'+file]);const [email,date]=(await git(dir,['show','-s','--format=%ae%x00%cI',sha])).trim().split('\0');
        const context=!versions.includes(sha);await storeEvidence(run,{source_id:repo.repository_id,object_id:'docs:'+file,revision:sha,kind:context?'docs_context':'docs_page',title:file,url:repo.url+'/blob/'+sha+'/'+file,occurred_at:date,actors:context?[]:[email.toLowerCase()],body,metadata:{surrogate:true,source_type:'docs_surrogate',repository_id:repo.repository_id,path:file,blob_sha:(await git(dir,['rev-parse',sha+':'+file])).trim(),context_only:context,previous_revision:parents[sha]||null,overlap_commit:versions.includes(sha)?sha:null,membership:'period_end_tree_plus_git_history',authorship_scope:context?'context':'revision_editor_not_entire_document_author'}});
      }catch(e){await gap(run,repo.repository_id,'docs:'+file+'@'+sha,e,true);}
    }
  }
}
async function collectApi(run:string,t:TeamConfig,c:Connections,repo:TeamConfig['repositories'][number]){
  const base=c.systems.github.api_url||(c.systems.github.deployment==='cloud'?'https://api.github.com':c.systems.github.url.replace(/\/$/,'')+'/api/v3');
  const parsed=new URL(repo.url);if(parsed.origin!==new URL(c.systems.github.url).origin)throw new Error('레포 URL과 연결 시스템이 다릅니다');
  const sourcePath=new URL(c.systems.github.url).pathname.replace(/\/$/,'');if(sourcePath&&!parsed.pathname.startsWith(sourcePath+'/'))throw new Error('GitHub context path가 레포 URL과 다릅니다');const slug=parsed.pathname.slice(sourcePath.length).replace(/^\//,'').replace(/\.git$/,'');const headers:Record<string,string>={...authHeaders(c.systems.github.auth),'X-GitHub-Api-Version':'2022-11-28','User-Agent':'contribution-workbench'};
  const endpoint=base+'/repos/'+slug;
  try{
    await paginate(endpoint+'/pulls?state=all&sort=updated&direction=desc&per_page=100',headers,async(prs,rawHash)=>{
      if(!Array.isArray(prs))throw new Error('PR 목록 형식 오류');
      for(const pr of prs){if(Date.parse(pr.updated_at)<Date.parse(t.period.start_inclusive))continue;if(Date.parse(pr.created_at)>=Date.parse(t.period.end_exclusive))continue;
        await storeEvidence(run,{source_id:repo.repository_id,object_id:'pr:'+pr.number,revision:pr.updated_at,kind:'pull_request',title:pr.title,url:pr.html_url,occurred_at:pr.created_at,actors:[pr.user.login],body:JSON.stringify({title:pr.title,body:pr.body,state:pr.state,merged_at:pr.merged_at,base:pr.base.sha,head:pr.head.sha,merge_commit_sha:pr.merge_commit_sha},null,2),metadata:{repository_id:repo.repository_id,raw_response_hash:rawHash,head:pr.head.sha,base:pr.base.sha,author_login:pr.user.login,authorship_scope:'pr_owner_not_verified_body_editor',context_only:Date.parse(pr.created_at)<Date.parse(t.period.start_inclusive)||Date.parse(pr.updated_at)>=Date.parse(t.period.end_exclusive),historical_body_known:Date.parse(pr.updated_at)<Date.parse(t.period.end_exclusive)}});
        for(const [kind,url] of [['review',endpoint+'/pulls/'+pr.number+'/reviews'],['review_comment',endpoint+'/pulls/'+pr.number+'/comments'],['issue_comment',endpoint+'/issues/'+pr.number+'/comments'],['pr_file',endpoint+'/pulls/'+pr.number+'/files']] as const){
          try{await paginate(url+'?per_page=100',headers,async(items,raw)=>{if(!Array.isArray(items))throw new Error('PR 하위 목록 오류');for(const item of items){const date=item.submitted_at||item.created_at||pr.updated_at;const editedAfterEnd=!!item.updated_at&&Date.parse(item.updated_at)>=Date.parse(t.period.end_exclusive);const inPeriod=Date.parse(date)>=Date.parse(t.period.start_inclusive)&&Date.parse(date)<Date.parse(t.period.end_exclusive)&&!editedAfterEnd;await storeEvidence(run,{source_id:repo.repository_id,object_id:kind+':'+pr.number+':'+(item.id||item.filename),revision:item.updated_at||date,kind:inPeriod?kind:'context',title:kind+' #'+pr.number,url:item.html_url||pr.html_url,occurred_at:date,actors:item.user?[item.user.login]:[],body:JSON.stringify(item,null,2),metadata:{repository_id:repo.repository_id,pr_number:pr.number,raw_response_hash:raw,historical_body_known:item.updated_at?!editedAfterEnd:null,context_only:!inPeriod||kind==='pr_file',linked_commit:pr.merge_commit_sha}});if(editedAfterEnd&&Date.parse(date)<Date.parse(t.period.end_exclusive))await gap(run,repo.repository_id,'edited-body:'+kind+':'+item.id,'기간 뒤 편집된 현재 본문을 맥락으로 보존했으며 과거 본문은 미확인',true);}});}catch(e){await gap(run,repo.repository_id,kind+':'+pr.number,e);}
        }
        try{const checks=new Map<string,any>(),rawHashes:string[]=[];let expected=0;await paginate(endpoint+'/commits/'+pr.head.sha+'/check-runs?per_page=100',headers,async(body,raw)=>{if(!Array.isArray(body.check_runs))throw new Error('check-run 목록 형식 오류');expected=Math.max(expected,Number(body.total_count)||0);rawHashes.push(raw);for(const item of body.check_runs)checks.set(String(item.id??hash(item)),item);});await storeEvidence(run,{source_id:repo.repository_id,object_id:'checks:'+pr.number,revision:pr.head.sha,kind:'ci_context',title:'CI #'+pr.number,url:pr.html_url,occurred_at:pr.updated_at,actors:[],body:JSON.stringify({total_count:expected,check_runs:[...checks.values()]},null,2),metadata:{context_only:true,repository_id:repo.repository_id,pr_number:pr.number,head_sha:pr.head.sha,raw_response_hashes:rawHashes,scope:'observed_checks_at_pr_head_not_full_workflow_history'}});if(checks.size<expected)await gap(run,repo.repository_id,'checks-population:'+pr.number,'check-run total_count보다 수집 개수가 적음');}catch(e){await gap(run,repo.repository_id,'checks:'+pr.number,e);}
      }if(prs.length&&prs.every((pr:any)=>Date.parse(pr.updated_at)<Date.parse(t.period.start_inclusive)))return false;
    });await inventory(run,repo.repository_id,'pull-requests','population','complete',{population_known:true});
  }catch(e){await gap(run,repo.repository_id,'pull-requests',e);}
}
function githubEndpoint(repo:TeamConfig['repositories'][number],c:Connections){const base=c.systems.github.api_url||(c.systems.github.deployment==='cloud'?'https://api.github.com':c.systems.github.url.replace(/\/$/,'')+'/api/v3');const prefix=new URL(c.systems.github.url).pathname.replace(/\/$/,'');return base+'/repos/'+new URL(repo.url).pathname.slice(prefix.length).replace(/^\//,'').replace(/\.git$/,'');}
