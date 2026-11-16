// Every edit is made in a temporary source copy. The current worktree is never mutated.
import {mkdtemp,cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve,join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=resolve(new URL('../..',import.meta.url).pathname),temp=await mkdtemp(join(tmpdir(),'mood-upload-mutants-'));
const state='worker/src/upload/state.js',sql='worker/test/upload-fixtures/sqlite.js';
const mutations=[
 {name:'invalidate a valid cached copy when only the network fetch cap is lowered',file:'worker/src/store.js',from:'text: await readBoundedText(res, MAX_INDEX_BYTES)',to:'text: await readBoundedText(res, maxIndexBytes)',test:'worker/test/store.test.js'},
 {name:'remove owner assertion',file:state,from:"if(body) assertOwner(body);",to:'',test:'worker/test/upload-state.test.js'},
 {name:'skip lease epoch fence',file:state,from:'r.leaseEpoch !== epoch || ',to:'',test:'worker/test/upload-state.test.js'},
 {name:'complete claims ready before publication',file:state,from:"r.state='queued'; r.acceptedAt=",to:"r.state='ready'; r.acceptedAt=",test:'worker/test/upload-state.test.js'},
 {name:'skip independent receipt verification',file:state,from:'await this.receipt(p);',to:'',test:'worker/test/upload-state.test.js'},
 {name:'promote snapshot at seal before deploy',file:state,from:'b.parserVersion=body.parserVersion;',to:'o.activeSnapshotId=b.blobId; this.saveOwner(o); b.parserVersion=body.parserVersion;',test:'worker/test/upload-state.test.js'},
 {name:'consume used invitation again',file:state,from:'if(inv.consumedAt!==null)',to:'if(false)',test:'worker/test/upload-state.test.js'},
 {name:'accept wrong owner in cached index',file:'worker/src/store.js',from:"file.meta.personId !== 'friend-a' || ",to:'',test:'worker/test/people-store.test.js'},
 {name:'accept wrong revision in cached index',file:'worker/src/store.js',from:' || file.meta.revision !== match[1]',to:'',test:'worker/test/people-store.test.js'},
 {name:'Will falls back to root index',file:'worker/src/handler.js',from:'INDEX_URL: owner.full',to:'INDEX_URL: env.INDEX_URL || DEFAULT_INDEX_URL',test:'worker/test/people.test.js'},
 {name:'remove duplicate ACK transaction recheck',file:state,from:"if(current?.state==='acknowledged' && current.receiptSha256===body.receiptSha256) return [200,identity({activePublication:this.active(o),revision})];",to:'',test:'worker/test/upload-state.test.js'},
 {name:'remove invitation transaction',file:sql,regex:/transactionSync\(fn\)\{if\(txn\).*?finally\{txn=false;\}\}/s,to:'transactionSync(fn){return fn();}',test:'worker/test/upload-state.test.js',pattern:'four separate SQL',schedule:true},
];
const receipt=[];
try{
 // Code only: no caches, real histories or user ZIPs in the copies.
 for(const dir of ['worker/src','worker/test','contracts','lib'])await cp(resolve(root,dir),resolve(temp,dir),{recursive:true});
 await mkdir(resolve(temp,'data'));
 for(const file of ['list-names.source.json','list-names.final.json']) await cp(resolve(root,'data',file),resolve(temp,'data',file));
 await writeFile(resolve(temp,'worker/package.json'),JSON.stringify({type:'module'}));
 const tests=[...new Set(mutations.map(m=>m.test))];
 function run(test,pattern){const env={...process.env};delete env.NODE_TEST_CONTEXT;return spawnSync(process.execPath,['--test','--test-reporter=tap',...(pattern?['--test-name-pattern',pattern]:[]),test],{cwd:temp,env,encoding:'utf8',timeout:30000,maxBuffer:2e6});}
 for(const test of tests){const result=run(test);if(result.status!==0)throw Error('mutation baseline failed: '+test+'\n'+result.stdout+'\n'+result.stderr);}
 for(const m of mutations){
  const path=resolve(temp,m.file),original=await readFile(path,'utf8');
  let prior;
  try{
   if(m.schedule){const sp=resolve(temp,state);prior=await readFile(sp,'utf8');await writeFile(sp,prior.replace("return row ? strictJson(row.doc) : null;","if(table==='invitations') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15); return row ? strictJson(row.doc) : null;"));const control=run(m.test,m.pattern);if(control.status!==0)throw Error('scheduled positive control failed: '+control.stdout);}
   const mutated=m.regex?original.replace(m.regex,m.to):original.replace(m.from,m.to);
   if(mutated===original)throw Error('mutation anchor missing: '+m.name);await writeFile(path,mutated);
   const result=run(m.test,m.pattern);if(result.error || result.signal)throw Error('mutation execution failure: '+m.name+' '+result.error+' '+result.signal);
   const match=/^# fail (\d+)$/m.exec(result.stdout);const failed=match?Number(match[1]):0;
   const killed=result.status!==0 && failed>0;receipt.push({mutation:m.name,killed,failedTests:failed,command:`node --test ${m.pattern?'--test-name-pattern "'+m.pattern+'" ':''}${m.test}`});
  }finally{await writeFile(path,original);if(prior)await writeFile(resolve(temp,state),prior);}
 }
 const out={baselineTests:tests,mutations:receipt,killed:receipt.filter(x=>x.killed).length,survived:receipt.filter(x=>!x.killed).length,scope:'T1; HTTP runtime mutants and T2/T3 controls remain separate acceptance'};
 await mkdir(resolve(root,'.context'),{recursive:true});
 await writeFile(resolve(root,'.context/2026-10-14-upload-mutations.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));if(out.survived)process.exitCode=1;
}finally{await rm(temp,{recursive:true,force:true});}
