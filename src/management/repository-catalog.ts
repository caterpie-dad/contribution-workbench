import path from 'node:path';
import {TeamConfig,root,hash} from '../config.js';
import {git} from '../collectors/github.js';
import {storeManagementSource,Source} from './context.js';

const excluded=/(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.venv|venv|__pycache__)(\/|$)/;
const implementation=/\.(py|ts|tsx|js|jsx|go|rs|java|kt|cs|c|cpp|h|hpp|rb|php|swift|scala|sql|proto|graphql|vue|svelte)$/i;
const manifest=/(^|\/)(pyproject\.toml|package\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|requirements[^/]*\.txt|Gemfile|composer\.json|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|[^/]+\.csproj)$/i;
const intro=/^(README(?:\.[^/]+)?|docs\/(index|introduction|features|architecture)(?:\.[^/]+)?)$/i;
const testPath=/(^|\/)(tests?|examples?|fixtures?|benchmarks?|scripts)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i;

function declaredDependencies(file:{path:string;body:string}):string[]{
  if(/(^|\/)package\.json$/i.test(file.path)){try{const p=JSON.parse(file.body);return ['dependencies','devDependencies','peerDependencies','optionalDependencies'].flatMap(k=>Object.keys(p[k]||{}));}catch{return [];}}
  if(/requirements[^/]*\.txt$/i.test(file.path))return file.body.split('\n').flatMap(line=>line.match(/^\s*([a-z][a-z0-9_.-]*)(?:\[|\s|[<>=!~]|$)/i)?.[1]||[]);
  if(!/pyproject\.toml$/i.test(file.path))return [];
  const names:string[]=[];let section='',collecting=false,depth=0;
  for(const line of file.body.split('\n')){
    const header=line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);if(header){section=header[1];collecting=false;depth=0;continue;}
    const key=line.match(/^\s*([\w.-]+)\s*=\s*(.*)/);
    const deps=section==='project'&&key?.[1]==='dependencies'||section==='build-system'&&key?.[1]==='requires'||section==='dependency-groups'||section==='project.optional-dependencies';
    if(section==='tool.poetry.dependencies'||section==='tool.poetry.dev-dependencies'){if(key&&key[1]!=='python')names.push(key[1]);continue;}
    if(!collecting&&!(key&&deps))continue;
    const data=collecting?line:key![2];collecting=true;
    let quote='',value='';for(const char of data){if(quote){if(char===quote){const m=value.match(/^([a-z][a-z0-9_.-]*)(?:\[|\s|[<>=!~;]|$)/i);if(m)names.push(m[1]);quote='';value='';}else value+=char;}else if(char==='"'||char==="'")quote=char;else if(char==='[')depth++;else if(char===']')depth--;else if(char==='#')break;}
    if(depth<=0)collecting=false;
  }
  return names;
}

export function technologyFacts(files:{path:string;body:string}[],paths:string[]){
  const counts=new Map<string,number>();
  const languages:Record<string,string>={py:'Python',ts:'TypeScript',tsx:'TypeScript',js:'JavaScript',jsx:'JavaScript',go:'Go',rs:'Rust',java:'Java',kt:'Kotlin',cs:'C#',rb:'Ruby',php:'PHP',swift:'Swift',scala:'Scala'};
  for(const p of paths.filter(p=>!excluded.test(p)&&!testPath.test(p))){const lang=languages[p.split('.').at(-1)||''];if(lang)counts.set(lang,(counts.get(lang)||0)+1);}
  const result=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name])=>({name,basis:'source_file_extensions'}));
  const known=['react','next','vue','svelte','fastify','express','django','flask','fastapi','starlette','httpcore','anyio','pytest','sqlalchemy','pydantic','sphinx','hatchling','flit_core','colorama'];
  for(const file of files.filter(f=>manifest.test(f.path)&&!testPath.test(f.path))){const deps=declaredDependencies(file).map(s=>s.toLowerCase());for(const name of known)if(deps.includes(name)&&!result.some(r=>r.name.toLowerCase()===name))result.push({name,basis:file.path});}
  return result;
}

// Every path is inventoried. Manifests, introductory docs and every application
// source file are selected by fixed rules, never by the LLM or commit volume.
// Input batches are handled upstream; no file is silently truncated.
export async function repositoryCatalog(run:any,t:TeamConfig,snapshot:any){
  const repo=t.repositories.find(r=>r.repository_id===snapshot.repository_id)!;
  const dir=path.resolve(root,repo.mirror_path||'runtime/repos/'+hash(repo.url).slice(0,16)+'.git');
  const entries=(await git(dir,['ls-tree','-rlz',snapshot.anchor])).split('\0').filter(Boolean).flatMap(line=>{const m=line.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/);return m?[{mode:m[1],sha:m[2],bytes:Number(m[3]),path:m[4]}]:[];});
  const paths=entries.map(e=>e.path),sources:Source[]=[],files:{path:string;body:string}[]=[],omissions:{path:string;reason:string}[]=[];
  for(const e of entries){
    if(excluded.test(e.path)||e.mode.startsWith('120'))continue;
    if(!manifest.test(e.path)&&!intro.test(e.path)&&!(implementation.test(e.path)&&!testPath.test(e.path)))continue;
    if(e.bytes>2*1024*1024){omissions.push({path:e.path,reason:'blob_over_2MiB'});continue;}
    const body=await git(dir,['show',snapshot.anchor+':'+e.path]);files.push({path:e.path,body});
    // Read-only data; cloned code is never executed.
    sources.push(await storeManagementSource(run,repo.repository_id,e.path,repo.url+'/blob/'+snapshot.anchor+'/'+e.path,body,{anchor:snapshot.anchor,path:e.path,blob:e.sha,context_only:true,not_personal_credit:true,kind:'repository_catalog_source'}));
  }
  return {sources,technical_facts:technologyFacts(files,paths),coverage:{anchor:snapshot.anchor,all_files:paths.length,analyzed_files:files.length,selected_paths:files.map(f=>f.path),omissions,selection_rule:'all manifests + introductory docs + all non-test application source; generated/vendor paths and symlinks excluded',manifest_hash:hash(entries)}};
}
