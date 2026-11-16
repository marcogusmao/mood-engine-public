// Synthetic film projections only. This measures Node V8, not Cloudflare CPU/heap.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {makeObject,textOf} from '../fixture.js';import {createStore,AGGREGATE_INDEX_BYTES} from '../../src/store.js';import assert from 'node:assert/strict';
const files=new Map(),n=11200,temp=await mkdtemp(join(tmpdir(),'mood-index-heap-'));
try {
for(const [personId,revision] of [[null,null],['friend-a','r-'+'1'.repeat(32)],['friend-a','r-'+'2'.repeat(32)]]){
 const o=makeObject(),template=o.films[0];o.films=Array.from({length:n},(_,i)=>({...template,tt:'tt'+String(900000000+i),name:`Synthetic film ${i}`,seen:personId?i%2===0:i%2===1,watchlist:personId?i%2===1:i%2===0,desc:'Synthetic projection. '.repeat(28)}));
 if(personId){o.meta.personId=personId;o.meta.revision=revision;}
 const base=personId?`https://pages.test/u/friend-a/r/${revision}/data/`:'https://pages.test/data/';
 const text=textOf(o),path=join(temp,String(files.size)+'.json');await writeFile(path,text);const entry={path,textBytes:Buffer.byteLength(text)};files.set(base+'index.json',entry);files.set(base+'index-v2.json',entry);
}
global.gc?.();const before=process.memoryUsage().heapUsed;let peak=before;const store=createStore({fetchImpl:async url=>new Response(await readFile(files.get(url).path)),log(){}}),loads=[];
for(const [url,entry] of files){const result=await store.get(url);assert.ok(result);assert.equal(result.index.films.length,n);peak=Math.max(peak,process.memoryUsage().heapUsed);loads.push({url,textBytes:entry.textBytes});}
global.gc?.();const residentTextBytes=[...store._slots.values()].reduce((n,s)=>n+(s.bytes||0),0);assert.ok(residentTextBytes<=AGGREGATE_INDEX_BYTES);console.log(JSON.stringify({proof:'synthetic Node V8 index loading; real public family artifacts absent in this worktree',filmsPerIndex:n,loads,residentSlots:store._slots.size,residentTextBytes,beforeHeapBytes:before,afterGcHeapBytes:process.memoryUsage().heapUsed,observedPeakHeapBytes:peak,cloudflareMeasurement:false}));

} finally { await rm(temp,{recursive:true,force:true}); }
