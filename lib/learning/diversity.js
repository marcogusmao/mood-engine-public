'use strict';
const {dot}=require('./models'),S=require('./schema');
function percentiles(items){const values=items.map(x=>x.score).sort((a,b)=>a-b),ranks=new Map();for(let i=0;i<values.length;){let j=i+1;while(j<values.length&&values[j]===values[i])j++;ranks.set(values[i],values.length>1?(i+(j-i-1)/2)/(values.length-1):.5);i=j;}return items.map(x=>ranks.get(x.score));}
function similarity(a,b){if((a.representationId||null)!==(b.representationId||null))return null;if(a.sparseVector&&b.sparseVector)return Object.entries(a.sparseVector).reduce((sum,[key,v])=>sum+v*(b.sparseVector[key]||0),0);if(a.vector&&b.vector&&a.vector.length===b.vector.length)return dot(a.vector,b.vector);return null;}
function mmr(items,lambda=.8,{editorial=false,maxPerDirector=2,limit=items.length}={}){
 S.assert(Number.isFinite(lambda)&&lambda>=0&&lambda<=1,'Invalid MMR lambda');
 if(editorial||lambda===1)return {items:items.slice(0,limit),missingPairs:0,shortfall:Math.max(0,limit-items.length)};
 const rel=percentiles(items),selected=[],remaining=items.map((x,i)=>({x,i,sim:0,compared:0})),counts=new Map();let missingPairs=0;
 while(remaining.length&&selected.length<limit){let best=null;for(const c of remaining){const dirs=c.x.directors||c.x.film?.directors?.map(d=>d.id)||[];if(dirs.some(d=>(counts.get(d)||0)>=maxPerDirector))continue;
  for(const p of selected.slice(c.compared)){const value=similarity(c.x,p.x);if(value===null)missingPairs++;else c.sim=Math.max(c.sim,Math.max(0,value));}c.compared=selected.length;
  const value=lambda*rel[c.i]-(1-lambda)*c.sim;if(!best||value>best.value||value===best.value&&(c.i<best.i||c.i===best.i&&c.x.filmId<best.x.filmId))best={...c,value};
 }if(!best)break;selected.push(best);for(const d of best.x.directors||best.x.film?.directors?.map(d=>d.id)||[])counts.set(d,(counts.get(d)||0)+1);remaining.splice(remaining.findIndex(c=>c.i===best.i),1);}
 return {items:selected.map(x=>x.x),missingPairs,shortfall:Math.max(0,limit-selected.length)};
}
const BOARD_RECOMMENDATIONS=new Set(['tonight','lift','escape','reinvent','letin','night','wicked','wander','slow','music','fromlists','short','because','newforyou','directors','directors-loved']); // directors-loved: a generated row (Q filters it), review S4-7 11/10/2026
function boardCap(rows,cap=2){const counts=new Map(),shortfall={};const result=rows.map(row=>{if(!BOARD_RECOMMENDATIONS.has(row.id))return {...row,items:row.items.slice()};const items=row.items.filter(x=>{const id=x.filmId||x.id;if((counts.get(id)||0)>=cap)return false;counts.set(id,(counts.get(id)||0)+1);return true;});shortfall[row.id]=row.items.length-items.length;return {...row,items};});return {rows:result,shortfall};}
module.exports={percentiles,mmr,boardCap,BOARD_RECOMMENDATIONS};
