'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const IX=require('../lib/index-export'),V=require('../lib/index-validation');
function fixture(){
 const index=IX.buildIndex({cfg:{addon:{version:'1'},moods:[]},today:'2026-10-12',plan:{board:[{id:'x',name:'X',items:[{id:'tt1',title:'Fixture',year:2000}]}],discover:[]}});
 index.moods=[{id:'lift',label:'Uplift'}];index.lists=[{id:'list',label:'List',films:0,popular:false}];
 return index;
}
const edits={
 moodLabel:x=>{x.moods[0].label={privatePayload:'nested'};},
 listCount:x=>{x.lists[0].films={privatePayload:'nested'};},
 boardName:x=>{x.board[0].name={privatePayload:'nested'};},
 metaNumber:x=>{x.meta.loveStars={privatePayload:'nested'};},
 derivedDecade:x=>{x.films[0].decade='erased private value';},
 moodsFalse:x=>{x.films[0].moods=false;},
 listsZero:x=>{x.films[0].lists=0;},
 friendsEmpty:x=>{x.films[0].friends='';},
 formatObject:x=>{x.meta.format={privatePayload:'erased'};},
 malformedPosterURL:x=>{x.films[0].poster='https://example.invalid:invalid-port/poster.jpg';},
 rulesFalse:x=>{x.rules=false;},
};
for(const [name,edit] of Object.entries(edits))test('index types: '+name+' cannot authorize publication',()=>{
 const index=fixture();a.doesNotThrow(()=>V.validateIndex(index));edit(index);a.throws(()=>V.validateIndex(index));
});

// Marco, 28/10/2026 (Discover, proposal 5): the new keys of the `discover` object cannot authorize publication when their type is wrong. The v2 family only (it has a moodMenu).
function fixtureWithDiscover(){
 const index=IX.buildIndex({cfg:{addon:{version:'1'},moods:[]},today:'2026-10-28',plan:{board:[{id:'x',name:'X',place:'board',items:[{id:'tt1',title:'Fixture',year:2000}]}],discover:[]},v2:{menu:[{id:'lift',label:'Uplift'}],countries:null}});
 index.moods=[{id:'lift',label:'Uplift'}];index.lists=[{id:'list',label:'List',films:0,popular:false}];
 index.directors={options:[{label:'Kubrick loves',ids:[],descs:[]}]};
 index.discover={order:['moods','places','explore','search'],retire:['lists','lists-unseen','director-picks'],seen:{name:'seen',option:'Include seen'},explore:{genre:'places'},catalogs:[{id:'places',name:'Mood Engine \u00b7 Places',options:[
  {id:'g-a',label:'A',ids:['tt1']},{id:'u-b',label:'B',ids:['tt1'],curated:true},{id:'d-k',label:'Kubrick loves',ids:['tt1'],curated:true,director:'Kubrick loves'},{id:'l-list',label:'List',list:'list'}]}]};
 return index;
}
const discoverEdits={
 curatedFalse:x=>{x.discover.catalogs[0].options[1].curated=false;},
 curatedString:x=>{x.discover.catalogs[0].options[1].curated='yes';},
 curatedOnAList:x=>{x.discover.catalogs[0].options[3].curated=true;},
 directorOnPlainOption:x=>{x.discover.catalogs[0].options[0].director='Kubrick loves';},
 directorNumber:x=>{x.discover.catalogs[0].options[2].director=5;},
 directorNotInTheMenu:x=>{x.discover.catalogs[0].options[2].director='Nobody loves';},
 exploreExtraKey:x=>{x.discover.explore.extra=1;},
 exploreNumber:x=>{x.discover.explore.genre=5;},
 exploreUnknownCatalog:x=>{x.discover.explore.genre='nowhere';},
 optionUnknownKey:x=>{x.discover.catalogs[0].options[0].where={};},
};
test('index types: a discover with curated options, a card and an explore passes (control of the edits below)',()=>{
 a.doesNotThrow(()=>V.validateIndex(fixtureWithDiscover(),'index-v2'));
});
for(const [name,edit] of Object.entries(discoverEdits))test('index types: discover '+name+' cannot authorize publication',()=>{
 const index=fixtureWithDiscover();a.doesNotThrow(()=>V.validateIndex(index,'index-v2'));edit(index);a.throws(()=>V.validateIndex(index,'index-v2'));
});
