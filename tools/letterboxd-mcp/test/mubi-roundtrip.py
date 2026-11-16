"""Writes a SYNTHETIC MUBI cache with the real collector (scripts/collect-mubi.py) over a scripted fake network, for test/mubi-roundtrip.test.js.

    python3 -B test/mubi-roundtrip.py <output folder>

The network function is injected: no socket is ever opened, and urllib's opener is replaced by a function that fails if it is reached.
Every text and number is invented; the film ids are the ones of the test fixture (test/fixture). Prints the scenario ids as JSON.
"""
import importlib.util
import json
from pathlib import Path
import sys
import urllib.parse

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("collect_mubi", HERE.parents[3] / "scripts" / "collect-mubi.py")
mubi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mubi)

NOW = "2026-10-12T20:00:00.000Z"


def film(imdb, title):
    return {"imdb": imdb, "title": title, "year": 2001, "directors": ["Invented Director"], "runtime": 90}


def item(id, title, **over):
    d = {"id": id, "slug": "invented-%d" % id, "title": title, "title_locale": "en-US", "original_title": title, "year": 2001, "duration": 91,
         "web_url": "https://mubi.com/films/invented-%d" % id, "directors": [{"name": "Invented Director"}],
         "default_editorial": "Invented editorial text %d." % id, "short_synopsis": "Invented short synopsis %d." % id,
         "average_rating": 3.7, "average_rating_out_of_ten": 7.4, "number_of_ratings": 1234}
    d.update(over)
    return d


def answer(items):
    return 200, "application/json", json.dumps({"films": items}).encode()


# imdb id (the test fixture's) -> (title asked, what the fake MUBI answers to its search)
SCENARIOS = {
    "tt0000007": ("Alpha", [item(1, "Alpha")]),                                                       # confirmed, three fields
    "tt0000001": ("Bravo", [item(2, "Bravo", default_editorial=None, short_synopsis=None)]),           # two texts absent
    "tt0000002": ("Charlie", [item(3, "Charlie")]),                                                   # synopsis key missing (deleted below)
    "tt0000003": ("Delta", [item(4, "Delta", number_of_ratings=0, average_rating=0, average_rating_out_of_ten=0)]),  # no votes
    "tt0000004": ("Echo", [item(5, "Echo"), item(6, "Echo")]),                                         # ambiguous
    "tt0000005": ("Foxtrot", [item(7, "Foxtrot", average_rating=None)]),                               # average null inside an available rating
    "tt0000006": ("Golf", [item(8, "Golf", number_of_ratings=-3)]),                                    # votes that are not a count
    "tt0000008": ("Hotel", [item(9, "Hotel", default_editorial="<b>Bold</b> take <script>x()</script>done.")]),  # tags: the MCP strips them
    "tt0000009": ("India", []),                                                                        # not found in a search that answered
    "tt0000011": ("Juliet", [item(11, "Juliet")]),                                                     # confirmed first, then stale below
    "tt0000016": ("Kilo", [item(12, "Kilo")]),                                                         # error: the network fails
}


def main(out):
    out = Path(out)
    films = [film(imdb, title) for imdb, (title, _) in SCENARIOS.items()]
    key_missing = SCENARIOS["tt0000002"][1][0]
    del key_missing["short_synopsis"]

    def fetch(url, headers):
        if "/v3/films/" in url:  # a detail request (a key was missing): the same object, key still missing
            wanted = int(url.rsplit("/", 1)[1])
            for _, items in SCENARIOS.values():
                for it in items:
                    if it["id"] == wanted:
                        return 200, "application/json", json.dumps(it).encode()
            raise AssertionError("unscripted detail: " + url)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        title = query["query"][0] if "query" in query else None
        for imdb, (asked, items) in SCENARIOS.items():
            if asked == title:
                if imdb == "tt0000016":
                    raise mubi.NetworkError("network-error")
                return answer(items)
        raise AssertionError("unscripted request: " + url)

    kw = dict(fetch=fetch, interval=0.0, sleep=lambda s: None, now=lambda: NOW)
    mubi.collect(films, out, **kw)
    # Juliet (confirmed) and Echo (ambiguous) are asked again while the network fails: Juliet's valid record stays, marked stale with the last error;
    # Echo's candidates stay, with the last error and without `stale` (an ambiguity is not a stale confirmation).
    def failing(url, headers):
        raise mubi.NetworkError("network-error")
    mubi.collect([film("tt0000011", "Juliet"), film("tt0000004", "Echo")], out, fetch=failing, interval=0.0, sleep=lambda s: None,
                 now=lambda: "2026-10-13T01:00:00.000Z", refresh=True)
    print(json.dumps(sorted(SCENARIOS)))


if __name__ == "__main__":
    import urllib.request
    urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("real network"))
    main(sys.argv[1])
