'use strict';
// Explicit allowlist of the public fields, required by the execution amendment: a field enters it only by a dated decision of Marco's
// written next to it (cv and lw: 11/10/2026, below), never because a build happens to produce it.
const S=require('./schema'),{findLeaks}=require('../guard'),{guardRows}=require('../plan');
// Marco, 11/10/2026 (catalog expansion): cv (1 = in a critic or director list: no 3.5 floor) and lw (0–1, how much Marco agrees with the film's lists) are the picker's.
const FILM=['t','i','n','y','r','p','b','o','d','g','l','va','vc','f','h','ts','q','w','pins','why','seed','rating','last','lb','fr','cv','lw'];
// Marco, 14/10/2026 (Will onboarding, PRODUCT.md): only public owner + reserved revision,
// never the request id, source hash, credentials or private collection metadata.
const TOP=['generated','today','moods','stats','fingerprint','tonight','films','rewatch','friends','lists','schemaVersion','buildId','policyId','feedbackIncludedAt','meta'];
function personMeta(value){S.keys(value,['personId','revision']);S.assert(value.personId==='friend-a'&&typeof value.revision==='string'&&/^r-[a-f0-9]{32}$/.test(value.revision),'Invalid public person identity');return {personId:value.personId,revision:value.revision};}
function allow(o,ks){S.keys(o,ks,[]);const result={};for(const k of ks)if(o[k]!==undefined)result[k]=o[k];return result;}
function scalar(v){S.assert(v===null||['string','number','boolean'].includes(typeof v),'Expected scalar');S.assert(typeof v!=='number'||Number.isFinite(v),'Nonfinite public number');return v;}
function scalars(a){S.assert(Array.isArray(a),'Expected array');return a.map(scalar);}
// lw is public (Marco, 11/10/2026) as the build writes it: a number in (0, 1] with at most two decimals (build.js through lib/list-signal.js
// publicWeight: rounded to two decimals first, and omitted when the ROUNDED number is 0, so a weight in (0, 0.005) never reaches this check).
// Anything else (0, a negative, above 1, a string, an unrounded agreement weight) is refused rather than published.
function listWeight(v){S.assert(typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1,'Invalid lw: must be in (0, 1]');S.assert(Math.round(v*100)/100===v,'Invalid lw: at most two decimals');return v;}
function film(x){if(x&&x.lw!==undefined)listWeight(x.lw);const out=allow(x,FILM);for(const k of Object.keys(out)){if(['f','h'].includes(k)){out[k]=allow(out[k],S.MOODS);for(const m of Object.keys(out[k]))out[k][m]=k==='h'?scalars(out[k][m]):scalar(out[k][m]);}else if(['d','g','pins','why'].includes(k))out[k]=scalars(out[k]);else out[k]=scalar(out[k]);}S.filmId(out.i);return out;}
function projection(data){const out=allow(data,TOP);if(data.meta!==undefined)out.meta=personMeta(data.meta);out.moods=(data.moods||[]).map(x=>{const r=allow(x,['id','name','word','blurb','season','minRuntime']);for(const k of Object.keys(r))r[k]=Array.isArray(r[k])?scalars(r[k]):scalar(r[k]);return r;});out.stats=allow(data.stats||{},['watched','rated','watchlist','candidates']);for(const v of Object.values(out.stats))scalar(v);if(data.fingerprint){out.fingerprint=allow(data.fingerprint,['mean','rated','directors','cast','keywords','languages','decades','coldGenres']);for(const k of ['mean','rated'])scalar(out.fingerprint[k]);for(const k of ['directors','cast','keywords','languages','decades','coldGenres'])out.fingerprint[k]=(out.fingerprint[k]||[]).map(x=>{const p=allow(x,['label','avg','n','w','films']);for(const key of Object.keys(p))p[key]=key==='films'?scalars(p[key]):scalar(p[key]);return p;});}out.tonight=scalars(data.tonight||[]);out.films=(data.films||[]).map(film);out.rewatch=(data.rewatch||[]).map(film);if(data.friends){out.friends=allow(data.friends,['rows','people']);out.friends.rows=data.friends.rows.map(r=>{const x=allow(r,['id','name','word','kind','items']);for(const k of ['id','name','word','kind'])if(x[k]!==undefined)scalar(x[k]);x.items=r.items.map(item=>{const p=allow(item,['i','n','y','w']);Object.values(p).forEach(scalar);S.filmId(p.i);return p;});return x;});out.friends.people=data.friends.people.map(p=>{const x=allow(p,['name','read','rated','withTt','watchlist']);Object.values(x).forEach(scalar);return x;});}out.lists=(data.lists||[]).map(l=>{const x=allow(l,['id','name','total','unseen','items']);for(const k of ['id','name','total','unseen'])scalar(x[k]);x.items=l.items.map(i=>{const p=allow(i,['i','n','y','w']);Object.values(p).forEach(scalar);S.filmId(p.i);return p;});return x;});for(const k of ['generated','today','schemaVersion','buildId','policyId','feedbackIncludedAt'])if(out[k]!==undefined)scalar(out[k]);return out;}
function publicRows(data){const convert=x=>({id:x.i,tmdb:x.t,title:x.n,year:x.y});const rows={'web-new':(data.films||[]).map(convert),oldfriends:(data.rewatch||[]).map(convert)};for(const r of data.friends?.rows||[])rows['web-friend-'+r.id]=r.items.map(convert);for(const l of data.lists||[])rows['web-list-'+l.id]=l.items.map(convert);return rows;}
function validatePublication(plan,data,seen,privacy=null){
if(privacy){assertPrivateAbsent(plan,privacy);assertPublicData(data,privacy);}
// Marco, 13/10/2026 (the description's first lines, lib/describe.js): countries (the film's main countries, English names) and cast (the first five names of the TMDB cast) are public TMDB facts the plan items carry.
// Marco, 20/10/2026 (description v3): `keywords` (the film's mood words, lower case, up to four: build.js copies them from the index; never TMDB's raw keywords) is another, `moodIsRow` (true) says that `mood` holds the name of a row that is not a mood, and `leadsWithReason` (the kind of the reason that opens line 2: "loved", "pick", "pair", "want", "watched", "prize" or "actor"; lib/plan.js REASON_ROWS) that the row's meaning is the reason (Loved by your directors, Friends loved, the friends' and the prize rows).
const ITEM=['id','tmdb','slug','canon','title','originalTitle','year','runtime','genres','directors','countries','cast','keywords','fitMood','poster','va','vc','why','overview','mood','moodIsRow','leadsWithReason','loved','trust','lbDigits','ratings'];
for(const list of Object.values(guardRows(plan)))for(const item of list){allow(item,ITEM);for(const k of Object.keys(item))if(k==='ratings'){ratings(item[k]);}else if(k==='lbDigits'){S.assert([1,2].includes(item[k]),'Invalid lbDigits');}else if(['genres','directors','countries','cast','keywords','why'].includes(k))scalars(item[k]);else if(item[k]!==undefined)scalar(item[k]);}
const projected=projection(data);if(seen){const leaks=findLeaks({...guardRows(plan),...publicRows(projected)},seen);S.assert(!leaks.length,'Seen films leaked into publication: '+leaks.slice(0,3).join(', '));} // incumbent direct publishers without seen context remain supported; builds always supply it.
return projected;}
function validateWorkerIndex(rows,seen){S.assert(seen,'Worker index requires guard context');const leaks=findLeaks(rows,seen);S.assert(!leaks.length,'Seen films leaked into Worker index');return true;}
function jpeg(bytes){S.assert(Buffer.isBuffer(bytes)&&bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217,'Invalid JPEG bytes');return true;}
function ratings(value){const r=allow(value,['lb','imdb','friendsAvg','seenBy','wantBy']);for(const k of ['lb','imdb','friendsAvg'])S.assert(r[k]===null||(typeof r[k]==='number'&&Number.isFinite(r[k])&&r[k]>=0&&r[k]<=(k==='imdb'?10:5)),'Invalid rating');for(const k of ['seenBy','wantBy'])S.assert(Number.isInteger(r[k])&&r[k]>=0,'Invalid rating count');return r;}
// The public files by name. A new family of files enters here, with a dated decision of Marco's written next to it, or verify-public refuses the whole
// night's publication. The legacy index family is listed by name, so a file nobody planned (data/index-anything.json) is refused too.
const PUBLIC_FIXED=['.nojekyll','index.html','manifest.json','data/engine.json','assets/selector.js','assets/feedback.js','assets/feedback-core.js','assets/person.js','assets/upload.js','data/person.json','publication.json','files.json',
 'data/film-languages.json'/* Marco, 12/10/2026: the original language of each film, cut out of the index for the Worker's /subtitles (lib/index-export.js languagesFile; verify.js checks it against the index) */];
// Marco, 20/10/2026, film page §9: public compact movie facts in exactly 100 shards.
const PUBLIC_PATTERNS=[/^data\/page-\d{2}\.json$/,/^catalog\/movie\/[^/]+(?:\/genre=[^/]+)?\.json$/,
 /^data\/index(?:-(?:board|moods|friends|directors)|-list-[A-Za-z0-9_-]+)?\.json$/, // the legacy index family (the 3.1.0 Worker and the profiles read it)
 new RegExp(`^data\\/index-v2(?:-${require('../board-shared').ROW_ID_SOURCE})?\\.json$`) /* Marco, 13/10/2026: the v2 family of the 54-row Board (lib/board.js): index-v2, -menus, -row-<id>, -mood-<id>; ids are lower case words joined by hyphens */];
const isPublicFile=rel=>PUBLIC_FIXED.includes(rel)||PUBLIC_PATTERNS.some(p=>p.test(rel));
function verifyPublic(dir,privacy=null){
 const fs=require('fs'),path=require('path');
 const data=JSON.parse(fs.readFileSync(path.join(dir,'data/engine.json'),'utf8'));projection(data);
 if(['data/person.json','publication.json','files.json'].some(f=>fs.existsSync(path.join(dir,f))))require('../people-publication').verifyRelease(dir,{skipPublic:true});
 const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{S.assert(!e.isSymbolicLink(),'Symlink in public output');return e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)];});
 require('./paths').noAliases(dir,path.resolve(dir));
 const files=walk(dir),referenced=new Set();
 const full=path.join(dir,'data/index.json');
 if(fs.existsSync(full)){
  const checked=require('../../verify').verifyIndex(dir);S.assert(checked.ok,'Public index invalid: '+checked.problems.join('; '));
  const index=require('../index-rows').decode(JSON.parse(fs.readFileSync(full,'utf8')));
  for(const tt of require('./plan-posters').indexIds(index))referenced.add(tt);
 }else S.assert(!files.some(f=>/^data\/index(?:-[A-Za-z0-9_-]+)?\.json$/.test(path.relative(dir,f))),'Index chunk without full index');
 if(!fs.existsSync(path.join(dir,'data/index-v2.json')))S.assert(!files.some(f=>/^data\/page-/.test(path.relative(dir,f))),'Orphan pages without v2');
 const full2=path.join(dir,'data/index-v2.json'); // the v2 family (Marco, 13/10/2026): its covers are referenced too, and it stands only with its whole index
 if(fs.existsSync(full2)){const index2=require('../index-rows').decode(JSON.parse(fs.readFileSync(full2,'utf8')));for(const tt of require('./plan-posters').indexIds(index2))referenced.add(tt);}
 else S.assert(!files.some(f=>/^data\/index-v2-/.test(path.relative(dir,f))),'v2 index chunk without index-v2.json');
 for(const file of files)if(path.relative(dir,file).startsWith('catalog/movie/')){const body=JSON.parse(fs.readFileSync(file,'utf8'));for(const meta of body.metas||[]){const match=typeof meta.poster==='string'&&meta.poster.match(/\/posters\/(tt\d+)\.jpg(?:\?v=[0-9a-f]{8})?$/);if(match){S.assert(match[1]===meta.id,'Poster identity mismatch');referenced.add(match[1]);}}}
 for(const file of files){const rel=path.relative(dir,file),parts=rel.split(path.sep);
  if(/^posters\/tt\d+\.jpg$/.test(rel)){const tt=path.basename(file,'.jpg');S.assert(referenced.has(tt),'Unreferenced poster');const bytes=fs.readFileSync(file);jpeg(bytes);if(privacy)for(const text of jpegMetadata(bytes))assertPrivateAbsent(text,privacy);continue;}
  S.assert(isPublicFile(rel),'Unexpected public output file');
  if(privacy){if(rel.endsWith('.json'))assertPublicJson(fs.readFileSync(file,'utf8'),privacy,rel==='data/engine.json');else assertPrivateAbsent(fs.readFileSync(file,'utf8'),privacy);}
  S.assert(!parts.some(p=>['feedback','snapshots','models','learning-private'].includes(p))&&!['experience.json','embeddings.json','web-personal.json','events.json','manifest.private.json'].includes(path.basename(file)),'Private artifact in public output');
 }
 for(const tt of referenced)S.assert(fs.existsSync(path.join(dir,'posters',tt+'.jpg')),'Missing local poster');
 const verification=require('../../verify').verifyDir(dir);S.assert(verification.ok,'Public catalogs invalid: '+verification.problems.join('; '));return true;
}
module.exports={projection,publicRows,validatePublication,validateWorkerIndex,verifyPublic,isPublicFile};

// Bounded exact-string guard against the actual new private corpus. Short enums and
// strings already present in incumbent source inputs are not private provenance.
function privacyContext(dir,legacyInputs={},publicGenerated=null){
 if(publicGenerated!==null)S.iso(publicGenerated);
 const fs=require('node:fs'),path=require('node:path'),terms=new Set(),legacy=new Set();function collectLegacy(x){if(typeof x==='string')legacy.add(x);else if(Array.isArray(x))x.forEach(collectLegacy);else if(x&&typeof x==='object')Object.values(x).forEach(collectLegacy);}collectLegacy(legacyInputs);
 function visit(x){if(typeof x==='string'){if(x.length>=16&&x.length<=65536&&!legacy.has(x))terms.add(x);}else if(Array.isArray(x))x.forEach(visit);else if(x&&typeof x==='object')Object.values(x).forEach(visit);}
 if(dir){const files=require('./snapshot').filesUnder(dir).filter(p=>!p.includes(path.sep+'snapshots'+path.sep)&&p.endsWith('.json'));let bytes=0;for(const p of files){require('./paths').privateTarget(p);bytes+=fs.statSync(p).size;S.assert(bytes<=64*1024*1024,'Private validation corpus exceeds 64 MiB');visit(JSON.parse(fs.readFileSync(p,'utf8')));}}
 S.assert(terms.size<=200000,'Private validation corpus too large');const list=[...terms];return {publicGenerated,terms:list,patterns:Array.from({length:Math.ceil(list.length/500)},(_,i)=>new RegExp(list.slice(i*500,(i+1)*500).flatMap(s=>[s,JSON.stringify(s).slice(1,-1)]).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'u'))};
}
// Only the independently supplied build clock is public at this exact field.
// The same bytes in a reason, title, other field or asset still fail the scan.
function assertPublicData(data,context){
 const scanned={...data};
 if(context.publicGenerated!==null&&context.publicGenerated!==undefined&&data.generated===context.publicGenerated){S.iso(data.generated);delete scanned.generated;}
 return assertPrivateAbsent(scanned,context);
}
function assertPublicJson(raw,context,engine=false){
 const data=JSON.parse(raw),tokens=raw.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)||[];
 let pos=0;const strings=[],generated=[];
 function value(depth,key){const token=tokens[pos++];if(token==='{'){while(tokens[pos]!=='}'){const k=JSON.parse(tokens[pos++]);strings.push({text:k});pos++;const entry=value(depth+1,k);if(depth===0&&k==='generated')generated.push(entry);if(tokens[pos]===',')pos++;else break;}pos++;}
 else if(token==='['){while(tokens[pos]!==']'){value(depth+1,null);if(tokens[pos]===',')pos++;else break;}pos++;}
 else if(token?.startsWith('"')){const entry={text:JSON.parse(token),index:pos-1};strings.push(entry);return entry;}}
 value(0,null);
 const exempt=engine&&generated.length===1&&generated[0]?.text===context.publicGenerated?generated[0]:null;
 if(exempt)S.iso(exempt.text);
 for(const entry of strings)if(entry!==exempt)assertPrivateAbsent(entry.text,context);
 if(engine&&generated.length===1)assertPublicData(data,context);else assertPrivateAbsent(data,context);
 // Preserve a raw-byte scan as well, excluding only the one validated root value.
 if(exempt)tokens[exempt.index]='null';
 return assertPrivateAbsent(tokens.join(' '),context);
}
// Read only COM and APP payloads. Entropy-coded pixels are never decoded as text.
function jpegMetadata(bytes){
 const out=[];let at=2;
 while(at<bytes.length){S.assert(bytes[at++]===255,'Invalid JPEG marker');while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===0xd9){S.assert(at===bytes.length,'Unexpected JPEG trailing bytes');break;}if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
 S.assert(at+2<=bytes.length,'Invalid JPEG segment');const length=bytes.readUInt16BE(at);S.assert(length>=2&&at+length<=bytes.length,'Invalid JPEG segment');
 if(marker===0xfe||(marker>=0xe0&&marker<=0xef)){const payload=bytes.subarray(at+2,at+length);out.push(payload.toString('utf8'));for(const offset of [0,1]){const even=payload.subarray(offset,offset+Math.floor((payload.length-offset)/2)*2);out.push(even.toString('utf16le'));const swapped=Buffer.from(even);swapped.swap16();out.push(swapped.toString('utf16le'));}}
 at+=length;
 if(marker===0xda){while(at<bytes.length){if(bytes[at]!==255){at++;continue;}const next=bytes[at+1];if(next===0||(next>=0xd0&&next<=0xd7)){at+=2;continue;}break;}}
 }
 return out;
}
function assertPrivateAbsent(value,context){const text=typeof value==='string'?value:S.canonical(value);if(context.patterns)for(const pattern of context.patterns)S.assert(!pattern.test(text),'New private content in public output');else for(const term of context.terms)S.assert(!text.includes(term)&&!text.includes(JSON.stringify(term).slice(1,-1)),'New private content in public output');return true;}
module.exports.privacyContext=privacyContext;module.exports.assertPrivateAbsent=assertPrivateAbsent;

module.exports.jpeg=jpeg; module.exports.ratings=ratings;
