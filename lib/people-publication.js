'use strict';
const fs=require('node:fs'),path=require('node:path'),I=require('./person-input'),S=require('./learning/schema'),P=require('./learning/paths');
const REV=/^r-[a-f0-9]{32}$/;
function validateContext(c){S.keys(c,['schemaVersion','personId','letterboxdUser','revision','dataBase','addonPath','inputUpdatedAt','coverage']);if(c.schemaVersion!==1||c.personId!=='friend-a'||c.letterboxdUser!=='friend-a'||!REV.test(c.revision)||c.dataBase!=='./data/'||c.addonPath!=='/u/friend-a/manifest.json')throw Error('Invalid public person context');S.iso(c.inputUpdatedAt);S.keys(c.coverage,['history','likes','following','refresh'],['history','likes','following']);for(const [key,v] of Object.entries(c.coverage))if(!(key==='refresh'?['complete','partial','unavailable']:['export','public','mixed','unknown','unavailable','stale','complete']).includes(v))throw Error('Invalid coverage');return c;}
// Public provenance describes the retained inputs separately from the latest attempt.
function publicCoverage(history){
 const c=history.coverage, origins=new Set(['watched','ratings','watchlist','diary'].map(k=>c[k]?.source||'unknown'));
 const observations=['watched','ratings','watchlist','likes','diary'].map(k=>c[k]?.observation?.state).filter(Boolean);
 return {history:origins.size===1?[...origins][0]:'mixed',likes:c.likes.state==='unknown'?'unknown':c.likes.source,following:c.following?.state==='complete'?'public':'unavailable',...(observations.length?{refresh:observations.every(v=>v==='unavailable')?'unavailable':observations.length===5&&observations.every(v=>v==='complete')?'complete':'partial'}:{})};
}
function walk(dir){require('./people').noSymlinks(path.parse(path.resolve(dir)).root,path.resolve(dir));return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Symlink in release');const file=path.join(dir,e.name);if(e.isDirectory())return walk(file);if(!e.isFile())throw Error('Nonregular release file');return [file];});}
function allowed(rel){if(/^data\/page-/.test(rel))return false;return require('./learning/public').isPublicFile(rel)||/^posters\/tt\d+\.jpg$/.test(rel);}
function fileManifest(dir){let bytes=0;const files=walk(dir).map(f=>{const rel=path.relative(dir,f).split(path.sep).join('/');if(!allowed(rel))throw Error('Unexpected release file');const b=fs.readFileSync(f);bytes+=b.length;return {path:rel,bytes:b.length,sha256:I.sha(b)};}).filter(f=>!['files.json','publication.json'].includes(f.path)).sort((a,b)=>a.path.localeCompare(b.path));if(bytes>256*1024*1024||files.length>30000||Buffer.byteLength(I.canonical(files))>2*1024*1024)throw Error('Release exceeds bounds');return files;}
function stamp({dir,revision,codeSha,builtAt,history}){
 if(!REV.test(revision)||!/^[a-f0-9]{40}$/.test(codeSha))throw Error('Invalid release identity');
 const context=validateContext({schemaVersion:1,personId:'friend-a',letterboxdUser:'friend-a',revision,dataBase:'./data/',addonPath:'/u/friend-a/manifest.json',inputUpdatedAt:history.importedAt,coverage:publicCoverage(history)});
 fs.writeFileSync(path.join(dir,'data/person.json'),I.canonical(context));
 const files=Buffer.from(I.canonical(fileManifest(dir)));fs.writeFileSync(path.join(dir,'files.json'),files);
 const receipt={schemaVersion:1,personId:'friend-a',revision,codeSha,builtAt,filesSha256:I.sha(files),personContextSha256:I.sha(Buffer.from(I.canonical(context)))};
 fs.writeFileSync(path.join(dir,'publication.json'),I.canonical(receipt));verifyRelease(dir,{revision});return {revision,receiptSha256:I.sha(Buffer.from(I.canonical(receipt))),fileManifestSha256:I.sha(files),personContextSha256:receipt.personContextSha256};
}
function verifyRelease(dir,{revision,receiptSha256=null,fileManifestSha256=null,skipPublic=false}={}){
 if(!fs.existsSync(path.join(dir,'data/index.json')))throw Error('Missing person index');
 if(!fs.existsSync(path.join(dir,'data/engine.json')))throw Error('Missing person engine');
 const c=validateContext(JSON.parse(fs.readFileSync(path.join(dir,'data/person.json'),'utf8')));if(revision&&c.revision!==revision)throw Error('Release revision mismatch');revision=c.revision;
 const raw=fs.readFileSync(path.join(dir,'publication.json')),r=JSON.parse(raw);S.keys(r,['schemaVersion','personId','revision','codeSha','builtAt','filesSha256','personContextSha256']);
 if(r.schemaVersion!==1||r.personId!=='friend-a'||r.revision!==revision||!/^([a-f0-9]{40})$/.test(r.codeSha))throw Error('Receipt identity mismatch');S.iso(r.builtAt);
 const manifest=fs.readFileSync(path.join(dir,'files.json'));if(manifest.length>2*1024*1024||I.sha(manifest)!==r.filesSha256||(fileManifestSha256&&I.sha(manifest)!==fileManifestSha256)||(receiptSha256&&I.sha(raw)!==receiptSha256)||I.sha(fs.readFileSync(path.join(dir,'data/person.json')))!==r.personContextSha256)throw Error('Release receipt hash mismatch');
 if(I.canonical(JSON.parse(manifest))!==I.canonical(fileManifest(dir)))throw Error('Release file mismatch');
 const posterPrefix=`https://marcogusmao.github.io/mood-engine/u/friend-a/r/${revision}/posters/`;
 for(const file of walk(dir)){const rel=path.relative(dir,file);if(!rel.endsWith('.json'))continue;const obj=JSON.parse(fs.readFileSync(file,'utf8'));
  if(/^data\/index.*\.json$/.test(rel)&&(!obj.meta||obj.meta.personId!=='friend-a'||obj.meta.revision!==revision))throw Error('Index person/revision mismatch');
  if(rel==='data/engine.json'&&(!obj.meta||obj.meta.personId!=='friend-a'||obj.meta.revision!==revision))throw Error('Engine person/revision mismatch');
  const visit=x=>{if(typeof x==='string'&&/\/posters\/tt\d+\.jpg(?:\?v=[a-f0-9]{8})?$/.test(x)&&!x.startsWith(posterPrefix))throw Error('Cross-person poster URL');if(x&&typeof x==='object')Object.values(x).forEach(visit);};visit(obj);
 }
 const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));if(m.id!=='com.mgusmao.moodengine.friend-a'||m.types.some(t=>t!=='movie')||m.resources.some(t=>t!=='catalog')||m.catalogs.some(t=>t.type!=='movie'))throw Error('Will manifest must be film-only');
 if(!skipPublic)require('./learning/public').verifyPublic(dir);return {context:c,receipt:r};
}
function verifyAggregate(dir,{privacy=null}={}){
 require('./people').noSymlinks(path.parse(path.resolve(dir)).root,path.resolve(dir));
 const u=path.join(dir,'u');const entries=fs.readdirSync(dir).filter(e=>e!=='u');
 // Root validator cannot accept arbitrary nested owner paths; use an isolated root view.
 const tmp=fs.mkdtempSync(path.join(path.dirname(path.resolve(dir)),'.verify-root-'));
 try{for(const e of entries)fs.cpSync(path.join(dir,e),path.join(tmp,e),{recursive:true,dereference:false});require('./learning/public').verifyPublic(tmp,privacy);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
 if(!fs.existsSync(u))return true;
 if(fs.readdirSync(u).join(',')!=='friend-a')throw Error('Unknown aggregate person');
 const shell=path.join(u,'friend-a');for(const e of fs.readdirSync(shell))if(!['index.html','assets','r'].includes(e))throw Error('Unexpected stable shell file');
 for(const f of walk(shell)){const rel=path.relative(shell,f).split(path.sep).join('/');if(rel.startsWith('r/'))continue;if(!['index.html','assets/person.js','assets/upload.js','assets/feedback-core.js','assets/selector.js','assets/feedback.js'].includes(rel))throw Error('Unexpected shell asset');if(privacy)require('./learning/public').assertPrivateAbsent(fs.readFileSync(f,'utf8'),privacy);}
 const revisions=fs.existsSync(path.join(shell,'r'))?fs.readdirSync(path.join(shell,'r')):[];if(revisions.length>3)throw Error('Too many retained releases');
 for(const rev of revisions){if(!REV.test(rev))throw Error('Invalid release path');verifyRelease(path.join(shell,'r',rev),{revision:rev});if(privacy)require('./learning/public').verifyPublic(path.join(shell,'r',rev),privacy);}
 return true;
}
function compose({marcoDir,willDir=null,previous=[],outDir,webDir,apiOrigin=null,privacy=null}){
 if(apiOrigin && apiOrigin!=='https://mood-engine.mood-engine-worker.workers.dev')throw Error('Invalid configured Worker origin');
 require('./people').noSymlinks(path.parse(path.resolve(outDir)).root,path.resolve(outDir));
 P.validateDestination(outDir,path.resolve(__dirname,'..'),null,false);for(const src of [marcoDir,willDir,...previous.map(p=>p.dir)].filter(Boolean)){if(P.within(path.resolve(src),path.resolve(outDir))||P.within(path.resolve(outDir),path.resolve(src)))throw Error('Composition paths overlap');walk(src);}
 const stage=fs.mkdtempSync(path.resolve(outDir)+'.staging-');const backup=path.resolve(outDir)+'.previous';let moved=false;
 try{
 fs.cpSync(marcoDir,stage,{recursive:true});
 const shell=path.join(stage,'u/friend-a');fs.mkdirSync(path.join(shell,'assets'),{recursive:true});
 let html=fs.readFileSync(path.join(webDir,'index.html'),'utf8').replace('data-owner="mgusmao"','data-owner="friend-a"');
 // Fixed configuration only. No query or document-provided endpoint is trusted.
 html=html.replace(/\sdata-will-api-origin\s*=\s*(?:"[^"]*"|'[^']*')/gi,'').replace('<body','<body data-will-api-origin="'+(apiOrigin||'')+'"');fs.writeFileSync(path.join(shell,'index.html'),html);
 for(const name of ['person.js','upload.js','selector.js','feedback.js']){const f=path.join(webDir,name);if(!fs.existsSync(f))throw Error('Missing delivered web asset: '+name);fs.copyFileSync(f,path.join(shell,'assets',name));}
 fs.copyFileSync(path.join(__dirname,'learning/feedback.js'),path.join(shell,'assets/feedback-core.js'));
 for(const old of previous){verifyRelease(old.dir,old);const dest=path.join(shell,'r',old.revision);if(fs.existsSync(dest))throw Error('Duplicate retained release');fs.cpSync(old.dir,dest,{recursive:true});}
 if(willDir){const v=verifyRelease(willDir);const dest=path.join(shell,'r',v.context.revision);if(fs.existsSync(dest))throw Error('Immutable release collision');fs.cpSync(willDir,dest,{recursive:true});}
 verifyAggregate(stage,{privacy});if(fs.existsSync(outDir)){if(fs.existsSync(backup))throw Error('Previous composition pending');fs.renameSync(outDir,backup);moved=true;}
 try{fs.renameSync(stage,outDir);}catch(e){if(moved)fs.renameSync(backup,outDir);throw e;}if(moved)fs.rmSync(backup,{recursive:true,force:true});return outDir;
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
async function restorePublic({descriptor,dir,fetchBytes}){
 require('./people').noSymlinks(path.parse(path.resolve(dir)).root,path.resolve(dir));
 if(!REV.test(descriptor.revision))throw Error('Invalid retained revision');
 const manifest=await fetchBytes('files.json',2*1024*1024);if(I.sha(manifest)!==descriptor.fileManifestSha256)throw Error('Retained manifest hash mismatch');const files=JSON.parse(manifest);if(!Array.isArray(files)||files.length>30000)throw Error('Invalid retained manifest');
 const seen=new Set();let total=0;for(const f of files){S.keys(f,['path','bytes','sha256']);if(!allowed(f.path)||['publication.json','files.json'].includes(f.path)||f.path.includes('\\')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(f.path)||!Number.isInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid retained path');seen.add(f.path);total+=f.bytes;if(total>256*1024*1024)throw Error('Retained release too large');}
 if(fs.existsSync(dir))throw Error('Public restore requires fresh directory');fs.mkdirSync(dir,{recursive:true});try{for(const f of files){const b=await fetchBytes(f.path,f.bytes);if(b.length!==f.bytes||I.sha(b)!==f.sha256)throw Error('Retained file hash mismatch');fs.mkdirSync(path.dirname(path.join(dir,f.path)),{recursive:true});fs.writeFileSync(path.join(dir,f.path),b);}fs.writeFileSync(path.join(dir,'files.json'),manifest);fs.writeFileSync(path.join(dir,'publication.json'),await fetchBytes('publication.json',8192));verifyRelease(dir,descriptor);}catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}return dir;
}
module.exports={REV,validateContext,publicCoverage,walk,fileManifest,stamp,verifyRelease,verifyAggregate,compose,restorePublic};
