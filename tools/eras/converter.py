#!/usr/bin/env python3
"""Converts the curation of 15/11/2026 into the era files data/eras/<era id>.json, WITHOUT network and WITHOUT the stremio repository.

  python3 tools/eras/converter.py            writes data/eras/*.json
  python3 tools/eras/converter.py --check    says (exit 1) if data/eras is not what the converter makes

Inputs, all in this repository: research/2026-11-15-curadoria/<era>.json (the snapshot tools/eras/snapshot_curadoria.py made of the three curations), tools/eras/decisoes.json (one entry for
each era, mirroring the sheet of decisions of 15/11/2026: who decided, label, years, which classes enter, directors out and in, the films a decision puts in or takes out), the index of
reference test/fixtures/era-filmographies-index-imdb-2026-11-14.json (the IMDb ids of the public index of 14/11/2026) and research/2026-11-14-eras-v2/fontes.json (the TMDB ids and Letterboxd slugs
that the first round read). The rules the converter applies:
  - a film enters the file if the curation names it, its class is admitted, it has enough sources (minSources) and, for New Hollywood, a source that is not Wikipedia; it is inside the years,
    or it is put in by a decision (`include`, as a written exception `outside` when it is outside the years);
  - a written exclusion removes the film from the list and is written with its reason and source;
  - a film that the index of reference does not have is written only above the prefilter (IMDb 100 votes and 6.5), with its TMDB id and Letterboxd slug; with no id it goes to `pending`
    (with the reason); the number of films above the floor of 100 votes and 7.0 is in `counted`;
  - a film with no IMDb id goes to `pending`.
"""
import json, os, re, sys, collections, unicodedata

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SNAP = os.path.join(ROOT, "research", "2026-11-15-curadoria")
OUT = os.path.join(ROOT, "data", "eras")
DEC = os.path.join(ROOT, "tools", "eras", "decisoes.json")
REF = os.path.join(ROOT, "test", "fixtures", "era-filmographies-index-imdb-2026-11-14.json")
FONTES = os.path.join(ROOT, "research", "2026-11-14-eras-v2", "fontes.json")
READ_ON = "2026-11-15"  # the curation read its sources on 14/11 and 15/11/2026; the day recorded for all is the day it was handed over
PREFILTER = {"votes": 100, "rating": 6.5}
FLOOR = {"votes": 100, "rating": 7.0}  # the IMDb floor the sheet asks to count: how many new films would probably pass
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NO_URL = "(the curation recorded no URL for this source)"


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKD", str(s).replace("ł", "l").replace("Ł", "L")).encode("ascii", "ignore").decode().lower()).split())


def within(y, yrs):
    return isinstance(y, int) and y >= yrs["min"] and (yrs.get("max") is None or y <= yrs["max"])


def load_ids():
    ref = set(json.load(open(REF))["imdb"])
    ids = {}
    f = json.load(open(FONTES))
    for rec in f["eras"].values():
        for x in rec.get("films", []) + rec.get("candidates", []):
            if x.get("imdb"):
                o = ids.setdefault(x["imdb"], {})
                if x.get("tmdb") and not o.get("tmdb"):
                    o["tmdb"] = x["tmdb"]
                if x.get("slug") and not o.get("slug"):
                    o["slug"] = x["slug"]
    for t, g in f.get("idsFromWikidata", {}).get("answers", {}).items():
        o = ids.setdefault(t, {})
        for k in ("tmdb", "slug"):
            if g.get(k) and not o.get(k):
                o[k] = g[k]
    return ref, ids


def sources_out(snap, used):
    by = {s["id"]: s for s in snap["sources"]}
    out = []
    for i in sorted(used):
        s = by.get(i)
        if not s:
            raise SystemExit(f"{snap['era']}: a film cites the source {i}, which the snapshot does not have")
        rec = {"id": i, "publication": s["institution"] or "(not recorded)", "title": s["title"] or s["institution"] or i, "url": s["url"] or NO_URL, "revision": s["revision"],
               "readOn": READ_ON, "mark": s["mark"]}
        if DATE.match(str(s["date"] or "")):
            rec["publishedOn"] = s["date"]  # the date of the source itself (a list, a page), when the curation recorded one; readOn is the day the curation read it
        out.append(rec)
    return out


def make_one(era, dec, ref, ids, detail=False):
    snap = json.load(open(os.path.join(SNAP, dec["curation"] + ".json")))
    yrs = dec["years"]
    admit = set(dec["admit"])
    left = collections.Counter()
    excluded = {x["imdb"]: x for x in dec.get("exclude", [])}
    by_imdb = {f["imdb"]: f for f in snap["films"] if f.get("imdb")}
    by_title = {}
    for f in snap["films"]:
        by_title.setdefault((f.get("title", "").lower(), f.get("year")), f)
    curex = {x["imdb"]: x for x in snap["exclusionsOfCuration"] if x.get("imdb")}
    forced = {}  # imdb -> (film facts, why)
    for inc in dec.get("include", []):
        f = by_imdb.get(inc.get("imdb")) if inc.get("imdb") else by_title.get((inc["title"].lower(), inc["year"]))
        if f is None and inc.get("imdb") in curex:
            x = curex[inc["imdb"]]
            f = {"imdb": x["imdb"], "title": x["title"], "year": x.get("year"), "director": x.get("director", ""), "src": x.get("nameSources", []), "votes": x.get("votes"), "rating": x.get("rating")}
        if f is None:
            raise SystemExit(f"{era}: the decision puts in a film the snapshot does not have: {inc}")
        forced[f["imdb"]] = (f, inc["why"])
    for name in dec.get("includeDirectors", []):
        for f in snap["films"]:
            if f.get("imdb") and name in f.get("director", ""):
                forced.setdefault(f["imdb"], (f, dec["includeWhy"]))
    films, pending, candidates = [], [], []
    seen = set()
    cand_pool = []
    doc_excluded, id_mismatch = {}, []  # imdb -> film (documentaries written out), and the ids whose TMDB year is not the year of the list

    def screen(f):
        """None when the film passes the admission rule of the era (class, sources, institutions); else the reason. The years and the documentaries are judged by the caller."""
        if f.get("cls") not in admit:
            return "class not admitted by the era"
        if len(f.get("src", [])) < dec.get("minSources", 1):
            return f"fewer than {dec.get('minSources', 1)} sources"
        if dec.get("requireSource") and not any(i in dec["requireSource"] for i in f.get("src", [])):
            return "named only by a source that is not a source of the movement (Abraccine reinforces, never suffices)"
        if dec.get("institutions") and not any(not g.lower().startswith("wikipedia") for g in f.get("groups", [])):
            return "named by Wikipedia alone"
        return None

    def consider(f, why_forced=None):
        t = f.get("imdb")
        year = f.get("year")
        inside = within(year, yrs)
        ty = f.get("tmdbYear")
        wrong = {w["imdb"]: w for w in dec.get("wrongIds", [])}
        if t and t in wrong:
            # the id the curation gave is another film (Tol'able David of 1930 with the id of the film of 1921): out of the file, written in `pending` with the reason
            pending.append({"title": f.get("title") or "(untitled)", "year": year, "class": f.get("cls"), "why": wrong[t]["why"]})
            return
        if t and ty is not None and year is not None and (abs(ty - year) > 1 or (inside and not within(ty, yrs))) and screen(f) is None and (inside or why_forced):
            id_mismatch.append({"era": era, "title": f.get("title"), "year": year, "imdb": t, "tmdbYear": ty})  # reported, not acted on: a different year is not always another film
        if not t:
            if year is not None and (inside or why_forced) and screen(f) is None:
                pending.append({"title": f.get("title") or "(untitled)", "year": year, "class": f.get("cls"), "why": "the curation found no IMDb id for this film; it is written down so that it is not lost"})
            elif year is not None and (inside or why_forced):
                left["no IMDb id, and not admitted by the era (not written in pending)"] += 1
            return
        if t in seen or t in excluded:
            if t in excluded:
                left["named by a written exclusion"] += 1
            return
        if why_forced is None:
            reason = screen(f)
            if reason:
                left[reason] += 1
                return
            if not inside:
                left["outside the years of the era"] += 1
                return
            if dec.get("dropDocs") and f.get("doc"):
                left["a documentary"] += 1
                doc_excluded[t] = f
                return
        seen.add(t)
        rec = {"imdb": t, "title": f.get("title") or f"(untitled in the curation: {t})", "year": year, "sources": list(f.get("src", [])), "cls": f.get("cls"), "votes": f.get("votes"), "rating": f.get("rating"), "why": why_forced}
        cand_pool.append(rec)
    for f in snap["films"]:
        if f.get("imdb") in forced:
            continue
        consider(f)
    for t, (f, why) in forced.items():
        if t in excluded:
            continue
        consider(f, why_forced=why)
    for title in dec.get("excludeDocs", []):
        hit = [f for f in snap["films"] if f.get("imdb") and title.lower() in f.get("title", "").lower() and f.get("doc")]
        for f in hit:
            doc_excluded.setdefault(f["imdb"], f)
    # the rows
    used = set()
    new_in_index = collections.Counter()
    for rec in sorted(cand_pool, key=lambda r: (r["year"] or 0, r["imdb"])):
        t = rec["imdb"]
        row = {"imdb": t}
        in_index = t in ref
        g = ids.get(t, {})
        orig = by_imdb.get(t, {})
        tmdb = orig.get("tmdb") or g.get("tmdb")
        slug = orig.get("slug") or g.get("slug")
        if not in_index:
            new_in_index["notInIndex"] += 1
            if (rec["votes"] or 0) >= FLOOR["votes"] and (rec["rating"] or 0) >= FLOOR["rating"]:
                new_in_index["passesImdb7"] += 1
            if not rec["why"] and ((rec["votes"] or 0) < PREFILTER["votes"] or (rec["rating"] or 0) < PREFILTER["rating"]):  # a film a decision put in is not cut by the prefilter
                left["not in the index and under the prefilter"] += 1
                if detail:
                    candidates.append(dict(rec, inIndex=False, written=False))
                continue
            if not (tmdb and slug):
                entry = {"imdb": t, "title": rec["title"], "year": rec["year"], "class": rec["cls"], "why": "above the prefilter and not in the index, but no TMDB id or Letterboxd page is known yet"}
                if rec["cls"] not in admit and rec["why"] and rec["sources"]:
                    # a written decision puts this film in whatever its class (the four of Ray and Ghatak): the pending entry carries it, as a row of films does
                    entry["included"] = {"source": sorted(set(rec["sources"]))[0], "why": rec["why"]}
                    used |= {entry["included"]["source"]}
                pending.append(entry)
                if detail:
                    candidates.append(dict(rec, inIndex=False, written=False))
                continue
        if tmdb:
            row["tmdb"] = tmdb
        if slug:
            row["slug"] = slug
        row.update({"title": rec["title"], "year": rec["year"]})
        srcs = [s for s in rec["sources"]]
        if not srcs:
            raise SystemExit(f"{era}: {rec['title']} has no source")
        row["sources"] = sorted(set(srcs))
        used |= set(srcs)
        if rec["cls"]:
            row["class"] = rec["cls"]
        if rec["why"]:
            if not within(rec["year"], yrs):
                src = next((s for s in srcs if not s.startswith("wp-") and not s.startswith("wikipedia")), srcs[0])
                row["outside"] = {"source": src, "why": rec["why"] + " (outside the years of the era)"}
            if rec["cls"] not in admit or dec.get("institutions") is None and rec["cls"] not in admit:
                row["included"] = {"source": srcs[0], "why": rec["why"]}
        films.append(row)
        if detail and not in_index:
            candidates.append(dict(rec, inIndex=False, written=True))
    # the written exclusions
    exclude = [{"imdb": x["imdb"], "title": x["title"], "why": x["why"], "source": x["source"]} for x in dec.get("exclude", [])]
    for t, f in sorted(doc_excluded.items(), key=lambda kv: (kv[1].get("year") or 0, kv[0])):
        if t in {x["imdb"] for x in exclude} or t in seen:
            continue
        exclude.append({"imdb": t, "title": f.get("title") or t, "why": "a documentary (the TMDB genre Documentary): Marco asked to keep documentaries out", "source": "Marco, 15/11/2026: documentaries 'No, keep them out'; the genre Documentary of the TMDB record (cache/tmdb.json)"})
    # the entries the curation of Europe lists as "no id found" carry no class, so the admission rule cannot judge them: they are counted, not written
    left["named with no id and no class (not written in pending)"] += sum(1 for x in snap.get("noId", []) if within(x.get("year"), yrs))
    sources = sources_out(snap, used)
    data = {"id": era, "type": dec["type"], "years": yrs, "school": None, "sources": sources, "consensus": None, "films": films, "exclude": exclude}
    data["admit"] = sorted(admit, key=["core", "periphery", "disputed"].index)
    if pending:
        seen_p = set()
        data["pending"] = [p for p in pending if (p["title"], p["year"]) not in seen_p and not seen_p.add((p["title"], p["year"]))]
    if dec["type"] == "school":
        base = snap["base"]
        rem = set(dec.get("removeDirectors", []))
        dirs = [d for d in base["directors"] if d["id"] not in rem] + dec.get("addDirectors", [])
        data["school"] = {"countries": base["countries"], "directors": dirs}
        if base.get("candidates") is not None:
            names = {norm(d["name"]) for d in dirs}
            # a candidate is a film of a director OF THE ERA: when a director leaves the list (Polanski and Skolimowski in the Polish School) the candidates of his go too
            cs = [c for c in base["candidates"] if within(c["year"], yrs) and c["imdb"] not in seen and c["imdb"] not in excluded and any(norm(n) in names for n in c["directors"])]
            data["school"]["candidates"] = cs
            data["school"]["candidatesFrom"] = base.get("candidatesFrom", "")
        if base.get("notAdded"):
            data["school"]["notAdded"] = base["notAdded"]
    data["counted"] = {"curationFilms": len(snap["films"]), "written": len(films), "inIndexOfReference": sum(1 for r in films if r["imdb"] in ref), "notInIndexAdmitted": new_in_index["notInIndex"],
                       "notInIndexPassingImdb7": new_in_index["passesImdb7"], "pending": len(data.get("pending", [])), "documentariesWrittenOut": len([x for x in exclude if x["why"].startswith("a documentary")]), "leftOut": dict(left)}
    data["_idMismatch"] = id_mismatch
    out = (data, candidates) if detail else data
    return out


def make_all(detail=False):
    ref, ids = load_ids()
    dec = json.load(open(DEC))
    out = {}
    for era, d in dec["eras"].items():
        out[era] = make_one(era, d, ref, ids, detail)
    return out, dec


def dump(d):
    L = ["{", f'"id": {json.dumps(d["id"])}, "type": {json.dumps(d["type"])}, "years": {json.dumps(d["years"])}, "admit": {json.dumps(d["admit"])},']
    s = d["school"]
    if s is None:
        L.append('"school": null,')
    else:
        L.append('"school": {')
        L.append(f'  "countries": {json.dumps(s["countries"])},')
        L.append('  "directors": [\n' + ",\n".join("    " + json.dumps(x, ensure_ascii=False) for x in s["directors"]) + "\n  ]" + ("," if len(s) > 2 else ""))
        extra = [k for k in s if k not in ("countries", "directors")]
        for i, k in enumerate(extra):
            if k == "candidates":
                L.append('  "candidates": [\n' + ",\n".join("    " + json.dumps(c, ensure_ascii=False) for c in s[k]) + "\n  ]" + ("," if i < len(extra) - 1 else ""))
            else:
                L.append(f'  {json.dumps(k)}: {json.dumps(s[k], ensure_ascii=False)}' + ("," if i < len(extra) - 1 else ""))
        L.append("},")
    L.append('"sources": [\n' + ",\n".join("  " + json.dumps(x, ensure_ascii=False) for x in d["sources"]) + "\n],")
    L.append('"consensus": null,')
    L.append('"films": [\n' + ",\n".join("  " + json.dumps(x, ensure_ascii=False) for x in d["films"]) + "\n],")
    L.append('"exclude": [\n' + ",\n".join("  " + json.dumps(x, ensure_ascii=False) for x in d["exclude"]) + "\n],")
    L.append('"pending": [\n' + ",\n".join("  " + json.dumps(x, ensure_ascii=False) for x in d.get("pending", [])) + "\n],")
    L.append('"counted": ' + json.dumps(d["counted"], ensure_ascii=False))
    L.append("}")
    return "\n".join(L) + "\n"


def main(argv):
    files, _ = make_all()
    check = "--check" in argv
    changed = []
    for era, d in files.items():
        text = dump(d)
        json.loads(text)
        path = os.path.join(OUT, era + ".json")
        if check:
            if not os.path.exists(path) or open(path, encoding="utf8").read() != text:
                changed.append(era)
        else:
            os.makedirs(OUT, exist_ok=True)
            open(path, "w", encoding="utf8").write(text)
    if check:
        extra = sorted(f[:-5] for f in os.listdir(OUT) if f.endswith(".json") and f[:-5] not in files) if os.path.isdir(OUT) else []
        if changed or extra:
            print("would change:", changed, "| files the converter does not make:", extra)
            return 1
        print("data/eras equals what the converter makes:", len(files), "files")
        return 0
    print("wrote", len(files), "files in", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
