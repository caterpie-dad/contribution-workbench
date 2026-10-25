import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {db} from '../src/db.js';
import {readConnections,root,redact} from '../src/config.js';
const exec=promisify(execFile),npm=process.env.npm_execpath;
if(!npm)throw new Error('npm run verify:release로 실행하세요');
await fs.mkdir(path.join(root,'runtime/verification'),{recursive:true});
const destination=await fs.mkdtemp(path.join(root,'runtime/release-check-'));
const database='contribution_release_'+process.pid+'_'+Date.now();let created=false;
const report:any={started_at:new Date().toISOString(),steps:[],directory:path.relative(root,destination),notice:'Fresh source extraction, dependency install and local corporate-contract tests; no real corporate endpoints or external LLM calls.'};
async function step(name:string,cwd:string,command:string,args:string[],env=process.env){
  try{const result=await exec(command,args,{cwd,env,maxBuffer:4*1024*1024,timeout:300000});await fs.writeFile(path.join(destination,name+'.log'),result.stdout+'\n'+result.stderr,{mode:0o600});report.steps.push({name,passed:true});}
  catch(error){const e=error as any;await fs.writeFile(path.join(destination,name+'.log'),String(e.stdout||'')+'\n'+redact(e.stderr||error),{mode:0o600});report.steps.push({name,passed:false});throw new Error('Release check failed: '+name);}
}
try{
  await step('package',root,process.execPath,[npm,'run','package:source']);
  const metadata=JSON.parse(await fs.readFile('runtime/release/contribution-workbench-0.1.0-source.tar.gz.json','utf8'));
  await step('extract',root,'tar',['-xzf',metadata.archive,'-C',destination]);
  const project=path.join(destination,'contribution-workbench');
  const manifest=JSON.parse(await fs.readFile(path.join(project,'release-manifest.json'),'utf8'));
  for(const file of manifest.files){const bytes=await fs.readFile(path.join(project,file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Source manifest mismatch');if(/\.local\.json/.test(file.path)||/^(runtime|node_modules)\//.test(file.path))throw new Error('Private/runtime file in source package');}
  report.manifest={files:manifest.files.length,all_hashes_match:true,local_settings_excluded:true};
  await step('install',project,process.execPath,[npm,'ci','--no-audit','--no-fund']);
  await step('initialize',project,process.execPath,['--import','tsx','scripts/init.ts']);
  const local=path.join(project,'config/connections.local.json');const settings=JSON.parse(await fs.readFile(local,'utf8'));
  const uri=new URL(process.env.DATABASE_URL||readConnections().application.database_url);uri.pathname='/'+database;
  await db.query('CREATE DATABASE "'+database+'"');created=true;
  settings.application.database_url=uri.href;settings.systems.opencode.llm.token='release-fixture-only-token';
  await fs.writeFile(local,JSON.stringify(settings,null,2),{mode:0o600});
  await step('build',project,process.execPath,[npm,'run','build']);
  const isolated:NodeJS.ProcessEnv={...process.env,DATABASE_URL:uri.href,HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',http_proxy:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9',NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};delete isolated.CONTRIB_CONNECTIONS_FILE;
  await step('contracts',project,process.execPath,[npm,'test'],isolated);
  const version=(await exec(path.join(project,'node_modules/.bin/opencode'),['--version'],{cwd:project})).stdout.trim();
  if(version!=='1.19.4')throw new Error('Installed OpenCode version mismatch');
  report.opencode_version=version;report.node_version=process.version;report.archive_sha256=metadata.sha256;report.passed=true;
}catch(error){report.passed=false;report.error=redact(error);process.exitCode=1;}
finally{if(created)await db.query('DROP DATABASE "'+database+'" WITH (FORCE)');await db.end();report.finished_at=new Date().toISOString();await fs.writeFile('runtime/verification/release-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
