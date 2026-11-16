import test from 'node:test';
import assert from 'node:assert/strict';
import examples from '../../contracts/will-upload-v1.examples.json' with {type:'json'};
import { CONTRACT, canonical, strictJson, validate, boundedBytes, identity } from '../src/upload/protocol.js';
test('frozen examples and strict identity/type/unknown-property checks',()=>{for(const x of examples.valid)assert.deepEqual(validate(x.schema,x.value),x.value);for(const x of examples.invalid)assert.throws(()=>validate(x.schema,x.value));assert.equal(CONTRACT.routes.length,27);});
test('duplicate and escaped keys, nonfinite and deep JSON rejected',()=>{for(const s of ['{"a":1,"a":2}','{"personId":"marco","person\\u0049d":"friend-a"}','{"x":1e999}','['.repeat(65)+'0'+']'.repeat(65),'{"x":1,}'])assert.throws(()=>strictJson(s));assert.equal(canonical(strictJson('{"z":[2,1],"a":0}')),'{"a":0,"z":[2,1]}');});
test('actual streaming bytes capped without a content-length',async()=>{const req=new Request('https://fixture.test',{method:'PUT',body:new Uint8Array(257)});await assert.rejects(()=>boundedBytes(req,256),{code:'BODY_TOO_LARGE'});});
test('fixed contiguous chunk manifest rejects gaps and wrong sizes',()=>{const v=examples.valid[1].value;for(const changes of [{chunks:[{...v.chunks[0],ordinal:1}]},{bytes:2},{bytes:0},{personId:'marco'}])assert.throws(()=>validate('intake',{...v,...changes}));assert.throws(()=>validate('identity',{...identity(),owner:'friend-a'}));});
test('API refuses default/missing config, origin, extra query, bad method, UTF-8 and role before storage',async()=>{
 const {createUploadApi}=await import('../src/upload/api.js');let reads=0;
 const env={WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName(){reads++;throw Error('storage must not be touched');}}};
 const api=createUploadApi();
 const req=(path,init={})=>new Request('https://worker.test/api/v1/friend-a'+path,init);
 assert.equal((await api(req('/publication'),{})).status,503);
 assert.equal((await api(req('/status',{headers:{Origin:'null'}}),env)).status,403);
 assert.equal((await api(req('/publication?origin=https://evil.test'),env)).status,400);
 assert.equal((await api(req('/status',{method:'DELETE'}),env)).status,405);
 assert.equal((await api(req('/session',{method:'POST',headers:{Origin:env.WILL_BROWSER_ORIGIN,Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'},body:new Uint8Array([255])}),env)).status,400);
 assert.equal(reads,0);
 assert.throws(()=>validate('intake',{bytes:8388609}),{status:413,code:'ZIP_TOO_LARGE'});
});
test('local CLI guard refuses external sockets before DNS without starting a listener',async()=>{
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');const guard=fileURLToPath(new URL('./upload-fixtures/offline.cjs',import.meta.url));
 const result=spawnSync(process.execPath,['--require',guard,'-e',"const assert=require('node:assert/strict');assert.throws(()=>require('node:net').connect({host:'external.invalid',port:443}),{code:'NETWORK_DISABLED'});assert.throws(()=>require('node:dns').lookup('external.invalid',()=>{}),{code:'NETWORK_DISABLED'});"],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
// 20/10/2026: createUploadApi builds its own Response, so /api/v1/friend-a and /api/internal/* answers had no X-Build (W8 only covered send() in handler.js). Now every answer of that API carries it: a refusal, the preflight and a state answer.
test('X-Build rides on every answer of the intake API when GIT_SHA is set, and is absent when it is not',async()=>{
 const {createUploadApi}=await import('../src/upload/api.js');
 const base={WILL_UPLOAD_ENABLED:'true',WILL_BROWSER_ORIGIN:'https://marcogusmao.github.io',WILL_PAGES_BASE:'https://marcogusmao.github.io/mood-engine',WILL_REPOSITORY_ID:'1413569629',WILL_REPOSITORY_OWNER_ID:'50679408',WILL_STATE:{idFromName:()=>'id',get:()=>({fetch:async()=>Response.json({personId:'friend-a',activePublication:null})})}};
 const api=createUploadApi(),req=(path,init={})=>new Request('https://worker.test'+path,init),ask=(env,r)=>api(r,env);
 const answers=env=>[
  ['config missing (503)',ask({GIT_SHA:env.GIT_SHA},req('/api/v1/friend-a/publication'))],
  ['origin refused (403)',ask(env,req('/api/v1/friend-a/status',{headers:{Origin:'null'}}))],
  ['internal route without a token (401)',ask(env,req('/api/internal/v1/friend-a/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}))],
  ['preflight (204)',ask(env,req('/api/v1/friend-a/status',{method:'OPTIONS',headers:{Origin:env.WILL_BROWSER_ORIGIN,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}}))],
  ['state answer (200)',ask(env,req('/api/v1/friend-a/publication'))],
 ];
 const want={'config missing (503)':503,'origin refused (403)':403,'internal route without a token (401)':401,'preflight (204)':204,'state answer (200)':200};
 for(const [name,pending] of answers({...base,GIT_SHA:'abc1234'})){const res=await pending;assert.equal(res.status,want[name],name);assert.equal(res.headers.get('X-Build'),'abc1234',name);}
 for(const [name,pending] of answers(base)){const res=await pending;assert.equal(res.status,want[name],name);assert.equal(res.headers.has('X-Build'),false,name+' without GIT_SHA');}
 const odd=await ask({...base,GIT_SHA:'  abc\u00e9 12\n'},req('/api/v1/friend-a/publication'));assert.equal(odd.headers.get('X-Build'),'abc 12','same printable-ASCII rule as the addon answers');
 assert.equal(await api(req('/manifest.json'),{...base,GIT_SHA:'abc1234'}),null,'the addon paths are not this API\'s');
});

