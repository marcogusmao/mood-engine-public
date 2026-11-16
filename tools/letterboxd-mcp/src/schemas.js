'use strict';
// letterboxd-mcp — the input contract of each tool, as zod schemas (zod 4, strict objects).
// The server registers these (first barrier: the SDK validates before the handler runs); the adapter runs them again on every
// call (second barrier: it cannot be called with a shape the server would have refused). Enums that depend on the data
// (moods, people, lists) are built from an index, so the adapter always checks against the index it is answering from.
// Covered by test/adapter.test.js (refusals) and test/protocol.test.js (the same refusals through the official client).

const { z } = require('zod');

const ID_RE = /^(tt\d+|tmdb:\d+|lb:[a-z0-9-]+)$/;
const REVISION_RE = /^[0-9a-f]{7,40}$/;
const ROW_RE = /^[a-z0-9-]{1,60}$/;

const MAX_LIMIT = 100;
const MAX_BATCH = 50;
// film_research_evidence answers far more text per film than the other tools: measured on the real package (12/10/2026), a record is 3.6 thousand characters
// on average and 6.0 thousand at most, so 50 ids were 165,656 characters (~40 thousand tokens), over the 25 thousand tokens Claude Code allows a tool result
// by default (no documentation found locally; the Claude Code 2.1.290 binary names the variable MAX_MCP_OUTPUT_TOKENS and holds a 25000 next to it; 4 characters per token is an estimate, ~100 thousand characters). The ten largest records together, with the
// package block and the envelope, are 59,977 characters (~15 thousand tokens); eleven are 65,659, seventeen 99,610: ten is the ceiling with room to spare.
// Measured 12/10/2026 in Claude Code 2.1.290: 5 of the largest records arrive inline; 10 (53 KB) were moved to a saved file.
const MAX_RESEARCH_IDS = 5;
const MAX_QUERY = 120; // free text of a lookup
const MAX_FILTER_TEXT = 80;

const id = z.string().regex(ID_RE, 'must be tt<digits>, tmdb:<digits> or lb:<slug>');
const query = z.string().min(1).max(MAX_QUERY);
const filterText = z.string().min(1).max(MAX_FILTER_TEXT);
const limit = (d) => z.number().int().min(1).max(MAX_LIMIT).default(d);
const rating = z.number().min(0).max(5);

/** z.enum([]) is unusable; an empty list becomes "nothing is valid". */
const enumOf = (values) => (values.length ? z.enum(values) : z.never());

/** What the data lets a caller name. People with a ':' in the name could not be written into a set spec and are left out. */
function enumsOf(index) {
  return {
    moods: (index.moods || []).map((m) => m.id).filter((x) => typeof x === 'string'),
    people: Object.keys(index.people || {}).filter((u) => !u.includes(':')),
    lists: Object.keys(index.lists || {}),
  };
}

const filterShape = (e) => ({
  unseen: z.boolean().optional(),
  seen: z.boolean().optional(),
  watchlist: z.boolean().optional(),
  eligible: z.boolean().optional(),
  maxMinutes: z.number().int().min(0).max(1000).optional(),
  minMinutes: z.number().int().min(0).max(1000).optional(),
  yearFrom: z.number().int().min(1850).max(2100).optional(),
  yearTo: z.number().int().min(1850).max(2100).optional(),
  minLetterboxd: rating.optional(),
  lang: z.string().regex(/^[a-z]{2}$/).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  director: filterText.optional(),
  genre: filterText.optional(),
  title: filterText.optional(),
  keywords: z.array(filterText).min(1).max(5).optional(),
  mood: enumOf(e.moods).optional(),
  friendMin: rating.optional(),
});

const setSpec = (e) => z.strictObject({
  kind: z.enum(['watchlist', 'seen', 'eligible', 'rated', 'friends', 'crowd', 'friend', 'list']),
  op: z.enum(['>=', '>', '<=', '<', '=']).optional(),
  value: rating.optional(),
  user: enumOf(e.people).optional(),
  what: z.enum(['rated', 'watchlist']).optional(),
  list: enumOf(e.lists).optional(),
});

function buildSchemas(e) {
  return {
    film_health: z.strictObject({}),
    film_dossier: z.strictObject({
      queries: z.array(query).min(1).max(MAX_BATCH),
      view: z.enum(['full', 'mubi']).optional(),
      maxChars: z.number().int().min(2000).max(30000).optional(),
      cursor: z.string().max(1024).optional(),
    }),
    film_search: z.strictObject({
      ...filterShape(e),
      sort: z.enum(['lb', 'year', 'runtime', 'id', 'taste']).optional(),
      limit: limit(20),
    }),
    film_check: z.strictObject({ ids: z.array(id).min(1).max(MAX_BATCH), ...filterShape(e) }),
    film_overlap: z.strictObject({ a: setSpec(e), b: setSpec(e), limit: limit(20) }),
    film_taste: z.strictObject({
      facet: z.enum(['director', 'cast', 'keyword', 'genre', 'country', 'lang', 'decade']),
      minFilms: z.number().int().min(1).max(50).default(2),
      limit: limit(20),
      order: z.enum(['top', 'bottom']).default('top'),
    }),
    film_friends: z.strictObject({
      minOverlap: z.number().int().min(0).max(10000).default(0),
      limit: limit(20),
      scope: z.enum(['configured', 'followed', 'all']).default('configured'),
    }),
    film_research_evidence: z.strictObject({ ids: z.array(id).min(1).max(MAX_RESEARCH_IDS) }),
    film_why: z.strictObject({
      query,
      revision: z.string().regex(REVISION_RE).optional(),
      row: z.string().regex(ROW_RE).optional(),
    }),
  };
}

module.exports = { buildSchemas, enumsOf, ID_RE, MAX_LIMIT, MAX_BATCH, MAX_RESEARCH_IDS, MAX_QUERY };
