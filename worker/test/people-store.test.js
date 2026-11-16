import test from 'node:test';import assert from 'node:assert/strict';
import { createStore, parseIndex, AGGREGATE_INDEX_BYTES, AGGREGATE_INDEX_SLOTS } from '../src/store.js';
import { createHandler } from '../src/handler.js';import { textOf, makeObject } from './fixture.js';
const rev=n=>'r-'+String(n).repeat(32),url=(r,n='index.json')=>`https://pages.test/mood-engine/u/friend-a/r/${r}/data/${n}`;
function raw(r,personId='friend-a',extra=''){const o=makeObject();o.meta.personId=personId;o.meta.revision=r;o.meta.testPadding=extra;return textOf(o);}
test('same revision and person validated before hydration, edge cache insertion and stale reuse',async()=>{
 const r=rev(1);for(const value of [raw(rev(2)),raw(r,'marco'),textOf(makeObject())]){
 let writes=0;const store=createStore({fetchImpl:async()=>new Response(value),caches:{default:{async match(){return new Response(value,{headers:{'x-fetched-at':String(Date.now())}});},async put(){writes++;}}},log(){}});
 assert.equal(await store.get(url(r)),null);assert.equal(writes,0);assert.equal(store._slots.get(url(r)).index,null);
 }
 assert.throws(()=>parseIndex(raw(r),'https://pages.test/mood-engine/u/friend-a/data/index.json'));
});
test('the pointer is read once per 60 s per isolate, old cached release never chooses active revision',async()=>{
 // 20/10/2026 (S1): the pointer is read at most once in 60 s per isolate (test/will-publication-cache.test.js); the clock is the handler's, so the second read happens 60 s later.
 let active=rev(1),reads=0,clock=1e9;const calls=[];const store=createStore({fetchImpl:async u=>{calls.push(u);return new Response(raw(u.includes(rev(1))?rev(1):rev(2)));},log(){}});
 const handle=createHandler({store,now:()=>clock,publication:async()=>{reads++;return {revision:active};}});
 const req=()=>handle(new Request('https://worker.test/u/friend-a/manifest.json'));
 const first=await req();assert.equal(first.headers.get('X-Mood-Revision'),rev(1));active=rev(2);clock+=60e3;const next=await req();assert.equal(next.headers.get('X-Mood-Revision'),rev(2));assert.equal(reads,2);assert.ok(calls.some(u=>u.includes(rev(2))));
 const down=createHandler({store,publication:async()=>null});assert.equal((await down(new Request('https://worker.test/u/friend-a/manifest.json'))).status,503);
});
// 20/10/2026 (owner review of 8e37c23, item 3): the 24 MiB aggregate ceiling and the 128 slots are for WILL's files (the /u/ paths). Marco's files are resident for the life of the isolate (worker/test/store.test.js).
test('aggregate cap covers every Will revision and removes slot bookkeeping',async()=>{
 assert.equal(AGGREGATE_INDEX_BYTES,25165824);assert.equal(AGGREGATE_INDEX_SLOTS,128);
 const r=rev(1),data=raw(r,'friend-a','x'.repeat(1024*1024));
 const logs=[],store=createStore({fetchImpl:async()=>new Response(data),pieceMax:128,pieceBytes:48e6,willPieceMax:128,willPieceBytes:48e6,log:o=>logs.push(o)});
 for(let n=0;n<35;n++)await store.get(url(r,`index-list-${n}.json`));
 assert.ok([...store._slots.values()].reduce((n,s)=>n+(s.bytes||0),0)<=AGGREGATE_INDEX_BYTES);assert.ok(!store._slots.has(url(r,'index-list-0.json')));
 assert.ok(logs.some(l=>l.event==='aggregate-evicted'&&l.url.includes('/u/')));
 for(let n=0;n<140;n++)await store.get(url(r,`index-v2-row-${n}.json`));
 assert.ok([...store._slots.keys()].filter(u=>u.includes('/u/')).length<=128);assert.ok([...store._slots.values()].reduce((n,s)=>n+(s.bytes||0),0)<=AGGREGATE_INDEX_BYTES);
});
// 20/10/2026 (owner review of 8e37c23, item 2): the queue of one load at a time is for WILL's files (the /u/ paths) only; Marco's files load in parallel (worker/test/store.test.js).
test('independent callers cannot overlap large index fetch/parse buffers of Will',async()=>{
 let concurrent=0,max=0;const r=rev(1),data=raw(r);const store=createStore({fetchImpl:async()=>{concurrent++;max=Math.max(max,concurrent);await new Promise(r=>setTimeout(r,2));concurrent--;return new Response(data);},log(){}});
 await Promise.all(Array.from({length:12},(_,n)=>store.get(url(r,`index-list-${n}.json`))));assert.equal(max,1);
});
test('128-slot ceiling also holds while 140 independent loads of Will await admission',async()=>{
 let unblock;const gate=new Promise(r=>unblock=r);const r=rev(1),data=raw(r);const store=createStore({fetchImpl:async()=>{await gate;return new Response(data);},pieceMax:128,willPieceMax:128,log(){}});
 const pending=Array.from({length:140},(_,n)=>store.get(url(r,`index-v2-row-${n}.json`)));assert.ok(store._slots.size<=128);unblock();assert.ok((await Promise.all(pending)).every(Boolean));assert.ok(store._slots.size<=128);
});
