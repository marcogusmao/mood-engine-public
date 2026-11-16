(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MoodPerson=factory();})(typeof globalThis==='object'?globalThis:this,function(){
'use strict';
const PERSON='friend-a', REVISION=/^r-[a-f0-9]{32}$/;
function origin(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Upload service is not configured. Ask Marco to configure it.');return url.origin;}
function identity(value){if(!value||value.schemaVersion!==1||value.personId!==PERSON)throw Error('The response belongs to another page.');return value;}
function publication(value){identity(value);if(!REVISION.test(value.revision)||!Number.isFinite(Date.parse(value.publishedAt))||value.pagePath!=='/mood-engine/u/friend-a/'||value.releasePath!==`/mood-engine/u/friend-a/r/${value.revision}/`||value.addonPath!=='/u/friend-a/manifest.json')throw Error('Publication could not be verified.');return value;}
function active(value){if(value?.personId!==undefined&&value.personId!==PERSON||value?.schemaVersion!==undefined&&value.schemaVersion!==1)throw Error('Publication belongs to another page.');return publication({schemaVersion:1,personId:PERSON,...value});}
function publicResponse(value){identity(value);if(value.state==='not_ready'&&!value.activePublication)return null;if(value.state!=='ready'||!value.activePublication)throw Error('Publication could not be verified.');return active(value.activePublication);}
function context(value,revision){identity(value);if(value.letterboxdUser!==PERSON||value.revision!==revision||!REVISION.test(revision)||value.dataBase!=='./data/'||value.addonPath!=='/u/friend-a/manifest.json'||!Number.isFinite(Date.parse(value.inputUpdatedAt))||!value.coverage||typeof value.coverage!=='object')throw Error('Page data does not match its publication.');return value;}
function engine(value,revision){if(!value||value.meta?.personId!==PERSON||value.meta?.revision!==revision)throw Error('Recommendations do not match this page and revision.');return value;}
function coverageText(person){
 const c=person.coverage, source={export:'your export',public:'public Letterboxd pages',mixed:'your export and public Letterboxd pages',unknown:'not available',unavailable:'not available',stale:'previously imported data'};
 const attempt={unavailable:'Public updates are unavailable; your existing data is kept.',partial:'Some public updates are unavailable; existing data is kept where needed.',complete:'Public updates are complete.'};
 return `Export imported ${new Date(person.inputUpdatedAt).toLocaleDateString('en-US')}. History: ${source[c.history]||'not available'}. Likes: ${source[c.likes]||'not available'}. Following: ${source[c.following]||'not available'}.`+(attempt[c.refresh]?' '+attempt[c.refresh]:'');
}
// Public paths are derived from a checked revision; the API cannot nominate another host.
async function load({apiOrigin,fetch,location,publication:active}){
 const base=origin(apiOrigin);
 if(!active){const response=await fetch(base+'/api/v1/friend-a/publication',{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});if(!response.ok)throw Error('Could not check the published page.');active=publicResponse(await response.json());if(!active)return null;}
 publication({schemaVersion:1,personId:PERSON,...active});
 const release=new URL(active.releasePath,location.href);
 const read=async path=>{const r=await fetch(new URL(path,release).href,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});if(!r.ok)throw Error('The published page did not load.');return r.json();};
 const person=context(await read('data/person.json'),active.revision);
 const data=engine(await read('data/engine.json'),active.revision);
 return {person,data,active,manifest:base+'/u/friend-a/manifest.json'};
}
return {PERSON,REVISION,origin,identity,publication,active,publicResponse,context,engine,coverageText,load};
});
