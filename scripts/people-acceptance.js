#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const F=require('../test-support/people/fixture'),I=require('../lib/person-input'),B=require('./build-people'),PUB=require('../lib/people-publication');
async function acceptance({out,date='2026-10-14',capturedAt='2026-10-14T12:00:00.000Z'}){
 out=path.resolve(out);if(fs.existsSync(out))throw Error('Acceptance output already exists');fs.mkdirSync(out,{recursive:true});
 const root=path.join(out,'source');F.sourceCopy(root);
 // Seed only public metadata; the two synthetic owner inputs never copy Marco's history.
 const {projectMetadata}=require('./prepare-person');for(const name of ['tmdb.json','friends.json','lists.json','imdb-ratings.json','mubi.json']){const from=path.join(F.ROOT,'cache',name);if(fs.existsSync(from))F.write(root,'cache/'+name,projectMetadata(name,JSON.parse(fs.readFileSync(from,'utf8'))));}
 const privateDir=path.join(root,'.context/private/friend-a/synthetic');
 const archive=F.zip(root,{row:'Paterson',year:2016,uri:'https://boxd.it/fWkQ'});
 const h=I.importArchive({root,privateDir,archive,capturedAt,requestId:'11111111-1111-4111-8111-111111111111'});
 // Marco marks the same film as watchlist, Will has watched/rated/liked it.
 const head='Date,Name,Year,Letterboxd URI';
 for(const [n,text] of Object.entries({'watched.csv':head+'\n','ratings.csv':head+',Rating\n','watchlist.csv':head+'\n2026-10-01,Paterson,2016,https://boxd.it/fWkQ\n','diary.csv':head+',Rating,Rewatch,Tags,Watched Date\n'}))F.write(root,'data/letterboxd/'+n,text);
 const revision='r-'+'1'.repeat(32),codeSha='a'.repeat(40),will=path.join(out,'will'),marco=path.join(out,'marco');
 const result=B.buildWill({root,privateDir,outDir:will,revision,capturedAt,date});F.write(out,'will-build.log',result.log);
 B.runBuild(root,['--offline','--cache-only','--skip-posters','--out',marco,'--captured-at',capturedAt,'--date',date]);
 const descriptor=PUB.stamp({dir:will,revision,codeSha,builtAt:capturedAt,history:h});
 const before=I.canonical(PUB.fileManifest(marco));
 const snapshot=I.snapshot({root,privateDir,sourceRequestId:h.sourceRequestId,codeSha,capturedAt,selectionDate:date});
 fs.writeFileSync(path.join(privateDir,'sealed-package.json'),snapshot,{mode:0o600});
 const fresh=path.join(root,'.context/private/friend-a/fresh-runner');I.restore({root,privateDir:fresh,bytes:snapshot});
 const replay=path.join(out,'replay');B.buildWill({root,privateDir:fresh,outDir:replay,revision,capturedAt,date});PUB.stamp({dir:replay,revision,codeSha,builtAt:capturedAt,history:h});const replayFiles=PUB.fileManifest(replay),willFiles=PUB.fileManifest(will);if(I.canonical(replayFiles)!==I.canonical(willFiles)){const map=new Map(willFiles.map(f=>[f.path,f.sha256]));const changed=replayFiles.filter(f=>map.get(f.path)!==f.sha256).map(f=>f.path);throw Error('REPLAY_MISMATCH '+changed.length+' files: '+changed.slice(0,3).join(', '));}
 // A last-good public release is reconstructed exclusively from its receipt and public bytes.
 const restored=path.join(out,'restored-public');await PUB.restorePublic({descriptor,dir:restored,fetchBytes:async(name,cap)=>{const b=fs.readFileSync(path.join(will,name));if(b.length>cap)throw Error('Fetch cap exceeded');return b;}});
 // UI assets are separate deliverables. Do not synthesize their successful delivery.
 const webDir=path.join(F.ROOT,'web');const missing=['person.js','upload.js'].filter(n=>!fs.existsSync(path.join(webDir,n)));
 if(!missing.length)PUB.compose({marcoDir:marco,willDir:will,outDir:path.join(out,'public'),webDir});
 assert.equal(I.canonical(PUB.fileManifest(marco)),before);
 const receipt={synthetic:true,productionBuilds:3,parser:true,snapshotBytes:snapshot.length,freshRunnerReplay:true,publicRestore:true,marcoPreservedDuringComposition:true,descriptor,aggregate:missing.length?'blocked_missing_ui_assets':'validated',missingUiAssets:missing};
 fs.writeFileSync(path.join(out,'assertions.json'),I.canonical(receipt));console.log(JSON.stringify(receipt));if(missing.length)throw Error('INTEGRATION_BLOCKED_MISSING_UI_ASSETS');return receipt;
}
if(require.main===module){const args=process.argv.slice(2),opt=k=>args[args.indexOf(k)+1];acceptance({out:opt('--out'),date:opt('--date'),capturedAt:opt('--captured-at')}).catch(e=>{console.error(e.message);if(e.buildOutput){const out=opt('--out');fs.writeFileSync(path.join(out,'failed-build.log'),e.buildOutput);}process.exitCode=1;});}
module.exports={acceptance};
