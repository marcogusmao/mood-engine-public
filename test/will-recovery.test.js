'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),{execFileSync}=require('node:child_process');
const F=require('../test-support/people/fixture'),I=require('../lib/person-input'),PUB=require('../lib/people-publication'),B=require('../scripts/build-people'),A=require('../scripts/ack-will-publication');
const origin='https://mood-engine.mood-engine-worker.workers.dev',oldTime='2026-10-14T12:00:00.000Z',newTime='2026-10-15T12:00:00.000Z',oldCode='a'.repeat(40),newCode='b'.repeat(40),revision='r-'+'1'.repeat(32),requestId='11111111-1111-4111-8111-111111111111';
function site(dir,{will=false,rev=revision,code=oldCode,time=oldTime,jpeg=false}={}){
 const cfg={addon:{id:will?'com.mgusmao.moodengine.friend-a':'com.mgusmao.moodengine',name:'Synthetic',version:'1',description:'Synthetic'},...(will?{personContext:{personId:'friend-a',revision:rev}}:{})},plan={board:[],discover:[]};
 const index=require('../lib/index-export').buildIndex({cfg,plan,today:time.slice(0,10),builtAt:time});
 require('../lib/publish').publish({outDir:dir,webDir:path.join(F.ROOT,'web'),cfg,plan,webData:{},index});
 if(jpeg){const mf=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(mf));m.catalogs.push({type:'movie',id:'proof',name:'Proof'});fs.writeFileSync(mf,JSON.stringify(m));fs.mkdirSync(path.join(dir,'posters'));execFileSync('python3',['-c',"from PIL import Image; import sys; Image.new('RGB',(320,480),(51,102,153)).save(sys.argv[1],format='JPEG')",path.join(dir,'posters/tt1234567.jpg')]);
  fs.mkdirSync(path.join(dir,'catalog/movie'),{recursive:true});fs.writeFileSync(path.join(dir,'catalog/movie/proof.json'),JSON.stringify({metas:[{id:'tt1234567',type:'movie',name:'Synthetic',poster:`https://marcogusmao.github.io/mood-engine/u/friend-a/r/${rev}/posters/tt1234567.jpg`}]}));}
 return will?{...PUB.stamp({dir,revision:rev,codeSha:code,builtAt:time,history:F.history()}),codeSha:code}:null;
}
function setup(t){const f=F.fixture(t);fs.cpSync(path.join(F.ROOT,'web'),path.join(f.root,'web'),{recursive:true});I.write(path.join(f.privateDir,'history.json'),F.history());I.write(path.join(f.privateDir,'identities.json'),{'https://boxd.it/PRIVATERECOVERYCANARY':{canonicalUri:'https://letterboxd.com/film/private-recovery-canary/'}});I.write(path.join(f.privateDir,'coverage.json'),F.history().coverage);const releaseDir=path.join(f.root,'release');const descriptor=site(releaseDir,{will:true,jpeg:true});const snapshotBytes=I.snapshot({...f,sourceRequestId:requestId,codeSha:oldCode,capturedAt:oldTime,selectionDate:'2026-10-14'}),bytes=I.pack({snapshotBytes,releaseDir});return {...f,releaseDir,descriptor,snapshotBytes,bytes};}
function fetcher(f){return async url=>{const name=new URL(url).pathname.split('/r/'+revision+'/')[1];return name&&fs.existsSync(path.join(f.releaseDir,name))?new Response(fs.readFileSync(path.join(f.releaseDir,name))):new Response('missing',{status:404});};}
function defaults(f){return {root:f.root,origin,env:{GITHUB_RUN_ID:'2',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:newCode},now:()=>newTime,fetchImpl:fetcher(f),marcoBuild:(root,args)=>site(args[args.indexOf('--out')+1])};}
test('will-recovery idle with active restores exact release and builds Marco; failed restore preserves docs',async t=>{
 const f=setup(t),client={request:async(m,p)=>({publications:p==='/retained'?[f.descriptor]:[]}),claim:async()=>null};
 const result=await B.hosted({...defaults(f),client});a.equal(result.state,'idle');a.equal(result.retained,1);a(fs.existsSync(path.join(f.root,'docs/manifest.json')));a.deepEqual(fs.readFileSync(path.join(f.root,'docs/u/friend-a/r',revision,'posters/tt1234567.jpg')),fs.readFileSync(path.join(f.releaseDir,'posters/tt1234567.jpg')));
 const html=fs.readFileSync(path.join(f.root,'docs/u/friend-a/index.html'),'utf8');a.equal((html.match(/data-will-api-origin=/g)||[]).length,1);a(html.includes('data-will-api-origin="'+origin+'"'));
 const before=fs.readFileSync(path.join(f.root,'docs/manifest.json'));await a.rejects(()=>B.hosted({...defaults(f),client,fetchImpl:async()=>new Response('missing',{status:404})}),/UNAVAILABLE/);a.deepEqual(fs.readFileSync(path.join(f.root,'docs/manifest.json')),before);
});
test('will-recovery ordinary snapshot refresh uses new code/time and prepares only after exact package persistence',async t=>{
 const f=setup(t),rev='r-'+'3'.repeat(32),activeRevision='r-'+'2'.repeat(32),activeDir=path.join(f.root,'active'),active=site(activeDir,{will:true,rev:activeRevision,jpeg:true}),lease={personId:'friend-a',requestId,revision:rev,runId:'2',runAttempt:'1',leaseEpoch:1,sourceBlobId:'source',publications:[active,f.descriptor]};let updated=false,saved=false,prepared=false,clockCalls=0;const collectingAt='2026-10-15T02:59:00.000Z';
 const client={request:async(m,p,o)=>{if(p==='/retained')return {publications:[f.descriptor]};if(p==='/replay')return {publications:[]};if(p.endsWith('/prepare')){a(saved);a.equal(o.body.codeSha,newCode);prepared=true;}return {};},claim:async()=>lease,readBlob:async()=>({manifest:{kind:'snapshot'},bytes:f.bytes}),heartbeat:async()=>{},persistSnapshot:async bytes=>{const doc=I.unpack(bytes);a.equal(doc.snapshot.codeSha,newCode);a.equal(doc.snapshot.capturedAt,newTime);a.equal(doc.snapshot.selectionDate,'2026-10-15');a(doc.release.some(f=>f.path==='posters/tt1234567.jpg'));saved=true;return 'candidate';}};
 const build=opts=>{a(updated);a.equal(opts.offline,false);a.equal(opts.capturedAt,newTime);a.equal(opts.codeSha,newCode);fs.mkdirSync(opts.workDir,{recursive:true});site(path.join(opts.workDir,'marco'));const dir=path.join(opts.workDir,'will'),descriptor=site(dir,{will:true,rev,code:opts.codeSha,time:opts.capturedAt,jpeg:true});PUB.compose({marcoDir:path.join(opts.workDir,'marco'),willDir:dir,previous:opts.previous,outDir:opts.outDir,webDir:path.join(f.root,'web'),apiOrigin:origin});return {descriptor};};
 const result=await B.hosted({...defaults(f),now:()=>clockCalls++===0?collectingAt:newTime,client,fetchImpl:async url=>{const name=new URL(url).pathname.split('/r/'+activeRevision+'/')[1];return name?new Response(fs.readFileSync(path.join(activeDir,name))):fetcher(f)(url);},update:async opts=>{a.equal(opts.capturedAt,collectingAt);const file=path.join(opts.privateDir,'history.json'),h=JSON.parse(fs.readFileSync(file));h.coverage.watched.completedAt='2026-10-15T03:01:00.000Z';I.write(file,h);I.write(path.join(opts.privateDir,'coverage.json'),h.coverage);updated=true;},build});a(prepared);a.equal(result.state,'publishing');a(fs.existsSync(path.join(f.root,'docs/u/friend-a/r',revision)));a.deepEqual(fs.readdirSync(path.join(f.root,'docs/u/friend-a/r')).sort(),[revision,activeRevision,rev].sort());
});
test('will-recovery lost prepared artifact replays exact JPEG offline under a newer runner without writes',async t=>{
 const f=setup(t),descriptor={...f.descriptor,requestId,snapshotId:'snapshot'};let reads=0;
 const client={request:async(m,p)=>{a.equal(m,'GET');return {publications:p==='/replay'?[descriptor]:[]};},claim:async()=>{a.fail('replay cannot claim');},readBlob:async(id,lease,rev)=>{a.equal(id,'snapshot');a.equal(lease,null);a.equal(rev,revision);reads++;return {manifest:{kind:'snapshot',sealed:true},bytes:f.bytes};}};
 const result=await B.hosted({...defaults(f),client,update:()=>a.fail('replay cannot refresh'),build:()=>a.fail('replay cannot build Will')});a(result.replayed);a.equal(reads,1);
 const dir=path.join(f.root,'docs/u/friend-a/r',revision);a.deepEqual(PUB.fileManifest(dir),PUB.fileManifest(f.releaseDir));a.equal(PUB.verifyRelease(dir).receipt.builtAt,oldTime);a.equal(PUB.verifyRelease(dir).receipt.codeSha,oldCode);
 for(const file of PUB.walk(path.join(f.root,'docs')))a(!fs.readFileSync(file).includes(Buffer.from('PRIVATERECOVERYCANARY')));
 for(const file of PUB.walk(f.releaseDir))a.deepEqual(fs.readFileSync(path.join(dir,path.relative(f.releaseDir,file))),fs.readFileSync(file));
});
test('will-recovery package rejects owner/path/hash/size/duplicate',t=>{
 const f=setup(t);for(const change of [d=>d.personId='marco',d=>d.release[0].path='../escape',d=>d.release[0].sha256='0'.repeat(64),d=>d.release[0].bytes++,d=>d.release.push(d.release[0]),d=>d.release[0].path='/index.html',d=>d.release[0].path='history.json']){const doc=I.unpack(f.bytes);change(doc);a.throws(()=>I.unpack(z.gzipSync(Buffer.from(I.canonical(doc)))));}
 a.throws(()=>I.unpack(Buffer.alloc(I.PACKAGE_LIMIT+1)),/too large/);
});
test('will-recovery bounded decompression refuses actual expanded bytes over 384 MiB',t=>{
 const f=F.fixture(t);
 // Stream a repetitive payload to avoid allocating the expanded payload in this test process.
 const bomb=path.join(f.root,'bomb.gz');execFileSync('python3',['-c',"import gzip,sys\nwith gzip.open(sys.argv[1],'wb') as f:\n for i in range(385): f.write(b'x'*1048576)",bomb]);a.throws(()=>I.unpack(fs.readFileSync(bomb)),/larger than|Buffer|output|length/i);
});
test('will-recovery missing prepared public bytes requests replay; corrupt receipt blocks',async()=>{
 const descriptor={revision,receiptSha256:'0'.repeat(64)},client={request:()=>a.fail('not ready')};
 a.deepEqual(await A.reconcilePrepared({descriptor,client,origin,fetchImpl:async()=>new Response('',{status:404})}),{replayRequired:true});
 await a.rejects(()=>A.reconcilePrepared({descriptor,client,origin,fetchImpl:async()=>new Response('{}')}),/MISMATCH/);
});
test('will-recovery disabled bootstrap fails closed on active or unavailable state and rejects arbitrary production origin',async t=>{
 const f=setup(t),opts={marcoDir:f.releaseDir,outDir:path.join(f.root,'docs'),webDir:path.join(f.root,'web')};
 for(const response of [new Response('',{status:503}),Response.json({personId:'friend-a',activePublication:{revision}})])await a.rejects(()=>B.bootstrap({...opts,fetchImpl:async()=>response}),/DISABLED/);
 a.throws(()=>PUB.compose({...opts,apiOrigin:'https://arbitrary.example'}),/origin/);
});

test('will-recovery online builder enables downloads/rendering and supports external RUNNER_TEMP',t=>{
 const f=F.fixture(t),runner=F.fixture(t);fs.copyFileSync(path.join(F.ROOT,'config.json'),path.join(f.root,'config.json'));
 const prior=process.env.RUNNER_TEMP;process.env.RUNNER_TEMP=runner.root;t.after(()=>{if(prior===undefined)delete process.env.RUNNER_TEMP;else process.env.RUNNER_TEMP=prior;});
 const dir=path.join(runner.root,'mood-private/friend-a/proof');require('../lib/people').privateRoot(f.root,dir);I.write(path.join(dir,'history.json'),F.history());
 let called=false;B.buildWill({root:f.root,privateDir:dir,outDir:path.join(f.root,'will'),revision,capturedAt:newTime,date:'2026-10-15',offline:false,buildRunner:(root,args)=>{called=true;a(!args.includes('--cache-only'));a(!args.includes('--skip-posters'));a(!args.includes('--offline'));return '';}});
 a(called);a(fs.existsSync(path.join(dir,'cache/friends.json')));a.equal(fs.readdirSync(path.join(f.root,'.context/private/friend-a')).length,0);
});
test('will-recovery lost ACK verifies every deployed JPEG before reconciliation can mark ready',async t=>{
 const f=setup(t);let missing=true,writes=0;
 const fetchImpl=async url=>{
  if(url===origin+'/api/v1/friend-a/publication')return Response.json({personId:'friend-a',activePublication:{revision}});
  if(url===origin+'/u/friend-a/manifest.json')return Response.json({id:'com.mgusmao.moodengine.live.friend-a',types:['movie'],resources:['catalog']},{headers:{'X-Mood-Person':'friend-a','X-Mood-Revision':revision}});
  if(url===A.PAGES+A.BASE)return new Response('synthetic shell');
  if(missing&&url.endsWith('.jpg'))return new Response('',{status:404});return fetcher(f)(url);
 };
 const client={request:async(method,suffix)=>{a.equal(suffix,`/publications/${revision}/reconcile`);writes++;return {acknowledged:true};}};
 const opts={descriptor:f.descriptor,client,origin,fetchImpl,propagation:{settleMs:0,pollMs:0,consecutive:3,limitMs:1000}}; // 21/10/2026: no real 60 s wait after the acknowledgement here (test/will-ack-propagation.test.js has the wait)
 a.deepEqual(await A.reconcilePrepared(opts),{replayRequired:true});a.equal(writes,0);
 missing=false;a.deepEqual(await A.reconcilePrepared({...opts,fetchImpl:async url=>url===A.PAGES+A.BASE?new Response('',{status:404}):fetchImpl(url)}),{replayRequired:true});a.equal(writes,0);a.deepEqual(await A.reconcilePrepared(opts),{acknowledged:true});a.equal(writes,1);
});
