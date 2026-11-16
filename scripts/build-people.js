#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),P=require('../lib/people'),I=require('../lib/person-input'),PUB=require('../lib/people-publication');
function runBuild(root,args,{env={}}={}){const r=spawnSync(process.execPath,[path.join(root,'build.js'),...args],{cwd:root,env:{...process.env,...env},encoding:'utf8',timeout:150*60*1000,maxBuffer:16*1024*1024});if(r.status!==0){const e=Error('PERSON_BUILD_FAILED');e.buildOutput=(r.stdout||'')+(r.stderr||'');throw e;}return r.stdout;}
function buildWill({root,privateDir,outDir,revision,capturedAt,date,offline=true,buildRunner=runBuild}){
 const dir=P.privateRoot(root,privateDir);const h=I.validateHistory(JSON.parse(fs.readFileSync(path.join(dir,'history.json'),'utf8')));
 const cfg=P.deriveConfig(JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),P.resolvePerson('friend-a'));
 I.write(path.join(dir,'person-config.json'),cfg);I.write(path.join(dir,'identities.json'),fs.existsSync(path.join(dir,'identities.json'))?JSON.parse(fs.readFileSync(path.join(dir,'identities.json'),'utf8')):{});I.write(path.join(dir,'coverage.json'),h.coverage);
 // prepare-person currently requires its destination inside root. Seed public facts
 // there, then copy only absent caches into the authorized runner temp directory.
 const seed=path.join(root,'.context/private/friend-a','seed-'+require('node:crypto').randomUUID());
 try {require('./prepare-person').preparePerson(root,'friend-a',seed);
  const cache=path.join(seed,'cache');if(fs.existsSync(cache))for(const name of fs.readdirSync(cache)){
   const target=path.join(dir,'cache',name);P.noSymlinks(dir,target);
   if(!fs.existsSync(target))I.write(target,JSON.parse(fs.readFileSync(path.join(cache,name),'utf8')));
  }
 }finally{fs.rmSync(seed,{recursive:true,force:true});}
 // Online acquisition/rendering happens once; prepared replay restores exact output bytes.
 const log=buildRunner(root,['--person','friend-a','--private-dir',dir,'--person-input',path.join(dir,'history.json'),'--revision',revision,'--out',outDir,'--captured-at',capturedAt,'--date',date,'--no-chrome',...(offline?['--offline','--cache-only','--skip-posters']:[])]);
 return {history:h,log};
}
function buildPeople({root,privateDir,workDir,revision,codeSha,capturedAt,date,previous=[],outDir,apiOrigin=null,offline=true,webDir=path.join(root,'web')}){
 fs.mkdirSync(workDir,{recursive:true});const marco=path.join(workDir,'marco'),will=path.join(workDir,'will');
 const {history,log}=buildWill({root,privateDir,outDir:will,revision,capturedAt,date,offline});
 const marcoLog=runBuild(root,[...(offline?['--offline','--cache-only','--skip-posters']:[]),'--out',marco,'--captured-at',capturedAt,'--date',date]);
 const descriptor=PUB.stamp({dir:will,revision,codeSha,builtAt:capturedAt,history});
 PUB.compose({marcoDir:marco,willDir:will,previous,outDir,webDir,apiOrigin});
 return {descriptor,log,marcoLog,snapshot:I.snapshot({root,privateDir,sourceRequestId:history.sourceRequestId,codeSha,capturedAt,selectionDate:date})};
}
async function restoreRetained({publications,workDir,fetchImpl=fetch}) {
 if(!Array.isArray(publications)||publications.length>2)throw Error('INVALID_RETAINED_DESCRIPTORS');
 const previous=[];for(const descriptor of publications){const dir=path.join(workDir,descriptor.revision);
  await PUB.restorePublic({descriptor,dir,fetchBytes:require('./ack-will-publication').pagesFetcher({revision:descriptor.revision,fetchImpl})});previous.push({...descriptor,dir});
 }return previous;
}
async function hosted({root=path.resolve(__dirname,'..'),origin=process.env.WILL_API_ORIGIN,env=process.env,client:injectedClient,fetchImpl=fetch,now=()=>new Date().toISOString(),build=buildPeople,marcoBuild=runBuild,update=require('./update-person').update}={}){
 if(origin!=='https://mood-engine.mood-engine-worker.workers.dev')throw Error('Invalid configured Worker origin');
 const client=injectedClient||require('./will-private-client').createClient({origin,role:'build'});
 const retained=await client.request('GET','/retained'),prepared=await client.request('GET','/replay');
 if(prepared.publications.length>1)throw Error('MULTIPLE_PREPARED');
 const replay=prepared.publications[0],lease=replay?null:await client.claim();
 if(lease&&(lease.personId!=='friend-a'||!PUB.REV.test(lease.revision)||lease.runId!==env.GITHUB_RUN_ID||lease.runAttempt!==env.GITHUB_RUN_ATTEMPT))throw Error('LEASE_CONTEXT_MISMATCH');
 const requestId=replay?.requestId||lease?.requestId||'idle';
 if(!/^(?:idle|[a-f0-9-]{36})$/.test(requestId))throw Error('INVALID_REQUEST_ID');
 const dir=env.RUNNER_TEMP?path.join(env.RUNNER_TEMP,'mood-private/friend-a',requestId):path.join(root,'.context/private/friend-a',requestId);
 const workDir=path.join(root,'.context/people-stage',requestId),outDir=path.join(root,'docs');
 fs.mkdirSync(workDir,{recursive:true});let heartbeatError=null;
 const timer=lease?setInterval(()=>client.heartbeat(lease).catch(e=>{heartbeatError=e;}),600000):null;timer?.unref();
 try{
  const previous=await restoreRetained({publications:lease?.publications||retained.publications,workDir,fetchImpl});
  let capturedAt=now(),date=new Date(capturedAt).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  if(!lease){
   let willDir=null;
   if(replay){const source=await client.readBlob(replay.snapshotId,null,replay.revision);if(source.manifest.kind!=='snapshot'||!source.manifest.sealed)throw Error('INVALID_PREPARED_SOURCE');
    willDir=path.join(workDir,'replay');I.restorePackage({root,privateDir:dir,bytes:source.bytes,releaseDir:willDir,descriptor:replay});
   }
   const marco=path.join(workDir,'marco');marcoBuild(root,['--out',marco,'--captured-at',capturedAt,'--date',date]);
   PUB.compose({marcoDir:marco,willDir,previous,outDir,webDir:path.join(root,'web'),apiOrigin:origin});
   return {state:replay?'publishing':'idle',replayed:!!replay,retained:previous.length};
  }
  const source=await client.readBlob(lease.sourceBlobId,lease);
  if(source.manifest.kind==='snapshot')I.restorePackage({root,privateDir:dir,bytes:source.bytes});
  else {require('../lib/learning/paths').mkdirPrivate(P.privateRoot(root,dir));const archive=path.join(dir,'archive.zip');fs.writeFileSync(archive,source.bytes,{mode:0o600,flag:'wx'});I.importArchive({root,privateDir:dir,archive,capturedAt,requestId:lease.requestId});}
  // Every new revision refreshes public input under today's code and clock.
  await update({root,privateDir:dir,capturedAt});
  // The snapshot must include the collection's completion time, even across midnight.
  capturedAt=now();date=new Date(capturedAt).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  // Keep docs unchanged until the package is sealed and preparation accepted.
  const candidateOut=path.join(workDir,'candidate');
  const result=await build({root,privateDir:dir,workDir:path.join(workDir,'build'),outDir:candidateOut,revision:lease.revision,codeSha:env.GITHUB_SHA,capturedAt,date,previous,apiOrigin:origin,offline:false});
  if(heartbeatError)throw heartbeatError;
  const history=I.validateHistory(JSON.parse(fs.readFileSync(path.join(dir,'history.json'),'utf8')));
  const releaseDir=path.join(candidateOut,'u/friend-a/r',lease.revision);
  const snapshotBytes=I.snapshot({root,privateDir:dir,sourceRequestId:history.sourceRequestId,codeSha:env.GITHUB_SHA,capturedAt,selectionDate:date});
  const bytes=I.pack({snapshotBytes,releaseDir});
  const coverage=Object.fromEntries(['watched','ratings','watchlist','likes','diary','following'].map(k=>[k,history.coverage[k]?.state||'unknown']));
  const snapshotId=await client.persistSnapshot(bytes,lease,coverage);
  await client.request('POST',`/requests/${lease.requestId}/prepare`,{body:{requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,snapshotId,codeSha:env.GITHUB_SHA,...result.descriptor}});
  // Recompose from verified pieces, retaining atomic rollback of the existing output.
  PUB.compose({marcoDir:path.join(workDir,'build/marco'),willDir:releaseDir,previous,outDir,webDir:path.join(root,'web'),apiOrigin:origin});
  return {state:'publishing',...result.descriptor};
 }catch(e){if(lease){const semantic=/^(EXPORT_|ZIP_)/.test(e.message);const code=e.message==='EXPORT_PROFILE_UNSUPPORTED'?'EXPORT_PROFILE_UNSUPPORTED':semantic?'INVALID_ZIP':'BUILD_FAILED';try{await client.request('POST',`/requests/${lease.requestId}/fail`,{body:{requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,code,retryable:!semantic}});}catch{}}throw e;}
 finally{if(timer)clearInterval(timer);fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(workDir,{recursive:true,force:true});}
}
// Marco's site alone, as main publishes it: no Will shell, nothing but Marco's own files. Used by the legacy first rollout and by the nightly with the intake off.
function publishMarcoOnly(marcoDir,outDir){
  require('../lib/learning/public').verifyPublic(marcoDir);
  const stage=fs.mkdtempSync(path.resolve(outDir)+'.legacy-');
  try{fs.cpSync(marcoDir,stage,{recursive:true});PUB.verifyAggregate(stage);
   const backup=path.resolve(outDir)+'.previous';if(fs.existsSync(backup))throw Error('Previous composition pending');
   const exists=fs.existsSync(outDir);if(exists)fs.renameSync(outDir,backup);
   try{fs.renameSync(stage,outDir);}catch(e){if(exists)fs.renameSync(backup,outDir);throw e;}
   if(exists)fs.rmSync(backup,{recursive:true,force:true});
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
// enabled = the GitHub variable WILL_UPLOAD_ENABLED is "true" in any case, as GitHub compares `== 'true'` without regard to case (the command line reads it; see the bottom of the file).
// 20/10/2026 (owner review of 8e37c23, item 1): with the variable off the nightly must not depend on the Worker or on Pages. It makes no request at all and
// publishes Marco's site alone, like main. Only an enabled variable probes the Worker: then a Worker that answers "disabled" (503 CONFIG_MISSING, the
// wrangler.toml default) is a state that must not be left, and the night refuses.
async function bootstrap({marcoDir,outDir,webDir,origin=process.env.WILL_API_ORIGIN,fetchImpl=fetch,enabled=true}) {
 // enabled !== true (the branch just below): no inventory, no request; Marco alone is published, so on the GitHub runner a Will release already on Pages leaves
 // it the next night (20/10/2026). The only guard is a Will release found inside outDir, which fires on a manual local run, not on the runner (docs/ is empty there).
 // enabled === true (after that branch): probe the fixed public status; an unavailable or active service stops publication.
 const fixed='https://mood-engine.mood-engine-worker.workers.dev';
 P.noSymlinks(path.parse(path.resolve(outDir)).root,path.resolve(outDir));
 const paths=require('../lib/learning/paths');paths.validateDestination(outDir,path.resolve(__dirname,'..'),null,false);
 if(paths.within(path.resolve(marcoDir),path.resolve(outDir))||paths.within(path.resolve(outDir),path.resolve(marcoDir)))throw Error('Composition paths overlap');
 const local=path.join(outDir,'u/friend-a/r');
 if(enabled!==true){
  if(fs.existsSync(local)&&fs.readdirSync(local).length)throw Error('DISABLED_LOCAL_RELEASE_REQUIRES_AUTHENTICATED_PRESERVATION');
  publishMarcoOnly(marcoDir,outDir);
  return {state:'skipped',willPublished:false};
 }
 if(origin&&origin!==fixed)throw Error('Invalid configured Worker origin');
 const res=await fetchImpl(fixed+'/api/v1/friend-a/publication',{redirect:'error',signal:AbortSignal.timeout(20000)});
 const bounded=require('./will-private-client').bounded;
 if(fs.existsSync(local)&&fs.readdirSync(local).length)throw Error('DISABLED_LOCAL_RELEASE_REQUIRES_AUTHENTICATED_PRESERVATION');
 if(res.status===404){
  // First rollout only: the legacy Worker explicitly says these routes do not
  // exist, its original addon works, and Pages has no Will shell to overwrite.
  const absent=async r=>r.status===404&&I.canonical(JSON.parse(await bounded(r,16384)))===I.canonical({err:'not found'});
  if(!await absent(res))throw Error('LEGACY_WORKER_UNVERIFIED');
  const get=url=>fetchImpl(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
  const manifest=await get(fixed+'/manifest.json');
  if(!manifest.ok)throw Error('LEGACY_WORKER_UNVERIFIED');
  const addon=JSON.parse(await bounded(manifest,65536));
  if(addon.id!=='com.mgusmao.moodengine.live'||!Array.isArray(addon.catalogs)||!Array.isArray(addon.types)||!addon.types.includes('movie'))throw Error('LEGACY_WORKER_UNVERIFIED');
  if(!await absent(await get(fixed+'/u/friend-a/manifest.json')))throw Error('LEGACY_WILL_ABSENCE_UNVERIFIED');
  const shell=await get('https://marcogusmao.github.io/mood-engine/u/friend-a/');
  await bounded(shell,1024*1024);
  if(shell.status!==404)throw Error('LEGACY_WILL_ABSENCE_UNVERIFIED');
  // Keep legacy output unchanged: do not publish a Will shell until its Worker exists.
  publishMarcoOnly(marcoDir,outDir);
  return {state:'legacy',willPublished:false};
 }
 if(!res.ok)throw Error('DISABLED_PUBLICATION_STATE_UNVERIFIED');
 const state=JSON.parse(await bounded(res,16384));
 if(state.schemaVersion!==1||state.personId!=='friend-a'||state.state!=='not_ready'||state.activePublication!==null)throw Error('DISABLED_ACTIVE_RELEASE_REQUIRES_AUTHENTICATED_PRESERVATION');
 return PUB.compose({marcoDir,outDir,webDir,apiOrigin:null});
}
if(require.main===module){const args=process.argv.slice(2),opt=k=>args[args.indexOf(k)+1];
 const run=args.includes('--bootstrap')?bootstrap({marcoDir:path.resolve(opt('--marco')),outDir:path.resolve(opt('--out')||'docs'),webDir:path.resolve(__dirname,'../web'),enabled:String(process.env.WILL_UPLOAD_ENABLED).toLowerCase()==='true'}):args.includes('--hosted')?hosted():Promise.resolve().then(()=>buildPeople({root:path.resolve(__dirname,'..'),privateDir:opt('--private-dir'),workDir:opt('--work-dir'),outDir:opt('--out'),revision:opt('--revision'),codeSha:opt('--code-sha'),capturedAt:opt('--captured-at'),date:opt('--date'),apiOrigin:process.env.WILL_API_ORIGIN||null,offline:!args.includes('--online')})).then(r=>r.descriptor);
 run.then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(args.includes('--hosted')&&!/^[A-Z][A-Z0-9_]{0,80}$/.test(e.message)?'BUILD_FAILED':e.message);process.exitCode=1;});}

module.exports={bootstrap,restoreRetained,runBuild,buildWill,buildPeople,hosted};
