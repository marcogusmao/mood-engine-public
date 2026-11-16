'use strict';
const test = require('node:test'), a = require('node:assert/strict');
const CS = require('../lib/cover-supplement'), CO = require('../lib/countries');
test('cover supplement: confirmed identities close 32 flag gaps without supplying ratings or an invented year', () => {
  const facts = CS.read();
  a.equal(facts.size, 32);
  for (const [tt, d] of facts) {
    a.equal(d.imdb, tt);
    a.deepEqual(Object.keys(d).sort(), ['countries', 'imdb', 'language', 'origin']);
    a.ok(CO.pickCountry({tmdb:d.countries, lang:d.language}), tt);
  }
  a.equal(CO.pickCountry({tmdb:facts.get('tt13653876').countries, lang:facts.get('tt13653876').language}).cc, 'jp');
  a.equal(facts.has('tt17042980'), false);
});
test('cover supplement: malformed identity and unsupported country/language are refused; returned countries are independent', () => {
  const entry = {countries:['US'],language:'en',identity:'Source matched IMDb',source:'https://letterboxd.com/film/example/',retrievedAt:'2026-10-12T12:00:00Z'};
  for (const [id, edit] of [['../tt1',{}],['tt1',{countries:['USA']}],['tt1',{language:'English'}],['tt1',{identity:''}],['tt1',{source:'file:///private'}],['tt1',{retrievedAt:'unknown'}]]) {
    a.throws(() => CS.read({version:1,items:{[id]:{...entry,...edit}}}), /Invalid cover fact/);
  }
  const input={version:1,items:{tt1:entry}}, result=CS.read(input);
  result.get('tt1').countries.push('GB');
  a.deepEqual(entry.countries,['US']);
});
test('cover supplement: replay restores frozen JSON and old snapshots do not borrow newer supplementary facts', () => {
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const {restoreCoverFacts}=require('../lib/learning/replay');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cover-facts-replay-'));
  try {
    fs.mkdirSync(path.join(temp,'lib'));
    const file=path.join(temp,'lib/cover-facts.json');
    const frozen={version:1,items:{tt1:{countries:['JP'],language:'ja',identity:'IMDb confirmed',source:'https://www.wikidata.org/wiki/Q1',retrievedAt:'2026-10-12T12:00:00Z'}}};
    fs.writeFileSync(file,JSON.stringify({version:1,items:{tt2:{countries:['US']}}}));
    restoreCoverFacts({sourceBytes:{'lib/cover-facts.json':JSON.stringify(frozen)}},temp);
    a.deepEqual([...CS.read(JSON.parse(fs.readFileSync(file))).keys()],['tt1']);
    restoreCoverFacts({sourceBytes:{}},temp);
    a.equal(CS.read(JSON.parse(fs.readFileSync(file))).size,0);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});

// 13/10/2026, adversarial review: build.js kept a TMDB record for a cover when `d && d.imdb === t.tt`; changing it to `filter(Boolean)` left all 825 tests green
// and moved the flag of tt8101850 (Undone) from NL to US, because TMDB 86340 (Unnatural Selection) has no IMDb id and was lent to it. Same for
// tt0204394 (The Iceman Cometh) and TMDB 318693. The rule now lives in CF.ownRecords(); the corpus test in full-index-posters.test.js checks the two real films.
test('cover facts: only a TMDB record that carries the film\'s own IMDb id lends its facts to the cover', () => {
  const CF = require('../lib/cover-facts');
  const movie = { 1: { imdb: 'tt1', countries: ['US'] }, 2: { imdb: 'tt2', countries: ['NL'] }, 3: { countries: ['JP'] }, 4: null };
  const peek = id => movie[id] || null;
  a.deepEqual(CF.ownRecords([1, 1, 2, 3, 4, undefined, null, 5], peek, 'tt1'), [movie[1]], 'another title, a record without IMDb id, a missing record and a repeated id are out');
  a.deepEqual(CF.ownRecords([3, 4], peek, 'tt1'), [], 'a film whose only record is not its own has none');
  a.deepEqual(CF.ownRecords([], peek, 'tt1'), []);
});
