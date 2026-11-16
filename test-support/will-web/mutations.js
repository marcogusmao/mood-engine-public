#!/usr/bin/env node
'use strict';
// Mutants run in isolated source copies, never in the checked-out source.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mood-web-mutants-'));
const mutations=[
 ['engine-person','web/person.js',"value.meta?.personId!==PERSON||","",'publication and context reject wrong owner'],
 ['engine-revision','web/person.js',"||value.meta?.revision!==revision","",'publication and context reject wrong owner'],
 ['context-person','web/person.js',"value.personId!==PERSON","false",'publication and context reject wrong owner'],
 ['root-fallback','web/person.js',"read('data/engine.json')","read('/mood-engine/data/engine.json')",'publication and context reject wrong owner'],
 ['shared-feedback-db','web/feedback.js',"owner==='mgusmao'?'mood-learning-v1':'mood-learning-v1:friend-a'","'mood-learning-v1'",'IndexedDB separates owners'],
 ['credential-before-redeem','web/upload.js',"session={...IDENTITY,inviteId:link.id,credential};await save();","session={...IDENTITY,inviteId:link.id,credential};",'credential is saved before redemption'],
 ['ready-at-complete','web/upload.js',"current=status({...IDENTITY,state:'queued',request:","current=status({...IDENTITY,state:'ready',request:",'invalid files never allocate'],
 ['clear-fragment','web/upload.js',"if(location.hash)history.replaceState(null,'',location.pathname+location.search);","",'fragment is erased'],
 ['stale-status','web/upload.js',"after.generation<before.generation","false",'old progress and wrong person'],
 ['static-install','web/feedback.js',"manifest=u.href;","manifest=new URL('manifest.json',location.href).href;",'installation accepts only fixed live Will'],
 ['denied-storage-catch','web/index.html',"let indexedDB=null;try{indexedDB=window.indexedDB;}catch{}","let indexedDB=window.indexedDB;",'initialization survives refused indexedDB']
];
const results=[];
try{for(const [name,file,from,to,pattern] of mutations){const dir=path.join(temp,name);fs.mkdirSync(dir);for(const folder of ['web','lib','scripts','test'])fs.cpSync(path.join(root,folder),path.join(dir,folder),{recursive:true});fs.mkdirSync(path.join(dir,'test-support/will-web'),{recursive:true});fs.copyFileSync(path.join(root,'test-support/will-web/http-fixture.js'),path.join(dir,'test-support/will-web/http-fixture.js'));const target=path.join(dir,file),source=fs.readFileSync(target,'utf8');if(!source.includes(from))throw Error('Mutation anchor absent: '+name);fs.writeFileSync(target,source.replace(from,to));const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,'test/people-web.test.js','test/upload-web.test.js','test/final-review-regressions.test.js'],{cwd:dir,encoding:'utf8',timeout:30000});const out=result.stdout||'';const failed=Number(out.match(/# fail (\d+)/)?.[1]||0);const detected=result.status===1&&failed>0;results.push({name,detected,failures:failed,exit:result.status});console.log(JSON.stringify(results.at(-1)));}
 console.log(JSON.stringify({mutants:results.length,detected:results.filter(x=>x.detected).length,survivors:results.filter(x=>!x.detected).map(x=>x.name)}));if(results.some(x=>!x.detected))process.exitCode=1;
}finally{fs.rmSync(temp,{recursive:true,force:true});}
