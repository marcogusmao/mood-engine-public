#!/usr/bin/env python3
"""A stand-in for scripts/collect-mubi.py for test/mubi-nightly.test.js: the REAL collector (its argument parser, identity rules, record shapes, stops,
exit codes and files) with its network function replaced by a table, so nothing here can reach api.mubi.com (the real function and urllib's opener are
both made to raise). The films it can "find" are the ones in the --input file; each is answered as one MUBI search result that passes the identity rules.

FAKE_MUBI_MODE: unset = every search answers;  403 = the third request is answered HTTP 403 (the collector stops, exit 2);  network = every request fails
(three in a row: exit 4);  exit1 = print an error and leave with 1 without touching the folder;  garbage = after a normal run, mubi.json is overwritten with
text that is not JSON;  extra = after a normal run, the first confirmed record gets a field off the allowlist;  empty-seed = the collector is given an empty
cache (the seeded copy is deleted first), so its output lacks the films the old cache had.
FAKE_MUBI_NO_TAKE: comma-separated IMDb ids answered without an Our Take.
The three ways a film ends "ambiguous" in the real collector (comma-separated IMDb ids in each variable; the records are made by its own functions):
FAKE_MUBI_TWO: the search returns two results that both pass the identity rules;  FAKE_MUBI_DURATION: one result whose duration differs by 60 minutes;
FAKE_MUBI_SLUG: the search answers HTTP 500, so the collector asks /v3/films/<slug> (a film with no runtime then ends "slug-fallback-runtime-unverifiable").
FAKE_MUBI_CRED: comma-separated IMDb ids answered with an Our Take that has the shape of a credential ("api_key=…").
FAKE_MUBI_FAIL: comma-separated IMDb ids whose search always fails with a network error (an error record each, and three in a row stop the collector).
FAKE_MUBI_LOG: a file where argv and every request URL are appended as JSON lines.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collect_mubi", ROOT / "scripts" / "collect-mubi.py")
mubi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mubi)

LOG = os.environ.get("FAKE_MUBI_LOG")
MODE = os.environ.get("FAKE_MUBI_MODE", "")
def ids(name):
    return {x for x in os.environ.get(name, "").split(",") if x}


NO_TAKE, TWO, DURATION, SLUG, FAIL, CRED = (ids(n) for n in ("FAKE_MUBI_NO_TAKE", "FAKE_MUBI_TWO", "FAKE_MUBI_DURATION", "FAKE_MUBI_SLUG", "FAKE_MUBI_FAIL", "FAKE_MUBI_CRED"))


def log(entry):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as out:
            out.write(json.dumps(entry) + "\n")


def arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def never_the_network(*a, **k):
    raise AssertionError("the fake collector reached for the real network")


mubi.urllib.request.urlopen = never_the_network
mubi.build_opener = never_the_network
mubi.time.sleep = lambda seconds: None  # the 2 s interval is checked as an argument, not waited for

log({"argv": sys.argv[1:]})
if MODE == "exit1":
    print("erro: input needs a non-empty films list", file=sys.stderr)
    sys.exit(1)

films = {}
if arg("--input"):
    for f in json.loads(Path(arg("--input")).read_text(encoding="utf-8"))["films"]:
        films[f["title"]] = f
made = []


def item_of(f, **over):
    n = int(f["imdb"][2:]) + over.pop("shift", 0)
    item = {"id": n, "slug": "film-%d" % n, "title": f["title"], "title_locale": "en-US", "original_title": f["title"], "year": f["year"],
            "duration": f["runtime"], "web_url": "https://mubi.com/films/film-%d" % n, "directors": [{"name": d, "slug": "x"} for d in f["directors"]],
            "default_editorial": None if f["imdb"] in NO_TAKE else ("Read it: api_key=abc123 for %s." if f["imdb"] in CRED else "Our take on %s.") % f["title"],
            "short_synopsis": "A short synopsis of %s." % f["title"], "average_rating": 4.0, "average_rating_out_of_ten": 8.0, "number_of_ratings": 1200,
            "critic_review_rating": 4.9, "press_quote": "kept out of the cache", "star_rating": 3}
    item.update(over)
    return item


def answer(body, status=200):
    return status, "application/json", json.dumps(body).encode(), {}


def fake_get(url, headers, limit=4_000_000, opener=None):
    made.append(url)
    log({"request": url})
    parts = urllib.parse.urlsplit(url)
    if parts.path.startswith("/v3/films/"):  # the collector's alternative route, asked only after a 5xx on the search
        f = next((f for f in films.values() if mubi.slugify(f["title"]) == parts.path.rsplit("/", 1)[1]), None)
        return answer(item_of(f)) if f else (404, "application/json", b"{}", {})
    query = urllib.parse.parse_qs(parts.query).get("query", [""])[0]
    f = films.get(query)
    if f is not None and f["imdb"] in FAIL or MODE == "network":
        raise mubi.NetworkError("network-error")
    if MODE == "403" and len(made) == 3:
        return 403, "text/plain", b"", {"retry-after": "60"}
    if f is None:
        return answer({"films": []})
    if f["imdb"] in SLUG:
        return 500, "text/plain", b"upstream broke", {}
    if f["imdb"] in TWO:
        return answer({"films": [item_of(f), item_of(f, shift=500000)]})
    if f["imdb"] in DURATION:
        return answer({"films": [item_of(f, duration=(f["runtime"] or 90) + 60)]})
    return answer({"films": [item_of(f)]})


mubi.http_get = fake_get
if MODE == "empty-seed":
    seed = Path(arg("--out")) / "mubi.json"
    if seed.exists():
        seed.unlink()
code = mubi.main()
cache_file = Path(arg("--out")) / "mubi.json"
if MODE == "garbage":
    cache_file.write_text("{not json", encoding="utf-8")
elif MODE == "extra" and cache_file.exists():
    cache = json.loads(cache_file.read_text(encoding="utf-8"))
    for record in cache["films"].values():
        if record["status"] == "confirmed":
            record["userRating"] = 4.5
            record["request"]["cookie"] = "session=planted"
            break
    cache_file.write_text(json.dumps(cache, indent=1), encoding="utf-8")
sys.exit(code)
