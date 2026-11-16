'use strict';
// Art only. Exact IMDb matches never alter public facts, ranking or selection.
const CO=require('./countries'),PO=require('./posters');
function fallback(index, linked, movies={}, supplemental=new Map()) {
 const out=new Map(), exact=new Map();
 for(const r of Object.values(movies)){const d=r?.v;if(d?.imdb){const a=exact.get(d.imdb)||[];a.push(d);exact.set(d.imdb,a);}}
 for(const e of index.films){
  const f=linked.get(e.tt), base=f?.imdb===e.tt?{...f,countries:[...(f.countries||[])],lbCountries:[...(f.lbCountries||[])]}:{imdb:e.tt,year:e.year||null,countries:[],language:e.language||null,lbCountries:[...(e.countries||[])],origin:'index-known'};
  const known=()=>CO.pickCountry({tmdb:base.countries,lb:base.lbCountries,lang:base.language});
  for(const [origin,records] of [['cache-imdb',exact.get(e.tt)||[]],['supplemental',[supplemental.get(e.tt)].filter(Boolean)]]){
   if(PO.yearOf(base)&&known())break;
   const same=records.filter(d=>d.imdb===e.tt);
   const signatures=new Set(same.map(d=>JSON.stringify([d.year||null,d.lang||d.language||null,d.countries||[]])));
   if(signatures.size!==1)continue; // absent or conflicting: keep the gap
   const d=same[0];
   if(!PO.yearOf(base)&&PO.yearOf(d))base.year=PO.yearOf(d);
   if(!known()){base.countries=[...(d.countries||[])];base.language=d.lang||d.language||null;base.tmdbOrigin=Array.isArray(d.origin)?[...d.origin]:undefined;base.directors=(d.directors||[]).map(x=>({id:x.id}));}
   base.origin=origin;
   if(!base.poster&&d.poster?.startsWith('/'))base.poster=d.poster;
  }
  out.set(e.tt,base);
 }
 return out;
}
/**
 * The TMDB records a cover may take its facts from: those of the ids the film is known by, and only when the record carries the film's own IMDb id.
 * A record of another title (or with no IMDb id) lent its country and language before 13/10/2026: tt0204394 (The Iceman Cometh) read TMDB 318693 and
 * tt8101850 (Undone) read TMDB 86340, whose flag turned from NL to US with the loan.
 */
function ownRecords(ids, peek, tt){
 return [...new Set(ids.filter(Boolean))].map(id=>peek(id)).filter(d=>d&&d.imdb===tt);
}
function countries(facts, planned){
 const current=t=>({countries:planned.tmdbCountries(t),lbCountries:planned.lbCountries(t),language:planned.language(t),tmdbOrigin:planned.tmdbOrigin?planned.tmdbOrigin(t):undefined,directors:planned.directors?planned.directors(t):[]});
 const get=t=>{const f=current(t);return t.items.length&&CO.pickCountry({tmdb:f.countries,lb:f.lbCountries,lang:f.language})?f:facts.get(t.tt)||f;};
 return {tmdbCountries:t=>get(t).countries||[],lbCountries:t=>get(t).lbCountries||[],language:t=>get(t).language||null,tmdbOrigin:t=>get(t).tmdbOrigin,directors:t=>get(t).directors||[]};
}
module.exports={fallback,countries,ownRecords};
