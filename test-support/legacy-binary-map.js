'use strict';
// The schema-1 shape (every binary inline as base64) of an index returned by lib/learning/binary.js capture(root). Only for the tests that keep
// snapshots written before 13/10/2026 readable; nothing writes this shape any more (a map of 11,103 covers was 575 MB of base64, past V8's string limit).
const fs=require('node:fs'),path=require('node:path');
module.exports=function inline(root,index){return Object.fromEntries(Object.entries(index).map(([name,e])=>[name,{encoding:'base64',length:e.length,sha256:e.sha256,data:fs.readFileSync(path.join(root,name)).toString('base64')}]));};
