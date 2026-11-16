#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const CASES=[
 {name:"remove normalized input owner check",file:"lib/person-input.js",from:"||h.personId!=='friend-a'",to:"",test:"test/person-input.test.js"},
 {name:'bypass deployed receipt verification',file:'scripts/ack-will-publication.js',from:"if(I.sha(receipt)!==descriptor.receiptSha256)",to:'if(false)',test:'test/people-publication.test.js'},
 {name:'accept cross-person feedback',file:'lib/learning/feedback.js',from:"assert(value.personId===personId,'Feedback owner mismatch');",to:'',test:'test/people-feedback.test.js'},
 {name:'accept snapshot content hash drift',file:'lib/person-input.js',from:"if(b.length!==f.bytes||sha(b)!==f.sha256)",to:'if(false)',test:'test/person-input.test.js'},
 {name:'remove export values after partial public read',file:'lib/person-refresh.js',from:"if(evidence.state==='complete')h[k]=structuredClone(result.items);",to:"if(true)h[k]=structuredClone(result.items);",test:'test/person-refresh.test.js'},
 {name:'allow private file in cache-update artifact',file:'scripts/verify-artifact-boundaries.js',from:"if(!CACHE.includes(rel)&&!/^flags\\/[a-z]{2}\\.png$/.test(rel))",to:'if(false)',test:'test/people-workflow.test.js'},
 {name:'skip actual inflated stream byte ceiling',file:'scripts/validate-letterboxd-export.py',from:"need(actual<=cap and retained<=32*1024*1024 and actual<=100*x.compress_size,'ZIP_INFLATED_LIMIT');",to:'',python:true}
];
function run(){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'people-mutations-'))),results=[];try{
 for(const name of ['lib','scripts','test','test-support','web','people.json','config.json','learning.config.json','verify.js','build.js','.github'])fs.cpSync(path.join(ROOT,name),path.join(dir,name),{recursive:true});
 for(const c of CASES){const file=path.join(dir,c.file),original=fs.readFileSync(file,'utf8');if(original.split(c.from).length!==2)throw Error('Mutation anchor mismatch: '+c.name);
 const args=c.python?['-B','-m','unittest','discover','-s','test','-p','letterboxd_export_test.py']:['--test',c.test];const bin=c.python?'python3':process.execPath;
 const control=spawnSync(bin,args,{cwd:dir,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});if(control.status!==0)throw Error('Positive control failed for '+c.name+': '+control.stdout+control.stderr);
 fs.writeFileSync(file,original.replace(c.from,c.to));let mutated;try{mutated=spawnSync(bin,args,{cwd:dir,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});}finally{fs.writeFileSync(file,original);}
 const detected=mutated.status!==null&&mutated.status!==0&&/not ok|FAILED/.test(mutated.stdout+mutated.stderr);results.push({mutation:c.name,controlExit:control.status,mutantExit:mutated.status,detected});
 }
 console.log(JSON.stringify({detected:results.filter(r=>r.detected).length,survived:results.filter(r=>!r.detected).length,results}));if(results.some(r=>!r.detected))process.exitCode=1;return results;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}}
if(require.main===module)run();module.exports={CASES,run};
