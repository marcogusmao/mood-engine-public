#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),P=require('../lib/people'),I=require('../lib/person-input');
async function update({root,privateDir,capturedAt,collectors,http,limits={},clock=Date.now}) {
 const dir=P.privateRoot(root,privateDir);
 const read=(name,fallback)=>{const file=path.join(dir,name);P.noSymlinks(dir,file);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;};
 const h=I.validateHistory(read('history.json',null)), R=require('../lib/person-refresh'), links=[];
 let cache=read('cache/friends.json',{version:1,films:{},users:{},lists:{}});
 if(cache.following && cache.following.user!=='friend-a') throw Error('Following cache owner mismatch');
 if(!h.following && cache.following) h.following=cache.following.users.map(([user,name])=>({user,name}));
 if(h.following) h.following=R.envelope({dataset:'following',items:h.following}).items;
 const identities=read('identities.json',{});
 // Explicit collector injection without HTTP is an offline test/replay boundary. Production always acquires accounts.
 const transport=http||!collectors?R.boundedHttp({http,clock,limits}):null;
 collectors=collectors||R.publicCollectors({capturedAt,clock,links,http:transport});
 const next=await R.refresh(h,{capturedAt,collectors,links,identities,films:cache.films||{}});
 // The build reads this private cache, not history.following. Never seed account histories from shared caches.
 if(next.following?.length || next.coverage.following.state==='complete') {
  cache.following={user:'friend-a',users:next.following.map(r=>[r.user,r.name]),partial:next.coverage.following.state!=='complete',fetchedAt:next.coverage.following.completedAt||null};

 }
 // Incomplete traversals already retain previous following in merge. Prune only
 // against that normalized result, never against the latest observed subset.
 const currentUsers=new Set((next.following||[]).map(r=>r.user));
 cache.users=Object.fromEntries(Object.entries(cache.users||{}).filter(([user])=>currentUsers.has(user)));
 // An old run report can refer to removed accounts; do not misrepresent its
 // counts by filtering its attempts. A new acquisition below emits a fresh one.
 if(cache.followedAcquisition?.attempts.some(r=>!currentUsers.has(r.subjectUser)))delete cache.followedAcquisition;
 if(transport)cache=await R.acquireFollowed(cache,{following:next.following||[],http:transport,capturedAt,clock,maxAccounts:limits.maxAccounts,maxPages:limits.maxPages,maxMetadata:limits.maxMetadata});
 I.write(path.join(dir,'cache/friends.json'),cache);
 const resolve=R.identityResolver({identities,films:cache.films||{},links});
 for(const [uri] of links) {const canonicalUri=resolve(uri);if(canonicalUri) identities[uri]={...identities[uri],canonicalUri};}
 I.write(path.join(dir,'identities.json'),identities);
 I.write(path.join(dir,'history.json'),next);
 I.write(path.join(dir,'coverage.json'),next.coverage);
 return next;
}
if(require.main===module) {
 const args=process.argv.slice(2);
 try {
  if(!P.personArg(args)||args.length!==4||!args.includes('--private-dir')) throw Error('Usage: update-person --person friend-a --private-dir <private-run-dir>');
  update({root:path.resolve(__dirname,'..'),privateDir:args[args.indexOf('--private-dir')+1],capturedAt:new Date().toISOString()}).catch(e=>{console.error(e.message);process.exitCode=1;});
 } catch(e) {console.error(e.message);process.exitCode=1;}
}
module.exports={update};
