'use strict';
// Private experiment only. The production pool and its z-scores are never modified.
const S=require('./schema'),T=require('../taste'),U=require('../util'),M=require('../moods'),F=require('./feedback'),C=require('./candidates');
const {legacyConfig}=require('../board-shared'); // Marco, 14/10/2026 (PR5): config.json "moods" holds the 21 moods of the v2 family too; the experiment replays the legacy rows, so only the nine of board.legacyMoods
const recommendations=new Set(['tonight',...S.MOODS,'fromlists','short','because','newforyou','directors']);
function freezeRows(candidates,history,cfg,date,events,layout,qualityRatings=null,capturedAt=date+'T12:00:00.000Z'){
 const model=T.learn(history.filter(r=>r.film&&r.rating!=null)),moods=M.compile(legacyConfig(cfg).moods,cfg.lists),state=F.project(events,capturedAt);
 const trusted=new Set([...model.stats.values()].filter(s=>s.type==='director'&&s.n>=2&&s.w>.15).sort((a,b)=>b.w-a.w).slice(0,cfg.build.directors).map(s=>Number(s.key.slice(2))));
 const pool=candidates.filter(c=>c.film).map(c=>({...c,taste:c.film.personalScoreAvailable===false?null:T.score(c.film,model).score,quality:U.bayes(c.film.va,c.film.vc)}));
 U.zscore(pool.filter(c=>c.taste!==null),c=>c.taste,(c,v)=>c.tasteZ=v);U.zscore(pool,c=>c.quality,(c,v)=>c.qualityZ=v);
 return layout.map(row=>{
  if(!recommendations.has(row.id))return {id:row.id,limit:row.items.length,editorial:true,items:row.items.map((x,i)=>({filmId:x.id,film:null,score:row.items.length-i}))};
  const mood=moods.find(m=>m.id===row.id),sr=cfg.shortRow||{};
  const filtered=pool.filter(c=>{
   if(qualityRatings&&!require("../recommendation-quality").qualifies(qualityRatings.get(c.filmId)))return false;
   if(!C.eligible(c,{feedback:state,moodId:mood?.id,timeLimit:row.id==='short'?sr.maxMinutes??95:null}))return false;
   const film=c.film,sources=c.sources||[];
   const inLists={lists:sources.filter(s=>s.kind==='list').map(s=>s.sourceId)}; // a list may be a mood's signal (lib/moods.js)
   if(mood)return M.fit(film,mood,inLists).ok;
   if(row.id==='tonight')return moods.some(m=>F.eligible(state,c.filmId,{moodId:m.id})&&M.fit(film,m,inLists).ok);
   if(row.id==='short')return film.runtime>=(sr.minMinutes??40);
   if(row.id==='fromlists')return sources.some(s=>s.kind==='list');
   if(row.id==='because')return sources.some(s=>s.kind==='recommendations');
   if(row.id==='directors')return film.directors?.some(d=>trusted.has(d.id));
   if(row.id==='newforyou')return film.year>=Number(date.slice(0,4))-1||sources.some(s=>s.kind==='popular');
   return true;
  }).map(c=>{let score=(c.tasteZ||0)+.7*(c.qualityZ||0);if(mood)score=1.1*Math.min(M.fit(c.film,mood,{lists:(c.sources||[]).filter(s=>s.kind==='list').map(s=>s.sourceId)}).norm,1.6)+(c.tasteZ||0)+.55*(c.qualityZ||0);if(row.id==='directors')score=(c.qualityZ||0)+.5*(c.tasteZ||0);if(row.id==='fromlists')score+=.5*Math.log2(new Set(c.sources.filter(s=>s.kind==='list').map(s=>s.sourceId)).size);return {filmId:c.filmId,film:c.film,score};}).sort((a,b)=>b.score-a.score||(a.filmId<b.filmId?-1:1));
  const limit=mood?cfg.sizes.discover:cfg.sizes[row.id]??cfg.sizes.row;
  return {id:row.id,limit,editorial:false,items:filtered};
 });
}
module.exports={freezeRows,recommendations};
