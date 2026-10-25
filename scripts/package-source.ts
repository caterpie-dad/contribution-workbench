import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root,readConnections} from '../src/config.js';

const c=readConnections(),config=c.systems;
const secrets=[config.github.auth.token,config.confluence.auth.token,config.opencode.llm.token,config.opencode.server_auth.token,config.opencode.server_auth.password,c.application.admin_password,c.application.session_secret].filter((value):value is string=>!!value&&value.length>=8);
const excluded=new Set(['.git','node_modules','runtime','dist','coverage','test-results','playwright-report']);
const output=path.join(root,'runtime/release');await fs.mkdir(output,{recursive:true});
const staging=await fs.mkdtemp(path.join(output,'source-'));const folder=path.join(staging,'contribution-workbench');await fs.mkdir(folder);
const manifest:{path:string;sha256:string;bytes:number}[]=[];
try{
  async function copy(relative=''){
    for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      if(!relative&&excluded.has(item.name))continue;
      const filename=path.posix.join(relative,item.name);
      if(/^config\/.*\.local\.json(?:\..*)?$/i.test(filename)||item.name.endsWith('.tsbuildinfo'))continue;
      if(item.isSymbolicLink())throw new Error('배포에 심볼릭 링크가 있습니다: '+filename);
      if(item.isDirectory()){await fs.mkdir(path.join(folder,filename));await copy(filename);continue;}
      if(!item.isFile())continue;
      const bytes=await fs.readFile(path.join(root,filename));if(secrets.some(secret=>bytes.includes(Buffer.from(secret))))throw new Error('배포 파일에 실제 인증 정보가 포함됐습니다: '+filename);
      await fs.copyFile(path.join(root,filename),path.join(folder,filename));manifest.push({path:filename,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
    }
  }
  await copy();manifest.sort((a,b)=>a.path.localeCompare(b.path));const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  await fs.writeFile(path.join(folder,'release-manifest.json'),JSON.stringify({version:pkg.version,notice:'Source package excludes local settings, API tokens, evidence, databases, runtime, dependencies, and build artifacts. Install dependencies and initialize local configuration in the target environment.',files:manifest},null,2));
  const archive=path.join(output,`contribution-workbench-${pkg.version}-source.tar.gz`);
  await promisify(execFile)('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',archive,'-C',staging,'contribution-workbench']);
  const bytes=await fs.readFile(archive);const result={archive:path.relative(root,archive),sha256:createHash('sha256').update(bytes).digest('hex'),files:manifest.length,bytes:bytes.length,secrets_checked:true};await fs.writeFile(archive+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await fs.rm(staging,{recursive:true,force:true});}
