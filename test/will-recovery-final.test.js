'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const F=require('../test-support/people/fixture'),PUB=require('../lib/people-publication');
test('will-recovery-final composed shell supplies every local script and initializes from artifact alone',async t=>{
 const f=F.fixture(t),marco=path.join(f.root,'marco'),out=path.join(f.root,'aggregate'),web=path.join(F.ROOT,'web');
 const cfg={addon:{id:'com.mgusmao.moodengine',name:'Synthetic',version:'1',description:'Synthetic'}},plan={board:[],discover:[]};
 const index=require('../lib/index-export').buildIndex({cfg,plan,today:'2026-10-15',builtAt:'2026-10-15T12:00:00.000Z'});
 require('../lib/publish').publish({outDir:marco,webDir:web,cfg,plan,webData:{},index});
 PUB.compose({marcoDir:marco,outDir:out,webDir:web,apiOrigin:'https://mood-engine.mood-engine-worker.workers.dev'});
 const shell=path.join(out,'u/friend-a'),html=fs.readFileSync(path.join(shell,'index.html'),'utf8');
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
 const nodes=new Map(),node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',hidden:false,addEventListener(){},setAttribute(){},removeAttribute(){},classList:{add(){},remove(){},toggle(){}},focus(){}});return nodes.get(s);};
 const calls=[],document={body:{dataset:{owner:'friend-a',willApiOrigin:'https://mood-engine.mood-engine-worker.workers.dev'}},querySelector:node,addEventListener(){},visibilityState:'visible'};
 const context=vm.createContext({document,location:{href:'https://marcogusmao.github.io/mood-engine/u/friend-a/',hash:'',pathname:'/mood-engine/u/friend-a/',search:''},navigator:{},history:{replaceState(){}},crypto:globalThis.crypto,URL,URLSearchParams,TextEncoder,setTimeout:()=>0,clearTimeout(){},fetch:async url=>{calls.push(url);return Response.json({schemaVersion:1,personId:'friend-a',state:'not_ready',activePublication:null});}});context.window=context;
 let count=0;
 for(const [,attrs,inline]of scripts){const src=attrs.match(/\bsrc="([^"]+)"/);if(src){a(!/^(?:https?:|\/\/)/.test(src[1]));const file=path.resolve(shell,src[1]);a(file.startsWith(shell+path.sep));a(fs.existsSync(file),'composed artifact missing '+src[1]);const expected=src[1]==='assets/feedback-core.js'?path.join(F.ROOT,'lib/learning/feedback.js'):path.join(web,path.basename(src[1]));a.deepEqual(fs.readFileSync(file),fs.readFileSync(expected));a.doesNotThrow(()=>vm.runInContext(fs.readFileSync(file,'utf8'),context));count++;}else a.doesNotThrow(()=>vm.runInContext(inline,context),'served inline initialization');}
 await new Promise(resolve=>setImmediate(resolve));
 a.equal(count,5);a.equal(document.title,'Will’s Mood Engine');a.equal(node('#willUpload').hidden,false);a.equal(node('#install').disabled,true);a(calls.some(url=>String(url).endsWith('/publication')));a.equal(typeof context.MoodFeedbackUI.installation,'function');a.equal(typeof context.MoodSelector,'object');
});
