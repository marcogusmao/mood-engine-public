'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const PO=require('../lib/posters'),IX=require('../lib/index-export');
test('review: confirmed art year wins over a year carried by unconfirmed index metadata',()=>{
 const index={films:[{tt:'tt1',year:1999}]},facts=new Map([['tt1',{imdb:'tt1',year:1963,countries:['SE'],language:'sv'}]]);
 const targets=PO.collectTargets({board:[],discover:[]},{index,coverFacts:facts});
 a.equal(targets.get('tt1').year,1963);a.equal(index.films[0].year,1999);
});
test('review: a renderer exception after changing an item restores the original plan URL',async()=>{
 const plan={board:[{id:'x',items:[{id:'tt1',title:'Fixture',year:2000,poster:'/original.jpg'}]}],discover:[]};
 const index=IX.buildIndex({cfg:{addon:{version:'1'},moods:[]},today:'2026-10-12',plan});
 const code=fs.readFileSync(path.join(__dirname,'../build.js'),'utf8').split('async function coverStep(')[1].split('\n/**')[0];
 const run=vm.runInNewContext('(async function coverStep('+code+')',{
  PO:{...PO,drawCovers:async()=>{plan.board[0].items[0].poster=PO.posterUrl(null,'tt1');throw Error('state write failed');}},
  CO:{attachCountries:()=>({unknownLanguages:{}})},SKIP_POSTERS:false,CACHE_ONLY:true,COVER_RECEIPT:'/receipt-fixture.json',process:{env:{}},CACHE_DIR:'/cache',ROOT:path.resolve(__dirname,'..'),cfg:{},today:'2026-10-12',path,log:()=>{},require:()=>({}),
 });
 a.equal(await run({plan,index,coverFacts:new Map(),countries:{}}),null);a.equal(plan.board[0].items[0].poster,'/original.jpg');
});
test('review: receipt EACCES cannot discard already rendered covers or leave uncopied local URLs',async()=>{
 const plan={board:[{id:'x',items:[{id:'tt1',title:'Fixture',year:2000,poster:'/original.jpg'}]}],discover:[]};
 const index=IX.buildIndex({cfg:{addon:{version:'1'},moods:[]},today:'2026-10-12',plan});
 const code=fs.readFileSync(path.join(__dirname,'../build.js'),'utf8').split('async function coverStep(')[1].split('\n/**')[0],logs=[];
 const resultObject={stats:{mb:0},tts:new Set(['tt1']),receipt:[{tt:'tt1',year:2000,flag:'us'}]};
 const run=vm.runInNewContext('(async function coverStep('+code+')',{
  PO:{...PO,drawCovers:async()=>{plan.board[0].items[0].poster=PO.posterUrl(null,'tt1');return resultObject;}},
  CO:{attachCountries:()=>({unknownLanguages:{}})},SKIP_POSTERS:false,CACHE_ONLY:true,COVER_RECEIPT:'/receipt-fixture.json',process:{env:{}},CACHE_DIR:'/cache',ROOT:path.resolve(__dirname,'..'),cfg:{},today:'2026-10-12',path,log:s=>logs.push(s),
  require:()=>({writePrivate:()=>{throw Object.assign(Error('receipt EACCES'),{code:'EACCES'});}}),
 });
 const result=await run({plan,index,coverFacts:new Map(),countries:{}});
 a.equal(result,resultObject);a.ok(result.tts.has('tt1'));a.equal(plan.board[0].items[0].poster,PO.posterUrl(null,'tt1'));
 a.ok(logs.some(x=>x.includes('receipt EACCES')));a.ok(!logs.some(x=>x.includes('every film keeps the cover address')));
});
