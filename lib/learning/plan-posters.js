'use strict';
function publishedIds(plan, index = null) {
 const ids = new Set();
 for (const items of [...require('../plan').boardRows(plan).map(r=>r.items), ...plan.discover.flatMap(c=>c.options.map(o=>o.items))])
  for (const it of items) if (typeof it.poster === 'string' && /\/posters\/tt\d+\.jpg(?:\?v=[0-9a-f]{8})?$/.test(it.poster)) {
   const tt = it.poster.match(/\/(tt\d+)\.jpg(?:\?v=[0-9a-f]{8})?$/)[1];
   if (tt !== it.id) throw new Error('Poster identity mismatch');
   ids.add(tt);
  }
 if(index){require("../index-validation").validateIndex(index);for(const tt of indexIds(index))ids.add(tt);}
 return ids;
}
// Precondition: index structure has passed the shared validator.
function indexIds(index){const ids=new Set();for(const e of index.films){const match=typeof e.poster==='string'&&e.poster.match(/\/posters\/([^/?#]+)\.jpg(?:\?v=[0-9a-f]{8})?$/);if(match){if(!/^tt\d+$/.test(match[1])||match[1]!==e.tt)throw Error('Poster identity mismatch');ids.add(e.tt);}}return ids;}
module.exports = {publishedIds,indexIds};
