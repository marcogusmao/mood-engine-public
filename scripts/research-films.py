#!/usr/bin/env python3
"""Research the entire cached catalogue. Public GETs, resumable, no production writes.

Source extracts stay in .context. Output is evidence and proposals, never a mood
ground truth. IMDb's bulk file is streamed and filtered, not saved in full.
"""
import argparse
import collections
import concurrent.futures
import csv
import datetime
import gzip
import hashlib
import html
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
UA = "MoodEngineFilmResearch/1.0 (personal film catalogue; https://github.com/marcogusmao/mood-engine)"
IMDB = re.compile(r"tt\d{5,12}\Z")
STATE = ROOT / ".context/film-research"


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + "." + str(os.getpid()) + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def inventory():
    movies = read(ROOT / "cache/tmdb.json")["movie"]
    lb = read(ROOT / "cache/friends.json")["films"]
    records = {}
    for entry in movies.values():
        m = entry.get("v")
        if not m:
            continue
        tt = m.get("imdb")
        key = tt if isinstance(tt, str) and IMDB.fullmatch(tt) else "tmdb:" + str(m["id"])
        r = records.setdefault(key, {"id": key, "imdb": tt if key.startswith("tt") else None,
                                     "tmdb": [], "letterboxd": []})
        detail = {k: m.get(k) for k in ["id", "title", "year", "genres", "keywords", "overview", "directors", "runtime", "lang"]}
        detail["cachedAtMs"] = entry.get("t")
        r["tmdb"].append(detail)
    for slug, f in lb.items():
        if f.get("gone"):
            continue
        tt = f.get("imdbId")
        key = tt if isinstance(tt, str) and IMDB.fullmatch(tt) else "letterboxd:" + slug
        r = records.setdefault(key, {"id": key, "imdb": tt if key.startswith("tt") else None,
                                     "tmdb": [], "letterboxd": []})
        r["letterboxd"].append({"slug": slug, "title": f.get("title"), "year": f.get("year"), "tmdb": f.get("tmdbId")})
    for r in records.values():
        m = r["tmdb"][0] if r["tmdb"] else r["letterboxd"][0]
        r["title"], r["year"] = m.get("title"), m.get("year")
        r["identityWarnings"] = []
        if len(r["tmdb"]) > 1:
            r["identityWarnings"].append("multiple-tmdb-records-for-imdb")
        ys = {x.get("year") for x in r["tmdb"] + r["letterboxd"] if x.get("year")}
        if ys and max(ys) - min(ys) > 1:
            r["identityWarnings"].append("release-years-disagree")
    return dict(sorted(records.items()))


class SourceError(Exception):
    def __init__(self, status):
        self.status = status


def get(url, limit=12_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            content = response.read(limit + 1)
            if len(content) > limit:
                raise SourceError("response-too-large")
            return content, dict(response.headers)
    except urllib.error.HTTPError as error:
        raise SourceError("http-" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SourceError("network-error") from None


class Ledger:
    def __init__(self, name):
        self.path = STATE / (name + ".jsonl")
        self.rows = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                # Never silently discard a partial final line after interruption.
                try:
                    r = json.loads(line)
                    self.rows[r["id"]] = r
                except json.JSONDecodeError:
                    raise RuntimeError("incomplete checkpoint: " + str(self.path))

    def add(self, row):
        with self.path.open("a", encoding="utf-8") as out:
            out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.rows[row["id"]] = row


def imdb_bulk(records, ledger):
    ids = {r["imdb"] for r in records.values() if r["imdb"]}
    if ids <= ledger.rows.keys():
        return
    url = "https://datasets.imdbws.com/title.basics.tsv.gz"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    found = {}
    started = now()
    with urllib.request.urlopen(req, timeout=60) as response:
        source_meta = {"url": url, "retrievedAt": started, "lastModified": response.headers.get("Last-Modified"), "etag": response.headers.get("ETag")}
        with gzip.GzipFile(fileobj=response) as stream:
            for line in io.TextIOWrapper(stream, encoding="utf-8"):
                key = line.split("\t", 1)[0]
                if key not in ids:
                    continue
                fields = next(csv.reader([line], delimiter="\t", quoting=csv.QUOTE_NONE))
                if len(fields) != 9:
                    raise RuntimeError("unexpected IMDb row schema")
                found[key] = {"type": fields[1], "title": fields[2], "originalTitle": fields[3],
                              "year": None if fields[5] == "\\N" else int(fields[5]),
                              "runtime": None if fields[7] == "\\N" else int(fields[7]),
                              "genres": [] if fields[8] == "\\N" else fields[8].split(",")}
    for key in sorted(ids):
        if key not in ledger.rows:
            ledger.add({"id": key, "status": "matched" if key in found else "not-in-dataset",
                        "source": source_meta, "facts": found.get(key)})
    print(json.dumps({"source": "imdb", "queried": len(ids), "matched": len(found)}), flush=True)


def chunks(values, count):
    for i in range(0, len(values), count):
        yield values[i:i + count]


def wikidata(records, ledger):
    pending = [key for key, r in records.items() if r["imdb"] and key not in ledger.rows]
    failures = 0
    for batch in chunks(pending, 100):
        q = '''SELECT ?item ?imdb ?article ?pt ?genre ?genreLabel WHERE {
          VALUES ?imdb { %s } ?item wdt:P345 ?imdb .
          OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> . }
          OPTIONAL { ?pt schema:about ?item; schema:isPartOf <https://pt.wikipedia.org/> . }
          OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreLabel . FILTER(LANG(?genreLabel) = "en") }
        }''' % " ".join(json.dumps(x) for x in batch)
        url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
        try:
            raw, _ = get(url)
            rows = json.loads(raw)["results"]["bindings"]
            matched = {key: {} for key in batch}
            for x in rows:
                tt = x["imdb"]["value"]
                if tt not in matched:
                    raise RuntimeError("WDQS returned an unrequested identity")
                qid = x["item"]["value"].rsplit("/", 1)[-1]
                if not re.fullmatch(r"Q\d+", qid):
                    raise RuntimeError("invalid Wikidata identity")
                d = matched[tt].setdefault(qid, {"qid": qid, "articles": {}, "genres": []})
                for key, lang in [("article", "en"), ("pt", "pt")]:
                    if key in x:
                        article = x[key]["value"]
                        if article.startswith("https://" + lang + ".wikipedia.org/wiki/"):
                            d["articles"][lang] = article
                if "genreLabel" in x:
                    genre = {"id": x["genre"]["value"].rsplit("/", 1)[-1], "label": x["genreLabel"]["value"]}
                    if genre not in d["genres"]:
                        d["genres"].append(genre)
            timestamp = now()
            for key in batch:
                candidates = list(matched[key].values())
                ledger.add({"id": key, "status": "matched" if len(candidates) == 1 else "ambiguous" if candidates else "not-found",
                            "retrievedAt": timestamp, "candidates": candidates})
            failures = 0
        except SourceError as error:
            failures += 1
            print(json.dumps({"source": "wikidata", "batch": len(batch), "status": error.status, "consecutiveFailures": failures}), flush=True)
            if failures >= 3 or error.status in ("http-403", "http-429"):
                break
            time.sleep(3)
        print(json.dumps({"source": "wikidata", "completed": len(ledger.rows), "target": len(pending)}), flush=True)
        time.sleep(0.6)


def wikipedia(wd, ledger):
    grouped = collections.defaultdict(list)
    for key, r in wd.rows.items():
        if key in ledger.rows or r["status"] != "matched":
            continue
        d = r["candidates"][0]
        lang = "en" if "en" in d["articles"] else "pt" if "pt" in d["articles"] else None
        if lang:
            article = d["articles"][lang]
            title = urllib.parse.unquote(article.split("/wiki/", 1)[1]).replace("_", " ")
            grouped[lang].append((key, title, d["qid"]))
        else:
            ledger.add({"id": key, "status": "no-en-or-pt-article", "retrievedAt": now()})
    failures = 0
    for lang, items in grouped.items():
        for batch in chunks(items, 20):
            params = {"action": "query", "format": "json", "formatversion": "2", "redirects": "1",
                      "prop": "extracts|pageprops|revisions", "exintro": "1", "explaintext": "1", "exlimit": "20",
                      "rvprop": "ids|timestamp", "ppprop": "wikibase_item|disambiguation", "maxlag": "5",
                      "titles": "|".join(x[1] for x in batch)}
            url = "https://" + lang + ".wikipedia.org/w/api.php?" + urllib.parse.urlencode(params)
            try:
                raw, _ = get(url)
                data = json.loads(raw)
                if "error" in data:
                    raise SourceError("api-error")
                by_qid = collections.defaultdict(list)
                for p in data["query"]["pages"]:
                    by_qid[p.get("pageprops", {}).get("wikibase_item")].append(p)
                for key, title, qid in batch:
                    pages = by_qid[qid]
                    p = pages[0] if len(pages) == 1 else None
                    if p is None or "disambiguation" in p.get("pageprops", {}):
                        ledger.add({"id": key, "status": "identity-not-confirmed", "retrievedAt": now(), "qid": qid})
                        continue
                    revision = p.get("revisions", [{}])[0]
                    extract = p.get("extract", "")
                    ledger.add({"id": key, "status": "matched", "retrievedAt": now(), "qid": qid, "lang": lang,
                                "source": "https://" + lang + ".wikipedia.org/w/index.php?oldid=" + str(revision.get("revid", "")),
                                "title": p["title"], "revision": revision.get("revid"), "revisionTime": revision.get("timestamp"),
                                "sha256": hashlib.sha256(extract.encode()).hexdigest(), "lead": extract[:12000]})
                failures = 0
            except SourceError as error:
                failures += 1
                print(json.dumps({"source": "wikipedia", "status": error.status, "consecutiveFailures": failures}), flush=True)
                if failures >= 3 or error.status in ("http-403", "http-429"):
                    return
                time.sleep(3)
            print(json.dumps({"source": "wikipedia", "completed": len(ledger.rows)}), flush=True)
            time.sleep(0.3)


class LetterboxdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.synopsis, self.links, self.capture = [], [], None
        self.imdbs, self.canonical, self.tmdb = set(), None, None
        self.title = None

    def handle_starttag(self, tag, attributes):
        a = dict(attributes)
        synopsis = any(x[1] for x in self.stack) or (tag == "section" and "production-synopsis" in a.get("class", ""))
        genres = any(x[2] for x in self.stack) or a.get("id") == "tab-panel-genres"
        paragraph = any(x[3] for x in self.stack) or (tag == "p" and synopsis)
        if tag not in {"meta", "link", "img", "br", "hr", "input", "source", "wbr"}:
            self.stack.append((tag, synopsis, genres, paragraph))
        if tag == "meta" and a.get("property") == "og:title":
            self.title = a.get("content")
        if tag == "meta" and a.get("property") == "og:url":
            self.canonical = a.get("content")
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        if tag == "body":
            self.tmdb = {"id": a.get("data-tmdb-id"), "type": a.get("data-tmdb-type")}
        if tag == "a":
            href = a.get("href", "")
            parsed = urllib.parse.urlparse(href)
            m = re.match(r"/title/(tt\d+)(?:/|$)", parsed.path) if parsed.hostname in ("imdb.com", "www.imdb.com") and parsed.scheme in ("http", "https") else None
            if m:
                self.imdbs.add(m[1])
            if genres and re.match(r"/films/(genre|theme|mini-theme)/", href):
                self.capture = {"kind": href.split("/")[2], "url": "https://letterboxd.com" + href, "text": ""}

    def handle_data(self, data):
        if self.stack and self.stack[-1][3]:
            self.synopsis.append(data)
        if self.capture is not None:
            self.capture["text"] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.capture is not None:
            self.capture["text"] = re.sub(r"\s+", " ", self.capture["text"]).strip()
            self.links.append(self.capture)
            self.capture = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def parse_letterboxd(raw, expected, expected_slug=None, expected_tmdb=None):
    text = raw.decode("utf-8")
    parser = LetterboxdParser()
    parser.feed(text)
    # Ordinary film pages can carry captcha/challenge libraries in their footer.
    if not parser.title and re.search(r"Checking your browser|cf-chl-|challenge-platform|Just a moment|captcha", text, re.I):
        return {"status": "challenge-page"}
    if expected and re.search(r"No-one has added\s+[‘'\"]" + re.escape(expected) + r"[’'\"]\s+yet", html.unescape(text)):
        return {"status": "not-added", "sha256": hashlib.sha256(raw).hexdigest()}
    # A generic Open Graph title is not a film. Reject error documents before
    # interpreting a missing identifier as an actual identity disagreement.
    canonical_film = bool(parser.canonical and re.fullmatch(r"https://letterboxd\.com/film/[a-zA-Z0-9-]+/", parser.canonical))
    title_film = bool(parser.title and re.search(r"\(\d{4}\)\s*$", parser.title))
    tmdb_film = bool(parser.tmdb and str(parser.tmdb.get("id", "")).isdigit() and parser.tmdb.get("type") in ("movie", "tv"))
    # Some real pages have no release year, while older TV entries have no
    # TMDB ID. Retain either exact TMDB metadata or a dated title with IMDb.
    if not canonical_film or not parser.title or not (tmdb_film or title_film and parser.imdbs):
        status = "challenge-page" if re.search(r"Checking your browser|cf-chl-|challenge-platform|Just a moment|captcha", text, re.I) else "invalid-film-page"
        return {"status": status}
    if expected and parser.imdbs != {expected}:
        return {"status": "identity-not-confirmed", "foundIMDb": sorted(parser.imdbs),
                "source": parser.canonical, "title": parser.title, "tmdb": parser.tmdb,
                "sha256": hashlib.sha256(raw).hexdigest()}
    if not parser.title or not parser.canonical or not parser.canonical.startswith("https://letterboxd.com/film/"):
        return {"status": "invalid-film-page"}
    if not expected:
        path = urllib.parse.urlparse(parser.canonical).path
        if expected_slug is not None and path != "/film/" + expected_slug + "/":
            return {"status": "identity-not-confirmed", "reason": "canonical-slug-mismatch",
                    "source": parser.canonical, "title": parser.title, "tmdb": parser.tmdb,
                    "sha256": hashlib.sha256(raw).hexdigest()}
        if expected_tmdb is not None and (not parser.tmdb or parser.tmdb["type"] != "movie" or str(parser.tmdb["id"]) != str(expected_tmdb)):
            return {"status": "identity-not-confirmed", "reason": "tmdb-identity-mismatch",
                    "source": parser.canonical, "title": parser.title, "tmdb": parser.tmdb,
                    "sha256": hashlib.sha256(raw).hexdigest()}
    return {"status": "matched", "title": parser.title, "source": parser.canonical,
            "imdb": next(iter(parser.imdbs)) if len(parser.imdbs) == 1 else None,
            "tmdb": parser.tmdb, "synopsis": re.sub(r"\s+", " ", " ".join(parser.synopsis)).strip(),
            "facets": parser.links, "sha256": hashlib.sha256(raw).hexdigest()}


def letterboxd(records, ledger, limit, workers=4):
    pending = [r for r in records.values() if
               (r["id"] not in ledger.rows or ledger.rows[r["id"]]["status"] in
                ("invalid-film-page", "challenge-page", "identity-not-confirmed", "invalid-slug"))]
    # Validation cases first; all remaining records keep stable IMDb order.
    sample = {"tt5247022", "tt19770238", "tt0046438", "tt11813216", "tt0091251", "tt27503384", "tt0053604", "tt4016934"}
    pending.sort(key=lambda r: (r["id"] not in sample, r["id"]))
    if limit:
        pending = pending[:limit]
    gate = threading.Lock()
    next_request = [0.0]
    halted = threading.Event()

    def lookup(r):
        known = r["letterboxd"][0] if r["letterboxd"] else {}
        slug = known.get("slug")
        tmdb = known.get("tmdb") or (r.get("tmdb") or [{}])[0].get("id")
        if slug is not None and not re.fullmatch(r"[a-zA-Z0-9-]+", slug):
            # Cache placeholders such as film:80033 are internal identities,
            # not URL slugs. Use the exact IMDb/TMDB route instead.
            slug = None
        if slug:
            url = "https://letterboxd.com/film/" + slug + "/"
        elif r["imdb"] and IMDB.fullmatch(r["imdb"]):
            url = "https://letterboxd.com/imdb/" + r["imdb"] + "/"
        elif str(tmdb).isdigit():
            url = "https://letterboxd.com/tmdb/" + str(tmdb) + "/"
        else:
            raise RuntimeError("no exact Letterboxd lookup identity: " + r["id"])
        # One global start every quarter-second, bounded concurrent requests.
        with gate:
            time.sleep(max(0, next_request[0] - time.monotonic()))
            if halted.is_set():
                return r, None, False
            next_request[0] = time.monotonic() + 0.25
        try:
            raw, _ = get(url, 4_000_000)
            parsed = parse_letterboxd(raw, r["imdb"], slug, tmdb)
            if parsed["status"] == "not-added":
                parsed["source"] = url
            return r, parsed, parsed["status"] in ("challenge-page", "invalid-film-page")
        except SourceError as error:
            if error.status == "http-404":
                return r, {"status": "http-404", "source": url}, False
            return r, {"status": error.status, "source": url}, True

    failures, previous, processed = 0, 0, 0
    iterator = iter(pending)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        active = {executor.submit(lookup, r) for r in [next(iterator, None) for _ in range(workers)] if r}
        while active:
            done, active = concurrent.futures.wait(active, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                r, result, error = future.result()
                if result is not None:
                    processed += 1
                    if error:
                        failures += 1
                        print(json.dumps({"source": "letterboxd", "status": result["status"], "consecutiveFailures": failures}), flush=True)
                        if failures >= 3 or result["status"] in ("http-403", "http-429"):
                            halted.set()
                    else:
                        ledger.add({"id": r["id"], "retrievedAt": now(), **result})
                        failures = 0
                if not halted.is_set():
                    r = next(iterator, None)
                    if r:
                        active.add(executor.submit(lookup, r))
            if processed - previous >= 100:
                print(json.dumps({"source": "letterboxd", "recorded": len(ledger.rows), "processedThisRun": processed,
                                  "remainingThisRun": len(pending) - processed}), flush=True)
                previous = processed


def report(records, ledgers):
    counts = {name: dict(collections.Counter(r["status"] for key, r in ledger.rows.items() if key in records)) for name, ledger in ledgers.items()}
    pending = {name: sum((r["imdb"] is not None if name in ("imdb", "wikidata") else True if name == "letterboxd" else
                         ledgers["wikidata"].rows.get(key, {}).get("status") == "matched") and
                        (key not in ledger.rows or ledger.rows[key]["status"] in ("challenge-page", "invalid-film-page", "invalid-slug"))
                        for key, r in records.items()) for name, ledger in ledgers.items()}
    summary = {"generatedAt": now(), "catalogueRecords": len(records), "imdbIdentified": sum(bool(r["imdb"]) for r in records.values()),
               "noIMDb": sum(not r["imdb"] for r in records.values()), "sources": counts,
               "pending": pending, "completedEditorialReview": 0, "productionApplied": False}
    atomic(STATE / "coverage.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["inventory", "imdb", "wikidata", "wikipedia", "letterboxd", "report"])
    parser.add_argument("--limit", type=int, default=0, help="Letterboxd requests; 0 is the whole corpus")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    records = inventory()
    atomic(STATE / "inventory.json", records)
    ledgers = {name: Ledger(name) for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
    if args.stage == "imdb":
        imdb_bulk(records, ledgers["imdb"])
    elif args.stage == "wikidata":
        wikidata(records, ledgers["wikidata"])
    elif args.stage == "wikipedia":
        wikipedia(ledgers["wikidata"], ledgers["wikipedia"])
    elif args.stage == "letterboxd":
        letterboxd(records, ledgers["letterboxd"], args.limit, args.workers)
    # Other source processes may have progressed since this process started.
    report(records, {name: Ledger(name) for name in ledgers})


if __name__ == "__main__":
    main()
