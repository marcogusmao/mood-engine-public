import test from 'node:test';
import assert from 'node:assert/strict';
import { toPage, genreLink, searchLink } from '../src/page.js';
import { buildPageManifest, buildManifest, buildProfileManifest } from '../src/manifest.js';
import { createRequire } from 'node:module';
import { parseIndex } from '../src/store.js';
import { search } from '../src/search.js';
import { profileOf } from '../src/profiles.js';
const require = createRequire(import.meta.url);
const { fixture } = require('../../test-support/film-page-fixture');
const { encode } = require('../../lib/index-rows');
const context = { people: ['William', 'Ana', 'Gustavo', 'Bo', 'Nobody'], moods: [{ id: 'night', name: '🌃 Night drive' }, { id: 'noir', name: '🎞️ Noir' }], moodMenu: [{ id: 'noir', label: 'Noir' }, { id: 'night', label: 'Nocturnal' }], lists: [{ id: 'critic', label: 'A complete critic list' }] };
const record = { t: 'tt0057565', n: 'Synthetic film', y: 1963, rt: 142, im: 8.4, lb: 4.61, sb: 10, fa: 4.8, fr: { s: [[2, 4], [1, 4.5], [4, null]], w: [0, 3] }, d: ['Director, Jr.'], c: ['Toshirō #?% "🎞️'], mo: [['night', 1], ['noir', 1]], kw: ['noir', 'investigation', 'NOIR', 'anxious'], g: ['Crime', 'Drama', 'Science Fiction'], li: [['critic', 1]], syn: 'An arrival. A meeting. — MUBI', yt: 'abcdefghijk', why: 'you rate private', ownRating: 5, watchlist: true };
test('FP content: full group and label order, no Ratings group, synopsis only', () => {
  let m; assert.doesNotThrow(() => { m = toPage(record, context); }); assert.deepEqual([...new Set(m.links.map(l => l.category))], ['imdb', 'share', 'Directors', 'Cast', 'Mood', 'Lists']);
  // Marco, 28/10/2026: no Ratings group at all (the Letterboxd score stays on the poster cover). The record carries lb, sb, fa and named friends.
  assert.ok(record.lb && record.sb && record.fa && record.fr.s.length && record.fr.w.length); assert.ok(!m.links.some(l => l.category === 'Ratings')); assert.doesNotMatch(JSON.stringify(m.links), /Letterboxd 4|you follow|Ana|Gustavo|Bo · watchlist|★/);
  assert.deepEqual(m.links.filter(l => l.category === 'share').map(l => l.url), ['https://letterboxd.com/imdb/tt0057565/'], 'the share link stays'); assert.equal(m.links.filter(l => l.category === 'imdb').length, 1);
  assert.deepEqual(m.links.filter(l => l.category === 'Mood').map(l => l.name), ['Noir', 'Night drive', 'Crime', 'Drama', 'Science Fiction', 'Investigation', 'Anxious']);
  assert.equal(m.description, 'An arrival. A meeting. — MUBI'); assert.doesNotMatch(JSON.stringify(m), /ownRating|you rate|\/k\//); assert.deepEqual(m.videos, []); assert.deepEqual(m.behaviorHints, { defaultVideoId: record.t, hasScheduledVideos: false }); assert.deepEqual(m.trailerStreams, [{ title: record.n, ytId: 'abcdefghijk' }]); assert.match(m.poster, /poster\/small\//); assert.match(m.logo, /logo\/medium\//);
});
// Regression guard: the film page showed "MOOD: Deadpan, Noir, Lift me out, Dark comedy, Hopeful, Film noir" and, below it,
// "GENRES: Comedy, Crime, Drama" (Monsieur Verdoux, tt0039631), two groups with "Film noir" repeating "Noir". Marco, 28/10/2026.
test('FP content: genres join the Mood group between moods and terms, "Film noir" after "Noir" is dropped and the next term fills the slot (Verdoux, 28/10/2026)', () => {
  const ctx = { moods: [{ id: 'deadpan', name: '😐 Deadpan' }, { id: 'noir', name: '🎞️ Noir' }, { id: 'lift', name: '🌤️ Lift me out' }], moodMenu: [{ id: 'deadpan', label: 'Deadpan' }, { id: 'noir', label: 'Noir' }, { id: 'lift', label: 'Lift me out' }] };
  const m = toPage({ t: 'tt0039631', n: 'Monsieur Verdoux', mo: [['deadpan', 3], ['noir', 2], ['lift', 1]], kw: ['dark comedy', 'hopeful', 'film noir', 'marriage'], g: ['Comedy', 'Crime', 'Drama'] }, ctx);
  assert.deepEqual(m.links.filter(l => l.category === 'Mood').map(l => l.name), ['Deadpan', 'Noir', 'Lift me out', 'Comedy', 'Crime', 'Drama', 'Dark comedy', 'Hopeful', 'Marriage']);
  assert.ok(!m.links.some(l => l.category === 'Genres')); assert.deepEqual([...new Set(m.links.map(l => l.category))], ['share', 'Mood']);
  for (const name of ['Comedy', 'Crime', 'Drama']) assert.equal(m.links.find(l => l.name === name).url, genreLink(name), 'a genre chip keeps its Cinemeta discover link');
  assert.ok(m.links.find(l => l.name === 'Dark comedy').url.startsWith('stremio:///search?search='));
});
test('FP content: Mood repeat rule - equal plain() or "Film " + a shown name, nothing wider', () => {
  const ctx = { moods: [{ id: 'noir', name: '🎞️ Noir' }, { id: 'horror', name: '🧟 Horror' }], moodMenu: [{ id: 'noir', label: 'Noir' }, { id: 'horror', label: 'Horror' }] };
  const names = r => toPage({ t: 'tt1', n: 'F', ...r }, ctx).links.filter(l => l.category === 'Mood').map(l => l.name);
  assert.deepEqual(names({ mo: [['noir', 2], ['horror', 1]], g: ['Noir', 'Drama', 'Drama'], kw: ['Film noir', 'noir', 'Neo-noir', 'Body horror', 'Film horror', 'Filmnoir'] }), ['Horror', 'Noir', 'Drama', 'Neo-noir', 'Body horror', 'Filmnoir'], 'the mood Noir yields to the genre Noir, a repeated genre is skipped; "Film noir" and "Film horror" fall; "Neo-noir", "Body horror" stay; "Filmnoir" has no space');
  assert.deepEqual(names({ g: ['Comedy', 'Drama'], kw: ['Dark comedy', 'comedy', 'Film comedy', 'Comedy drama'] }), ['Comedy', 'Drama', 'Dark comedy', 'Comedy drama'], '"Film " + a GENRE falls too; "Dark comedy" and "Comedy drama" stay');
  assert.deepEqual(names({ kw: ['', '!!', 'a', 'b', 'c', 'd'] }), ['A', 'B', 'C'], 'empty keys are skipped and three terms is the cap');
  assert.deepEqual(names({ g: ['Crime', 'Drama', 'Comedy', 'Romance'] }), ['Crime', 'Drama', 'Comedy'], 'three genres is the cap');
});
// Review of 28/10/2026: three mutations survived the first tests (a shown term not remembered, a skipped genre freeing a slot, five moods shown).
test('FP content: Mood chips - a repeated term shows once, a repeated genre does not free a slot, five moods show four', () => {
  const ctx = { moods: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: `😀 Mood ${id}` })).concat([{ id: 'wicked', name: '🎃 Horror' }]), moodMenu: ['a', 'b', 'c', 'd', 'e', 'wicked'].map(id => ({ id, label: id === 'wicked' ? 'Horror' : `Mood ${id}` })) };
  const names = r => toPage({ t: 'tt1', n: 'F', ...r }, ctx).links.filter(l => l.category === 'Mood').map(l => l.name);
  assert.deepEqual(names({ kw: ['hopeful', 'hopeful', 'Hopeful', 'tender'] }), ['Hopeful', 'Tender'], 'a term already shown is remembered: three spellings, one chip');
  assert.deepEqual(names({ g: ['Drama', 'Drama', 'Comedy', 'Romance'] }), ['Drama', 'Comedy'], 'the four genres are cut to three BEFORE the repeats go: the repeated genre frees no slot, so "Romance" never shows');
  assert.deepEqual(names({ mo: [['a', 5], ['b', 4], ['c', 3], ['d', 2], ['e', 1]] }), ['Mood a', 'Mood b', 'Mood c', 'Mood d'], 'five moods show the four best fits');
});
// The Others (tt0230600): the mood "🎃 Horror" and the TMDB genre "Horror" are the same word; the genre chip (Cinemeta's Horror list) stays and the mood yields. Marco, 28/10/2026 (not the recommended option).
test('FP content: a mood named like a genre yields to the genre chip, and the next fit takes its slot (The Others, 28/10/2026)', () => {
  const ctx = { moods: [{ id: 'wicked', name: '🎃 Horror' }, ...['a', 'b', 'c', 'd'].map(id => ({ id, name: `😀 Mood ${id}` }))], moodMenu: [{ id: 'wicked', label: 'Horror' }, ...['a', 'b', 'c', 'd'].map(id => ({ id, label: `Mood ${id}` }))] };
  const others = toPage({ t: 'tt0230600', n: 'The Others', mo: [['wicked', 0.9]], g: ['Horror', 'Mystery', 'Thriller'] }, ctx).links.filter(l => l.category === 'Mood');
  assert.deepEqual(others.map(l => l.name), ['Horror', 'Mystery', 'Thriller']);
  assert.equal(others[0].url, genreLink('Horror')); assert.ok(!others.some(l => l.url.startsWith('stremio:///search?search=')), 'no mood chip with a search URL');
  const full = toPage({ t: 'tt1', n: 'F', mo: [['wicked', 5], ['a', 4], ['b', 3], ['c', 2], ['d', 1]], g: ['Horror'] }, ctx).links.filter(l => l.category === 'Mood');
  assert.deepEqual(full.map(l => l.name), ['Mood a', 'Mood b', 'Mood c', 'Mood d', 'Horror'], 'the fifth fit enters the slot of the mood that yielded; the genre comes after the moods');
  assert.equal(full.at(-1).url, genreLink('Horror'));
  assert.deepEqual(toPage({ t: 'tt3', n: 'F', mo: [['wicked', 1]], g: ['Drama', 'Comedy', 'Romance', 'Horror'] }, ctx).links.filter(l => l.category === 'Mood').map(l => l.name), ['Horror', 'Drama', 'Comedy', 'Romance'], 'a fourth genre is never shown, so a mood with its name stays');
  assert.deepEqual(toPage({ t: 'tt2', n: 'F', mo: [['wicked', 1]], g: ['Drama'] }, ctx).links.filter(l => l.category === 'Mood').map(l => l.name), ['Horror', 'Drama'], 'with no genre of that name the mood stays');
});
test('FP content: supported links preserve full punctuation and Cinemeta genre grammar', () => {
  let m; assert.doesNotThrow(() => { m = toPage(record, context); });
  for (const l of m.links) {
    const u = new URL(l.url); assert.ok(['https:', 'stremio:'].includes(u.protocol));
    if (u.protocol === 'https:') { assert.ok(u.host); if (l.category === 'imdb') assert.equal(u.host, 'imdb.com'); else assert.equal(u.host, 'letterboxd.com'); }
    else if (u.pathname === '/search') { assert.ok(l.url.startsWith('stremio:///search?search=')); assert.ok(u.searchParams.get('search')); }
    else { const segments = u.pathname.split('/'); assert.equal(decodeURIComponent(segments[2]), 'https://v3-cinemeta.strem.io/manifest.json'); assert.deepEqual(segments.slice(3), ['movie', 'top']); }
  }
  assert.equal(new URL(m.links.find(l => l.category === 'Cast').url).searchParams.get('search'), record.c[0]); assert.equal(new URL(m.links.find(l => l.category === 'Directors').url).searchParams.get('search'), record.d[0]);
  assert.equal(new URL(m.links.find(l => l.name === 'Night drive').url).searchParams.get('search'), 'Nocturnal'); assert.equal(new URL(genreLink('Science Fiction')).searchParams.get('genre'), 'Sci-Fi');
  for (const name of ['Music', 'TV Movie']) assert.equal(genreLink(name), searchLink(name));
});
test('FP content: lists search reaches exactly the list and its films', () => {
  const f = fixture(), e = f.index2.films[0]; f.index2.lists = [{ id: 'critic', label: 'Unusual critic selection', films: 1, popular: false }]; e.lists = { critic: 1 }; e.eligible = true;
  const m = toPage({ t: e.tt, n: e.name, li: [['critic', 1]] }, { lists: f.index2.lists }); const query = new URL(m.links.find(l => l.category === 'Lists').url).searchParams.get('search'); assert.equal(query, 'Unusual critic selection');
  const ix = parseIndex(JSON.stringify(encode(f.index2))); assert.deepEqual(search(ix, query).map(r => r.tt), [e.tt]);
});
test('FP content: no Ratings chip for any film, whatever its scores and friends carry (Marco, 28/10/2026)', () => {
  for (const r of [{ ...record }, { t: 'tt1', n: 'Friends only', fr: { s: [[4, null], [2, 4], [1, 4], [3, 5], [0, 3]], w: [0, 4] } }, { t: 'tt2', n: 'Scores only', lb: 3.2, sb: 3, fa: 3.5 }, { t: 'tt3', n: 'Watchlist only', fr: { w: [0] } }]) {
    const m = toPage(r, context); assert.ok(!m.links.some(l => l.category === 'Ratings'), r.n); assert.doesNotMatch(JSON.stringify(m), /★|you follow|watchlist/, r.n);
  }
});
test('FP content: minimal films omit unknown groups and trailers, unresolved references fail', () => {
  const m = toPage({ t: 'tt1', n: 'Minimal' }); assert.deepEqual(m.links.map(l => l.category), ['share']); assert.equal(m.description, ''); assert.equal(m.trailerStreams, undefined); assert.equal(m.releaseInfo, undefined); assert.equal(m.runtime, undefined);
  assert.throws(() => toPage({ t: 'tt1', n: 'One', mo: [['missing', 1]] }), /unresolved page mood/); assert.throws(() => toPage({ t: 'tt1', n: 'One', li: [['missing', 1]] }), /unresolved page list/);
});
test('FP route: only the separate page manifest declares meta', () => {
  assert.deepEqual(buildPageManifest().resources, [{ name: 'meta', types: ['movie'], idPrefixes: ['tt'] }]);
  const ix = parseIndex(JSON.stringify(encode(fixture().index2)));
  for (const m of [buildManifest(ix), ...['marco', 'night', 'light', 'heavy', 'world', 'critics'].map(p => profileOf(p)).filter(Boolean).map(p => buildProfileManifest(ix, p))]) assert.ok(!JSON.stringify(m.resources).includes('meta'));
});

// Lists short names on the chips, 28/10/2026 (PR #65 was already in main; the chips still said the full name with the author's handle).
test('FP lists short: the chip says the short name and searches it; the short name and the full name both open the list', () => {
  // the short name has a word that the full name does not (an abbreviation, as 'S&S' for Sight and Sound): only the list match, not the word search, can find it
  const label = 'British Broadcasting best films 2026 (somehandle)', short = 'BBC · best films 2026';
  const f = fixture(), original = f.index2.films[0];
  f.index2.lists = [{ id: 'RGQuY', label, short, films: 2, popular: false }, { id: 'noShort', label: 'Old build list', films: 1, popular: false }];
  f.index2.films = [
    { ...original, tt: 'tt1', name: 'Member B', rank: 1, year: 2001, runtime: 142, lists: { RGQuY: 1 } },
    { ...original, tt: 'tt2', name: 'Member A', rank: 2, year: 2002, runtime: 143, lists: { RGQuY: 2 } },
    { ...original, tt: 'tt3', name: 'Other', rank: 3, year: 2003, runtime: 100, lists: { noShort: 1 } },
  ];
  const chip = m => m.links.find(l => l.category === 'Lists');
  const m = toPage({ t: 'tt1', n: 'Member B', li: [['RGQuY', 1]] }, { lists: f.index2.lists });
  assert.equal(chip(m).name, short); assert.equal(new URL(chip(m).url).searchParams.get('search'), short);
  const ix = parseIndex(JSON.stringify(encode(f.index2)));
  assert.deepEqual(search(ix, short).map(e => e.tt), ['tt2', 'tt1'], 'the short name opens the list');
  assert.deepEqual(search(ix, label).map(e => e.tt), ['tt2', 'tt1'], 'the full name still opens the list');
  const old = toPage({ t: 'tt3', n: 'Other', li: [['noShort', 1]] }, { lists: f.index2.lists });
  assert.equal(chip(old).name, 'Old build list', 'a list with no short name: the label');
});

// Review of 28/10/2026 (a255f80): three mutations survived (empty short on the page, the private-text check not covering the short, exact equality instead of words) and the real collision, list sPMW short "Catharsis" x mood letin (word "Catharsis").
test('FP lists short: an empty or punctuation-only short is no short; a short with an e-mail or a private path is refused with the menus; the query is matched word for word', () => {
  const f = fixture(), original = f.index2.films[0];
  f.index2.lists = [{ id: 'empty', label: 'List with an empty short', short: '', films: 1, popular: false }, { id: 'dots', label: 'List with a dotted short', short: ' · ', films: 1, popular: false }, { id: 'abbr', label: 'British Broadcasting best films 2026 (somehandle)', short: 'BBC · best films 2026', films: 1, popular: false }];
  f.index2.films = [{ ...original, tt: 'tt1', name: 'Member', rank: 1, year: 2001, runtime: 142, lists: { abbr: 1, empty: 2, dots: 3 } }];
  const m = toPage({ t: 'tt1', n: 'Member', li: [['empty', 1], ['dots', 2], ['abbr', 3]] }, { lists: f.index2.lists });
  assert.deepEqual(m.links.filter(l => l.category === 'Lists').map(l => l.name), ['List with an empty short', 'List with a dotted short', 'BBC · best films 2026'], 'an empty short and a short with no letter: the label');
  const ix = parseIndex(JSON.stringify(encode(f.index2)));
  for (const q of ['bbc best films 2026', 'BBC, BEST films -- 2026!', 'Bbc  Best Films 2026']) assert.deepEqual(search(ix, q).map(e => e.tt), ['tt1'], q);
  for (const short of ['someone@example.com', 'rate/k/path', 'what you rate']) assert.throws(() => toPage({ t: 'tt1', n: 'Member', li: [['abbr', 1]] }, { lists: [...f.index2.lists, { id: 'priv', label: 'Fine label', short, films: 1, popular: false }] }), /private page menu/, short);
});
test('FP lists short: a short that is the word of a mood stays the mood\'s search; the chip says the short and searches the full name (sPMW x letin, Marco 28/10/2026)', () => {
  const f = fixture(), original = f.index2.films[0];
  const moods = [{ id: 'letin', label: 'Catharsis', name: '🌧️ Let it in' }];
  const lists = [{ id: 'sPMW', label: 'Catharsis (latifah)', short: 'Catharsis', films: 1, popular: false }];
  f.index2.moods = moods; f.index2.lists = lists;
  f.index2.films = [
    { ...original, tt: 'tt1', name: 'Alpha', rank: 3, year: 2001, runtime: 142, lists: { sPMW: 1 }, moods: { letin: [1.1, 2] } },
    { ...original, tt: 'tt2', name: 'Beta', rank: 2, year: 2002, runtime: 143, lists: {}, moods: { letin: [1.0, 3] } }, // the mood's film that is not in the list
    { ...original, tt: 'tt3', name: 'Gamma', rank: 1, year: 2003, runtime: 100, lists: {} },
  ];
  const chip = toPage({ t: 'tt1', n: 'Alpha', li: [['sPMW', 1]] }, { moods, moodMenu: [{ id: 'letin', label: 'Catharsis' }], lists }).links.find(l => l.category === 'Lists');
  assert.equal(chip.name, 'Catharsis'); assert.equal(new URL(chip.url).searchParams.get('search'), 'Catharsis (latifah)', 'the chip searches the full name');
  const ix = parseIndex(JSON.stringify(encode(f.index2)));
  const noShort = parseIndex(JSON.stringify(encode({ ...f.index2, lists: [{ id: 'sPMW', label: 'Catharsis (latifah)', films: 1, popular: false }] })));
  const got = search(ix, 'Catharsis').map(e => e.tt);
  assert.ok(got.includes('tt2'), 'the film of the mood only is still found: the word is the mood\'s, not the list\'s navigation');
  assert.deepEqual(got, search(noShort, 'Catharsis').map(e => e.tt), 'the same answer as before the short names');
  assert.deepEqual(search(ix, new URL(chip.url).searchParams.get('search')).map(e => e.tt), ['tt1'], 'the full name opens the list');
});

test('FP review: complete list labels keep decades, years and runtime as names', () => {
  for (const label of ['The ’90s Do the ’70s (Criterion Channel)', 'Best 1994 films under 90 min', 'Short films']) {
    const f=fixture(), original=f.index2.films[0];
    f.index2.lists=[{id:'RGQuY',label,films:4,popular:false}];
    f.index2.films=[
      {...original,tt:'tt1',name:'Member B',rank:1,year:2001,runtime:142,lists:{RGQuY:1}},
      {...original,tt:'tt2',name:'Member A',rank:2,year:2002,runtime:143,lists:{RGQuY:2}},
      {...original,tt:'tt3',name:'Seen member',seen:true,lists:{RGQuY:3}},
      {...original,tt:'tt4',name:'Music member',musicOut:true,lists:{RGQuY:4}},
      {...original,tt:'tt5',name:label,rank:100,year:1994,runtime:80,lists:{}},
    ];
    const meta=toPage({t:'tt1',n:'Member B',li:[['RGQuY',1]]},{lists:f.index2.lists});
    const query=new URL(meta.links.find(l=>l.category==='Lists').url).searchParams.get('search');
    const ix=parseIndex(JSON.stringify(encode(f.index2)));
    assert.deepEqual(search(ix,query).map(e=>e.tt),['tt2','tt1'],label);
    assert.deepEqual(search(ix,'2000s over 120 min').map(e=>e.tt),['tt2','tt1']);
  }
});

test('FP review: final projection rejects private text outside menus', () => {
  for(const n of ['private@example.test','https://example.test/k/private','you rate 4'])
    assert.throws(()=>toPage({t:'tt1',n}), /private page content/);
});
