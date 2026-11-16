'use strict';
const fs=require('node:fs'),path=require('node:path'),S=require('./schema'),SN=require('./snapshot'),{spawnSync}=require('node:child_process');
function restoreCoverFacts(input,temp){
 const name='lib/cover-facts.json',file=path.join(temp,name);
 require('./paths').noAliases(file,path.resolve(temp));
 fs.writeFileSync(file,input.sourceBytes[name] || JSON.stringify({version:1,items:{}}));
}
// Execute only the reviewed local code. Snapshot-supplied JavaScript is never executed.
function replaySelection(snapshot,root){
 const parent=path.join(root,'.context');fs.mkdirSync(parent,{recursive:true});const temp=fs.mkdtempSync(path.join(parent,'selection-replay-'));
 try{
  for(const name of ['build.js','verify.js','lib','scripts','web','tools'])fs.cpSync(path.join(root,name),path.join(temp,name),{recursive:true});
  fs.mkdirSync(path.join(temp,'.context'));
  const input=snapshot.bodies['inputs.json'];if(input.binarySources!==undefined)require('./binary').rendererIdentity(root,input);const binaries=require('./binary').reader(input,snapshot.dir);for(const name of binaries.names)if(name.startsWith('cache/')){const target=path.join(temp,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,binaries.read(name));}SN.writePrivate(path.join(temp,'.context/replay-rss.json'),input.rss||[]);
  restoreCoverFacts(input,temp);
  for(const [name,raw] of Object.entries(input.sourceBytes)){require('./paths').sourcePath(name);if(!name.startsWith('cache/')&&!name.startsWith('data/letterboxd/')&&!name.startsWith('data/lists/')&&!['config.json','learning.config.json','data/directors-loved.json','data/cannes-critic-prizes.json','data/venice-golden-lion.json','data/berlin-golden-bear.json'].includes(name))continue;const target=path.join(temp,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,raw);}
  {const SRC=require('../synopsis-source'),mubi=path.join(temp,'cache/mubi.json');SRC.clear();if(fs.existsSync(mubi)){const got=SRC.useMubi(mubi);S.assert(got.available,'Frozen MUBI cache cannot be read');}}// the expected descriptions below carry the Our Take the replayed build reads (cache/mubi.json is part of the frozen cache files)
  if(input.effectivePosterState!=null){const state=structuredClone(input.effectivePosterState);for(const [tt,entry] of Object.entries(state.items)){const jpg=path.join(temp,'cache/posters-out',tt+'.jpg');if(fs.existsSync(jpg))entry.s=require('node:crypto').createHash('sha256').update(fs.readFileSync(jpg)).digest('hex');}fs.writeFileSync(path.join(temp,'cache/posters.json'),S.canonical(state));}// the frozen bytes are the drawings the state stands for (lib/posters.js records their sha256)
  const priv=SN.privateDir(path.join(temp,'.context/private'),temp);SN.writePrivate(path.join(priv,'feedback/events.json'),snapshot.bodies['feedback.json']);
  const args=[path.join(temp,'build.js'),'--offline','--cache-only','--private-dir',priv,'--captured-at',snapshot.manifest.capturedAt];
  if(input.effectiveOptions){args.push('--description-separator',input.effectiveOptions.descriptionSeparator);if(input.effectiveOptions.skipPosters)args.push('--skip-posters');if(input.effectiveOptions.skipFriends)args.push('--skip-friends');}
  args.push('--learning','off');
  const wrapper="const deny=()=>{console.error('__REPLAY_NETWORK__');throw new Error('Replay network forbidden');};global.fetch=deny;for(const m of ['http','https']){require(m).get=deny;require(m).request=deny;}require('net').connect=deny;require('net').createConnection=deny;const path=require('path'),base=path.dirname(JSON.parse(process.argv[1])[0]),lb=require(path.join(base,'lib/letterboxd')),load=lb.loadHistory;lb.loadHistory=(dir)=>load(dir,require(path.join(base,'.context/replay-rss.json')));process.argv=[process.execPath,...JSON.parse(process.argv[1])];require(process.argv[1]);";
  const env={...process.env,MOOD_DATE:snapshot.manifest.effectiveDate};delete env.SKIP_RSS;delete env.MUBI_CACHE;delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['-e',wrapper,JSON.stringify(args)],{cwd:temp,env,encoding:'utf8',maxBuffer:1024*1024*10});S.assert(run.status===0,'Selection replay failed: '+run.stderr);S.assert(!run.stderr.includes('__REPLAY_NETWORK__'),'Replay attempted network');
  const plan=snapshot.bodies['baseline.json'].data.plan,toMeta=it=>require('../publish').toMeta(it,{separator:input.effectiveOptions?.descriptionSeparator??input.sources['config.json'].descriptionSeparator??'\n\n'}),expected={};
  for(const row of plan.board)expected['catalog/movie/'+row.id+'.json']={metas:row.items.map(toMeta),cacheMaxAge:10800};
  for(const c of plan.discover)for(const o of c.options)for(const label of new Set([o.label,encodeURIComponent(o.label)]))expected['catalog/movie/'+c.id+'/genre='+label+'.json']={metas:o.items.map(toMeta),cacheMaxAge:10800};
  const actual=Object.fromEntries(SN.filesUnder(path.join(temp,'docs/catalog')).map(p=>[path.relative(path.join(temp,'docs'),p),JSON.parse(fs.readFileSync(p,'utf8'))]));S.assert(S.canonical(actual)===S.canonical(expected),'Frozen selection differs from independent build replay');const frozenIndex=snapshot.bodies['baseline.json'].data.index;
  let indexHash=null;
  if(frozenIndex){
    require('../index-validation').validateIndex(frozenIndex);
    const clean=x=>({...x,meta:{...x.meta,builtAt:null}}),IX=require('../index-export'),decode=require('../index-rows').decode;
    const projections=[{rel:IX.FILE,obj:frozenIndex},...IX.pieces(frozenIndex)];
    for(const p of projections){const got=decode(JSON.parse(fs.readFileSync(path.join(temp,'docs',p.rel),'utf8')));S.assert(S.canonical(clean(got))===S.canonical(clean(p.obj)),'Frozen index projection differs: '+p.rel);}
    indexHash=S.hash(clean(frozenIndex));
  }
  require('./public').verifyPublic(path.join(temp,'docs'));
  const covers={};for(const name of binaries.names)if(name.startsWith('cache/posters-out/')){const rel='posters/'+path.basename(name),published=fs.readFileSync(path.join(temp,'docs',rel));S.assert(require('./binary').digest(published)===binaries.sha(name),'Replayed JPEG differs');covers[rel]=require('./binary').digest(published);}return {catalogs:Object.keys(actual).length,hash:S.hash(actual),covers,indexHash,zeroNetwork:true};
 }finally{require('../synopsis-source').clear();fs.rmSync(temp,{recursive:true,force:true});}
}
module.exports={replaySelection,restoreCoverFacts};
