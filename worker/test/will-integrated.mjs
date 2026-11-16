// Synthetic ZIP through the real local Worker, parser, builder and public handler.
// No real invitations, account changes or external network are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { runtime, register, redeem, upload, jwt, ROOT, IDENTITY } from './upload-fixtures/runtime.mjs';
const require=createRequire(import.meta.url), F=require('../../test-support/people/fixture');
const I=require('../../lib/person-input'), B=require('../../scripts/build-people'), PUB=require('../../lib/people-publication');
const {createClient}=require('../../scripts/will-private-client'), {acknowledge}=require('../../scripts/ack-will-publication');
const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1];
if(process.env.NODE_TEST_CONTEXT && args.length===0){
 const {test}=await import('node:test');test.skip('explicit HTTP/browser rehearsal: run --offline --out <fresh directory>',()=>{});
}else{
if(!args.includes('--offline')||!args.includes('--out'))throw Error('Use --offline --out <fresh local directory>');
const out=path.resolve(value('--out'));if(fs.existsSync(out))throw Error('Output already exists');fs.mkdirSync(out,{recursive:true});
const origin='https://mood-engine.mood-engine-worker.workers.dev',pagesOrigin='https://marcogusmao.github.io';
let publicDir=null,worker, browser, webServer, browserContext,page, externalAttempts=0;
const errors=[], browserProof={}, assertions=[];
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);assertions.push(label);};
const staticServer=http.createServer((req,res)=>{
 try{const u=new URL(req.url,'http://127.0.0.1');if(!publicDir||!u.pathname.startsWith('/mood-engine/')){res.writeHead(404);return res.end();}
  const rel=decodeURIComponent(u.pathname.slice('/mood-engine/'.length)),target=path.resolve(publicDir,rel||'index.html');
  if(!target.startsWith(publicDir+path.sep)&&target!==publicDir){res.writeHead(404);return res.end();}
  const file=fs.existsSync(target)&&fs.statSync(target).isDirectory()?path.join(target,'index.html'):target;
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.json')?'application/json':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream');res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
 }catch{res.writeHead(500);res.end();}
});
await new Promise(r=>staticServer.listen(0,'127.0.0.1',r));const staticOrigin=`http://127.0.0.1:${staticServer.address().port}`;
const transport=(input,options)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.origin===origin)return fetch(worker.base+u.pathname+u.search,options);if(u.origin===pagesOrigin)return fetch(staticOrigin+u.pathname+u.search,options);externalAttempts++;throw Error('External network disabled');};
const mkClient=(role,run='123')=>createClient({origin,role,token:()=>jwt(role,run),fetchImpl:transport});
const screen=async name=>page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
try{
 worker=await runtime({entry:path.join(ROOT,'worker/test/upload-fixtures/will-integrated-entry.js'),vars:{WILL_TEST_PUBLIC_ORIGIN:staticOrigin}});
 const root=path.join(out,'source');F.sourceCopy(root);
 const {projectMetadata}=require('../../scripts/prepare-person');
 for(const name of ['tmdb.json','friends.json','lists.json','imdb-ratings.json','mubi.json']){const from=path.join(ROOT,'cache',name);if(fs.existsSync(from))F.write(root,'cache/'+name,projectMetadata(name,JSON.parse(fs.readFileSync(from,'utf8'))));}
 const head='Date,Name,Year,Letterboxd URI';for(const [n,text] of Object.entries({'watched.csv':head+'\n','ratings.csv':head+',Rating\n','watchlist.csv':head+'\n2026-10-01,Paterson,2016,https://boxd.it/fWkQ\n','diary.csv':head+',Rating,Rewatch,Tags,Watched Date\n'}))F.write(root,'data/letterboxd/'+n,text);
 // Unused reviews make a multi-chunk original ZIP while the parser projects only approved fields.
 const archive=F.zip(root,{row:'Paterson',year:2016,uri:'https://boxd.it/fWkQ',extra:{'reviews.csv':'Private review canary\n'.repeat(30000)}}),bytes=fs.readFileSync(archive);
 const invitation=await register(worker);let token,requestId;
 if(args.includes('--browser')){
  if(!process.env.WILL_PLAYWRIGHT_MODULE)throw Error('Explicit existing Playwright module required');
  const {chromium}=require(process.env.WILL_PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true});
  browserContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  // Only loopback is reachable from this browser proof. No remote fonts/posters are silently fetched.
  await browserContext.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)?route.continue():route.abort();});
  const rehearsal=require('../../scripts/will-web-rehearsal');
  const webArgs={api:worker.base,publicDir:null};webServer=rehearsal.create(webArgs);await new Promise(r=>webServer.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${webServer.address().port}/mood-engine/u/friend-a/`;
  page=await browserContext.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+`#invite=${invitation.invitation}&id=${invitation.inviteId}`);await page.locator('#uploadForm').waitFor({state:'visible'});
  equal(new URL(page.url()).hash,'','invitation fragment removed');equal(await page.locator('#install').isDisabled(),true,'install disabled before publication');
  await screen('01-invited-desktop');
  await page.evaluate(()=>document.documentElement.style.zoom='2');
  equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'200 percent CSS zoom initial reflow');await screen('01b-invited-css-zoom');
  await page.evaluate(()=>document.documentElement.style.zoom='');await page.setViewportSize({width:320,height:800});
  equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'320px initial reflow');await screen('02-invited-mobile');
  await page.setViewportSize({width:1440,height:1000});await page.locator('#uploadSubmit').click();
  equal(await page.locator('#uploadFile').getAttribute('aria-invalid'),'true','missing file identified');
  equal(await page.locator('#uploadFile').evaluate(e=>document.activeElement===e),true,'missing file receives focus');
  let chunkAcknowledged=false;
  await page.route('**/api/v1/friend-a/uploads/*/chunks/*',async route=>{if(chunkAcknowledged)return route.abort();const response=await route.fetch();chunkAcknowledged=true;await route.fulfill({response});});
  await page.locator('#uploadFile').setInputFiles(archive);await page.locator('#uploadSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('connection'));
  await page.reload();await page.locator('#uploadForm').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('interrupted'));
  await screen('03-resume-after-reload');await page.unroute('**/api/v1/friend-a/uploads/*/chunks/*');
  await page.locator('#uploadFile').setInputFiles(archive);await page.locator('#uploadSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Export received'));
  browserProof.resumeAfterReload=true;await screen('04-queued');
  const session=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('mood-upload-friend-a-v1',1);r.onsuccess=()=>{const get=r.result.transaction('session').objectStore('session').get('current');get.onsuccess=()=>resolve(get.result);get.onerror=reject;};r.onerror=reject;}));
  token=session.credential;requestId=session.upload.requestId;
  await page.reload();await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Export received'));browserProof.queuedAfterReload=true;
  // Keep the serving projection available when the real build finishes below.
  browserProof.webArgs=webArgs;
 }else{token=await redeem(worker,invitation);requestId=await upload(worker,token,bytes);}
 await worker.stop();await worker.start();equal((await worker.call('/status',{token})).body.state,'queued','SQLite queue survives restart');
 const client=mkClient('build'),lease=await client.claim();equal(lease.requestId,requestId,'claim owns browser ZIP');
 const source=await client.readBlob(lease.sourceBlobId,lease);equal(source.bytes.equals(bytes),true,'HTTP ZIP equals browser ZIP');
 const capturedAt=new Date().toISOString(),date=new Date(capturedAt).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),codeSha='e'.repeat(40),privateDir=path.join(root,'.context/private/friend-a/integrated');
 fs.mkdirSync(privateDir,{recursive:true,mode:0o700});const received=path.join(privateDir,'archive.zip');fs.writeFileSync(received,source.bytes,{mode:0o600});
 I.importArchive({root,privateDir,archive:received,capturedAt,requestId});
 const result=B.buildPeople({root,privateDir,workDir:path.join(out,'work'),revision:lease.revision,codeSha,capturedAt,date,outDir:path.join(out,'public'),apiOrigin:origin,offline:true});
 fs.writeFileSync(path.join(out,'will-build.log'),result.log);fs.writeFileSync(path.join(out,'marco-build.log'),result.marcoLog);
 const releaseDir=path.join(out,'public/u/friend-a/r',lease.revision);
 const packageBytes=I.pack?I.pack({snapshotBytes:result.snapshot,releaseDir}):result.snapshot;
 const history=JSON.parse(fs.readFileSync(path.join(privateDir,'history.json'))),coverage=Object.fromEntries(['watched','ratings','watchlist','likes','diary','following'].map(k=>[k,history.coverage[k]?.state||'unknown']));
 const snapshotId=await client.persistSnapshot(packageBytes,lease,coverage),descriptor={...result.descriptor,codeSha};
 await client.request('POST',`/requests/${lease.requestId}/prepare`,{body:{requestId:lease.requestId,leaseEpoch:lease.leaseEpoch,snapshotId,...descriptor}});
 equal((await worker.call('/status',{token})).body.state,'publishing','built release waits for verification');
 equal((await fetch(worker.base+'/u/friend-a/manifest.json')).status,503,'live addon waits for ACK');
 const receipts={};for(const name of ['publication.json','data/person.json'])receipts[pagesOrigin+'/mood-engine/u/friend-a/r/'+lease.revision+'/'+name]=fs.readFileSync(path.join(releaseDir,name),'utf8');
 publicDir=path.join(out,'public');await worker.receipts(receipts);
 await acknowledge({client:mkClient('deploy'),origin,descriptor,fetchImpl:transport,windowMs:0});
 equal((await worker.call('/status',{token})).body.state,'ready','ready follows all-byte verification and ACK');
 const live=await fetch(worker.base+'/u/friend-a/manifest.json');equal(live.status,200,'real public handler serves Will');equal(live.headers.get('X-Mood-Revision'),lease.revision,'addon revision equals verified release');
 await worker.stop();await worker.start();equal((await fetch(worker.base+'/u/friend-a/manifest.json')).status,200,'live publication survives restart');
 const nextClient=mkClient('build','125'),next=await nextClient.claim();equal(next.kind,'public-refresh','next runner claims refresh');
 const retained=await nextClient.readBlob(snapshotId,next);equal(retained.bytes.equals(packageBytes),true,'fresh runner downloads sealed package');
 const freshDir=path.join(root,'.context/private/friend-a/fresh');
 if(I.restorePackage)I.restorePackage({root,privateDir:freshDir,bytes:retained.bytes});else I.restore({root,privateDir:freshDir,bytes:retained.bytes});
 equal(JSON.parse(fs.readFileSync(path.join(freshDir,'history.json'))).personId,'friend-a','fresh runner restores correct owner');
 await nextClient.request('POST',`/requests/${next.requestId}/fail`,{body:{requestId:next.requestId,leaseEpoch:next.leaseEpoch,code:'BUILD_FAILED',retryable:false}});
 if(page){
  browserProof.webArgs.publicDir=publicDir;delete browserProof.webArgs;
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#install').disabled);await screen('05-ready-desktop');
  equal(await page.title(),'Will’s Mood Engine','browser owns Will');
  equal(await page.locator('#copyManifest').isDisabled(),false,'copy enabled after verified ready');
  equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.body).transitionDuration==='0s'),true,'reduced motion disables transitions');
  await page.locator('#uploadDetails').evaluate(e=>e.open=true);
  // A replacement can be cancelled while queued without hiding the verified release.
  await page.locator('#uploadFile').setInputFiles(archive);await page.locator('#uploadSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Export received'));
  equal(await page.locator('#install').isDisabled(),false,'active addon remains during replacement');
  await page.locator('#uploadCancel').click();await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Upload cancelled'));
  equal((await worker.call('/status',{token})).body.activePublication.revision,lease.revision,'cancel keeps active revision');
  await browserContext.setOffline(true);await page.locator('#uploadCheck').click();
  await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Check your connection'));
  equal(await page.locator('#install').isDisabled(),false,'offline check keeps loaded addon');
  await browserContext.setOffline(false);await page.locator('#uploadCheck').click();
  await page.waitForFunction(()=>document.querySelector('#uploadStatus').textContent.includes('Upload cancelled'));

  await page.setViewportSize({width:320,height:800});equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'320px ready reflow');await screen('06-ready-mobile');
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>document.documentElement.style.zoom='2');
  equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'200 percent CSS zoom ready reflow');await screen('06b-ready-css-zoom');
  await page.evaluate(()=>document.documentElement.style.zoom='');
  await page.locator('#uploadDetails').evaluate(e=>e.open=true);await page.locator('#uploadFile').focus();await page.keyboard.press('Escape');
  equal(await page.locator('#uploadSummary').evaluate(e=>e===document.activeElement),true,'Escape returns focus');
  equal(await page.locator('#uploadDetails').evaluate(e=>e.open),false,'Escape closes update panel');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied');}},configurable:true}));
  await page.locator('#copyManifest').click();equal(await page.locator('#manifestFallback').isVisible(),true,'clipboard denied exposes selectable URL');
  const savedUrl=await page.locator('#manifestUrl').inputValue();equal(savedUrl,origin+'/u/friend-a/manifest.json','copy targets live film addon');
  // A new browser without storage must disclose that the credential survives only this tab.
  const denied=await browser.newContext();await denied.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  await denied.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true}));
  const deniedPage=await denied.newPage();await deniedPage.goto(page.url());
  await deniedPage.waitForFunction(()=>document.querySelector('#credentialStatus').textContent.includes('Not saved'));
  await deniedPage.waitForFunction(()=>!document.querySelector('#install').disabled);
  equal(await deniedPage.title(),'Will’s Mood Engine','fresh public visitor owns Will without credential');
  equal(await deniedPage.locator('#copyManifest').isDisabled(),false,'fresh public visitor can install verified addon');
  equal(await deniedPage.locator('#uploadForm').isVisible(),false,'storage denied does not claim an upload session');
  equal(new URL(deniedPage.url()).hash,'','storage denied exposes no capability');await denied.close();
  browserProof.pageErrors=errors;equal(errors.length,0,'browser has no uncaught errors');
 }
 equal(externalAttempts,0,'runner external network disabled');
 const receipt={synthetic:true,realUserData:false,workerdSQLite:true,actualParser:true,productionBuilds:2,archiveBytes:bytes.length,snapshotBytes:packageBytes.length,revision:lease.revision,assertions,browser:browserProof};
 fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(browser)await browser.close();if(webServer)await new Promise(r=>webServer.close(r));await new Promise(r=>staticServer.close(r));if(worker)await worker.close();}

}
