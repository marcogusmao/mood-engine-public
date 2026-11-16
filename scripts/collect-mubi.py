#!/usr/bin/env python3
"""Collect MUBI's Our Take, short synopsis and community rating for a list of films.

One public GET at a time against api.mubi.com/v3, one search per film. The network
only ever receives the film TITLE: year, directors, runtime and IMDb id stay local and
are used to confirm which MUBI entry is the film. The result is a cache, never a
ground truth: contract in skills/mubi-research/references/cache-contract.md (cache format,
identity rules, field states). Standard library only.

Search answering HTTP 5xx (and only that) opens one alternative route per film: the detail
at /v3/films/<slug>, slug derived from the title, judged by the same identity rules.

Stops (non-zero exit, reason and resume point in report.json) on: HTTP 403/429, a challenge
page (a 200 that is not JSON, or any status whose body or headers say "challenge"),
three failures in a row, the request ceiling. After a block, wait before repeating (the
Retry-After header is shown when the server sends one). It never changes headers or
identity to get around a block and never raises the ceiling by itself. Resuming: a plain run
that stopped is repeated with the same command (confirmed, non-stale films are skipped; a stale
one is asked again). A --refresh that stopped is resumed with --resume: it starts at the film where it
stopped (resumeFrom in report.json) and asks nothing again for the films refreshed before it in
that execution; the stop message prints the exact command. Redirects are never followed (a 3xx is
a failure of that film); the connection is pinned to https://api.mubi.com with no proxy.

Exit codes: 0 finished, 1 bad input/cache, 2 blocked (403/429/challenge),
3 request ceiling, 4 three failures in a row, 130 interrupted.
"""
import argparse
import collections
import datetime
import http.client
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

UA = "MoodEngineMubiCollector/1.0 (personal film catalogue; https://github.com/marcogusmao/mood-engine)"
API = "https://api.mubi.com"
# Fixed identity: these are the only headers ever sent, and they are never varied.
HEADERS = {"Client": "web", "Client-Country": "US", "Accept-Language": "en",
           "Accept": "application/json", "Accept-Encoding": "identity", "User-Agent": UA}
HOST = "api.mubi.com"
CHALLENGE = re.compile(r"just a moment|checking your browser|cf-chl|challenge-platform|captcha|attention required", re.I)
IMDB = re.compile(r"tt\d{5,12}\Z")
LOCALE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\Z")
MAX_TEXT = 4000
CONSECUTIVE_FAILURES = 3
# Keys the cache needs from the film object; a missing one is the only reason to ask for the detail.
NEEDED = ("default_editorial", "short_synopsis", "average_rating_out_of_ten", "average_rating",
          "number_of_ratings", "title_locale")
EXIT = {"blocked-http-403": 2, "blocked-http-429": 2, "challenge": 2, "max-requests": 3,
        "consecutive-failures": 4, "interrupted": 130}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NetworkError(Exception):
    """Connection, timeout or oversize problem: no HTTP answer to judge."""


class Failure(Exception):
    """One request failed in a way that counts toward the three-in-a-row limit."""

    def __init__(self, reason, status=None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class Stop(Exception):
    """The run must end. film_error: the film in progress is recorded as an error."""

    def __init__(self, reason, film_error=True, retry_after=None):
        super().__init__(reason)
        self.reason = reason
        self.film_error = film_error
        self.retry_after = retry_after


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the 3xx itself is the answer (a failure of that film)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener(extra=()):
    """Own opener: no proxy taken from the environment, no redirects. `extra` handlers are for tests."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect, *extra)


def http_get(url, headers, limit=4_000_000, opener=None):
    """Real network. Returns (status, content_type, body, headers). HTTP errors are answers, not exceptions."""
    opener = opener or build_opener()
    request = urllib.request.Request(url, headers=headers)
    try:
        try:
            with opener.open(request, timeout=45) as response:
                final, status, got, body = response.geturl(), response.status, response.headers, response.read(limit + 1)
        except urllib.error.HTTPError as error:
            final, status, got, body = url, error.code, error.headers, error.read(limit + 1)
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        raise NetworkError("network-error") from None
    parts = urllib.parse.urlsplit(final)
    if parts.scheme != "https" or parts.hostname != HOST:
        raise NetworkError("unexpected-final-url")
    if len(body) > limit:
        raise NetworkError("response-too-large")
    lower = {str(k).lower(): v for k, v in got.items()} if got else {}
    return status, lower.get("content-type", ""), body, lower


def atomic_write(path, value):
    """Serialize first, write a temp file in the same directory, then os.replace over the target."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, indent=1, allow_nan=False) + "\n"
    tmp = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- identity

_FOLD = {ord("ø"): "o", ord("đ"): "d", ord("ł"): "l", ord("ð"): "d", ord("þ"): "th",
         ord("ß"): "ss", ord("æ"): "ae", ord("œ"): "oe"}


def norm(value):
    """NFKD, no diacritics, lower case, '&' -> 'and', punctuation -> space, spaces collapsed."""
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFKD", value).lower().translate(_FOLD)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return re.sub(r"[\W_]+", " ", text.replace("&", " and ")).strip()


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def names(item):
    out = []
    for d in item.get("directors") if isinstance(item.get("directors"), list) else []:
        if isinstance(d, dict) and isinstance(d.get("name"), str):
            out.append(d["name"])
    return out


def found_of(item):
    return {"title": item.get("title"), "originalTitle": item.get("original_title"), "year": item.get("year"),
            "directors": names(item), "duration": item.get("duration")}


def mubi_of(item):
    slug = item.get("slug") if isinstance(item.get("slug"), str) and re.fullmatch(r"[A-Za-z0-9_-]+", item["slug"]) else None
    url = item.get("web_url")
    if not (isinstance(url, str) and url.startswith("https://mubi.com/")):
        url = "https://mubi.com/films/" + slug if slug else None
    return {"id": item["id"], "slug": slug, "url": url}


def judge(asked, item):
    """Contract rules 1-4 for one search result. 'core' = title, year and director all hold."""
    evidence, note = [], ""
    want = norm(asked["title"])
    if want and norm(item.get("title")) == want:
        evidence.append("title")
    elif want and isinstance(item.get("original_title"), str) and \
            any(norm(part) == want for part in item["original_title"].split(" | ")):
        evidence.append("original_title")
    year, found_year = asked.get("year"), item.get("year")
    year_ok = is_number(year) and is_number(found_year) and abs(year - found_year) <= 1
    if year_ok:
        evidence.append("year")
        if year != found_year:
            note = "year-differs-by-1 (asked %s, found %s)" % (year, found_year)
    mine = {norm(d) for d in asked.get("directors", [])} - {""}
    director_ok = bool(mine & {norm(d) for d in names(item)})
    if director_ok:
        evidence.append("director")
    core = len(evidence) == 3
    runtime, duration = asked.get("runtime"), item.get("duration")
    duration_conflict = is_number(runtime) and is_number(duration) and abs(runtime - duration) > 20
    return {"core": core, "evidence": evidence, "note": note, "duration_conflict": duration_conflict}


def decide(asked, items):
    """Returns ('confirmed', item, judgement) | ('ambiguous', candidates) | ('not_found_in_search',)."""
    full, partial, seen = [], [], set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), int) or isinstance(item["id"], bool) \
                or item["id"] in seen:
            continue
        seen.add(item["id"])
        j = judge(asked, item)
        if j["core"]:
            (partial if j["duration_conflict"] else full).append((item, j))
    if len(full) == 1:
        item, j = full[0]
        if partial:
            j["note"] = (j["note"] + "; " if j["note"] else "") + \
                "also-seen-with-duration-differing-over-20-min: " + ",".join(str(p[0]["id"]) for p in partial)
        return ("confirmed", item, j)
    if full or partial:
        candidates = [{"mubi": mubi_of(i), "found": found_of(i), "evidence": j["evidence"],
                       "why": "passes-all-checks" if not j["duration_conflict"] else "duration-differs-more-than-20-min"}
                      for i, j in full + partial]
        return ("ambiguous", candidates)
    return ("not_found_in_search",)


# ---------------------------------------------------------------- fields

def text_state(item, key, extra=None):
    extra = extra or {}
    if key not in item:
        return dict(extra, state="unknown", reason="missing")
    value = item[key]
    if value is None:
        return dict(extra, state="absent")
    if not isinstance(value, str):
        return dict(extra, state="unknown", reason="invalid")
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]+", " ", value).strip()
    if not text:
        return dict(extra, state="absent")
    if len(text) > MAX_TEXT:
        return dict(extra, state="unknown", reason="too-long")
    return dict(extra, state="available", text=text)


INVALID = object()


def votes_of(item):
    """A count (int >= 0), "unknown" when it did not come (key missing or null), INVALID when it came as something that is not a count."""
    v = item.get("number_of_ratings", None)
    if v is None:
        return "unknown"
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else INVALID


def rating_state(item):
    """Original numbers only: no conversion between scales, no rounding."""
    votes = votes_of(item)
    if votes is INVALID:  # negative, fractional, text, a list...: a rating whose count is wrong is not trusted
        return {"state": "unknown", "reason": "invalid", "votes": "unknown"}
    if votes == 0:  # a rating with no votes is not a rating, whatever value came with it
        return {"state": "absent", "reason": "no-votes", "votes": 0}

    def look(key, high):
        if key not in item:
            return "missing", None
        v = item[key]
        if v is None:
            return "null", None
        return ("valid", v) if is_number(v) and 0 <= v <= high else ("invalid", None)

    out_kind, out = look("average_rating_out_of_ten", 10)
    avg_kind, avg = look("average_rating", 5)
    if "invalid" in (out_kind, avg_kind):
        return {"state": "unknown", "reason": "invalid", "votes": votes}
    if out_kind == "valid" and avg_kind == "valid":
        if abs(avg * 2 - out) > 0.15 + 1e-9:
            return {"state": "unknown", "reason": "inconsistent", "votes": votes}
        return {"state": "available", "outOfTen": out, "average": avg, "votes": votes}
    if out_kind == "valid":
        return {"state": "available", "outOfTen": out, "average": None, "votes": votes}
    if avg_kind == "valid":
        # null scale-10 beside a real scale-5 contradicts itself; a missing one cannot be converted.
        return {"state": "unknown", "reason": "inconsistent" if out_kind == "null" else "no-out-of-ten", "votes": votes}
    if out_kind == "null" and avg_kind == "null":
        return {"state": "absent", "votes": votes}  # both scales came as null: the answer says there is no rating
    # No usable scale and not both null: at least one key did not come (missing + missing, missing + null), so we do not know.
    return {"state": "unknown", "reason": "missing", "votes": votes}


def locale_of(item):
    v = item.get("title_locale")
    return v if isinstance(v, str) and LOCALE.fullmatch(v) else "unknown"


# ---------------------------------------------------------------- session / collection

class Session:
    """One request at a time, minimum interval, request ceiling, failure streak."""

    def __init__(self, fetch, interval, max_requests, clock, sleep):
        self.fetch, self.interval, self.max, self.clock, self.sleep = fetch, interval, max_requests, clock, sleep
        self.made, self.kinds, self.consecutive, self.last_end = 0, collections.Counter(), 0, None

    def get_json(self, url, kind):
        if self.made >= self.max:
            raise Stop("max-requests", film_error=False)
        if self.last_end is not None:
            wait = self.last_end + self.interval - self.clock()
            if wait > 0:
                self.sleep(wait)
        self.made += 1
        self.kinds[kind] += 1
        try:
            result = self.fetch(url, dict(HEADERS))
        except (NetworkError, http.client.HTTPException, OSError) as error:
            self.last_end = self.clock()
            self.consecutive += 1
            raise Failure(str(error) if isinstance(error, NetworkError) and str(error) else "network-error") from None
        self.last_end = self.clock()
        status, ctype, body = result[0], result[1], result[2]
        headers = {str(k).lower(): v for k, v in (result[3] if len(result) > 3 and result[3] else {}).items()}
        retry_after = headers.get("retry-after")
        if status in (403, 429):
            raise Stop("blocked-http-%d" % status, retry_after=retry_after)
        json_type = "json" in (ctype or "").lower()
        # A challenge page can come with any status (a 5xx included): stop, never open another route.
        if str(headers.get("cf-mitigated", "")).lower() == "challenge" or \
                (status != 200 and not json_type and CHALLENGE.search(body[:50000].decode("utf-8", "replace"))):
            raise Stop("challenge", retry_after=retry_after)
        if status != 200:
            self.consecutive += 1
            raise Failure("http-%s" % status, status)
        # A 200 that is not JSON is a challenge page: stop, never try to get past it.
        if not json_type:
            raise Stop("challenge", retry_after=retry_after)
        if body.lstrip(b"\xef\xbb\xbf \t\r\n")[:1] == b"<":
            raise Stop("challenge", retry_after=retry_after)
        try:
            data = json.loads(body.decode("utf-8"))
        except ValueError:
            raise Stop("challenge", retry_after=retry_after) from None
        if not isinstance(data, dict):
            self.consecutive += 1
            raise Failure("unexpected-shape")
        self.consecutive = 0
        return data


def slugify(title):
    """Title -> MUBI-style slug: normalised, ASCII alphanumerics joined by single '-', none at the ends."""
    return re.sub(r"[^a-z0-9]+", "-", norm(title)).strip("-")


def search_url(title):
    return API + "/v3/search/films?" + urllib.parse.urlencode({"query": title, "per_page": 10}, quote_via=urllib.parse.quote)


def base_record(film, status, at):
    return {"status": status, "capturedAt": at,
            "request": {"country": HEADERS["Client-Country"], "acceptLanguage": HEADERS["Accept-Language"], "query": film["title"]},
            "identity": {"asked": {"title": film["title"], "year": film["year"], "directors": list(film["directors"]),
                                   "runtime": film["runtime"]}}}


def error_record(film, reason, at):
    record = base_record(film, "error", at)
    record["error"] = {"at": at, "reason": reason}
    return record


def not_found_record(film, at, results, note="", **searched):
    record = base_record(film, "not_found_in_search", at)
    record["searched"] = dict({"results": results}, **searched)
    if note:
        record["identity"]["note"] = note
    return record


def confirmed_record(film, item, j, merged, at, detail_state, extra_evidence=(), extra_note=""):
    record = base_record(film, "confirmed", at)
    record["request"]["detail"] = detail_state
    record["mubi"] = mubi_of(item)
    note = "; ".join(x for x in (j["note"], extra_note) if x)
    record["identity"].update({"found": found_of(item), "evidence": j["evidence"] + list(extra_evidence), "note": note})
    record["locale"] = locale_of(merged)
    record["ourTake"] = text_state(merged, "default_editorial")
    record["synopsis"] = text_state(merged, "short_synopsis", {"kind": "short"})
    record["rating"] = rating_state(merged)
    return record


def slug_fallback(film, session, now, search_reason):
    """Search answered 5xx: one detail request by slug, same identity rules. At most one failure per film.

    Never a "not found": the search failed, so a slug that does not answer, answers nonsense or answers
    another film leaves the film as an error. A duration that cannot be compared leaves it ambiguous."""
    slug = slugify(film["title"])
    if not slug:
        raise Failure(search_reason)
    # The search failure just counted is replaced by this route's outcome: one film, at most one failure.
    before = max(0, session.consecutive - 1)
    session.consecutive = before
    try:
        data = session.get_json(API + "/v3/films/" + slug, "slug")
    except Failure as failure:
        if failure.status == 404:
            raise Failure("search-5xx-slug-404", 404) from None
        raise
    if not isinstance(data.get("id"), int) or isinstance(data["id"], bool):
        session.consecutive = before + 1
        raise Failure("slug-fallback-invalid-response")
    verdict = decide(film, [data])
    if verdict[0] == "not_found_in_search":
        session.consecutive = before + 1
        raise Failure("slug-fallback-mismatch")
    via = {"via": "slug-fallback", "slug": slug}
    if verdict[0] == "ambiguous":
        record = base_record(film, "ambiguous", now())
        record["candidates"] = verdict[1]
        record["request"].update(via)
        return record
    _, item, j = verdict
    if not (is_number(film.get("runtime")) and is_number(item.get("duration"))):
        record = base_record(film, "ambiguous", now())
        record["candidates"] = [{"mubi": mubi_of(item), "found": found_of(item), "evidence": j["evidence"] + ["slug-fallback"],
                                 "why": "slug-fallback-runtime-unverifiable"}]
        record["identity"]["note"] = "slug-fallback-runtime-unverifiable"
        record["request"].update(via)
        return record
    record = confirmed_record(film, item, j, item, now(), "not-needed", ("slug-fallback",),
                              "identity-via-slug-fallback (search answered %s)" % search_reason)
    record["request"].update(via)
    return record


def collect_film(film, session, now):
    try:
        data = session.get_json(search_url(film["title"]), "search")
    except Failure as failure:
        if failure.status is not None and 500 <= failure.status <= 599:
            return slug_fallback(film, session, now, failure.reason)
        raise
    items = data.get("films")
    if not isinstance(items, list):
        session.consecutive += 1
        raise Failure("unexpected-shape")
    verdict = decide(film, items)
    if verdict[0] == "not_found_in_search":
        return not_found_record(film, now(), len(items))
    if verdict[0] == "ambiguous":
        record = base_record(film, "ambiguous", now())
        record["candidates"] = verdict[1]
        return record
    _, item, j = verdict
    merged, detail_state = dict(item), "not-needed"
    if any(key not in item for key in NEEDED):
        # A detail that fails or answers for another film is an error of this film (never a silent unknown).
        detail = session.get_json(API + "/v3/films/" + str(item["id"]), "detail")
        if detail.get("id") != item["id"]:
            session.consecutive += 1
            raise Failure("detail-id-mismatch")
        detail_state = "ok"
        merged.update({k: detail[k] for k in NEEDED if k not in item and k in detail})
    return confirmed_record(film, item, j, merged, now(), detail_state)


def keep_or_replace(previous, new, at):
    """A failed or unconfirmed refresh never discards the last valid record; an error never replaces an ambiguity."""
    if new["status"] == "confirmed" or not previous:
        return new
    reason = new["error"]["reason"] if new["status"] == "error" else "refresh-" + new["status"]
    if previous.get("status") == "confirmed":
        kept = dict(previous)
        kept["stale"] = True
        kept["lastError"] = {"at": at, "reason": reason}
        return kept
    if previous.get("status") == "ambiguous" and new["status"] == "error":
        kept = dict(previous)
        kept["lastError"] = {"at": at, "reason": reason}
        return kept
    return new


def load_cache(path, now):
    if not path.exists():
        return {"schema": 1, "source": "api.mubi.com/v3", "updatedAt": now(), "films": {}}
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        cache = None
    if not (isinstance(cache, dict) and cache.get("schema") == 1 and isinstance(cache.get("films"), dict)):
        raise ValueError("existing cache is not a schema 1 mubi.json: " + str(path))
    return cache


def summarize(films, cache, run, now):
    """`thisRun` is what this execution did; `cache` is what the cache holds for the requested films."""
    records = [cache["films"].get(f["imdb"]) for f in films]
    status = collections.Counter(r["status"] if r else "not_attempted" for r in records)
    confirmed = [r for r in records if r and r["status"] == "confirmed"]
    n = len(confirmed)

    def available(key):
        return {"available": sum(r[key]["state"] == "available" for r in confirmed), "of": n}

    return {
        "schema": 1, "generatedAt": now(), "requested": len(films), "thisRun": run,
        "cache": {
            "status": {k: status.get(k, 0) for k in ("confirmed", "ambiguous", "not_found_in_search", "error", "not_attempted")},
            "staleConfirmed": sum(bool(r.get("stale")) for r in confirmed),
            "amongConfirmed": {"ourTake": available("ourTake"), "synopsis": available("synopsis"), "rating": available("rating"),
                               "votesUnknown": {"count": sum(r["rating"]["votes"] == "unknown" for r in confirmed), "of": n}},
            "locales": dict(sorted(collections.Counter(r["locale"] for r in confirmed).items()))},
        "films": [{"imdb": f["imdb"], "status": r["status"] if r else "not_attempted",
                   "mubiId": r["mubi"]["id"] if r and r["status"] == "confirmed" else None,
                   "stale": bool(r and r.get("stale"))} for f, r in zip(films, records)],
    }


def load_runs(path):
    """History of earlier executions from an existing report.json; none are invented when there is none."""
    try:
        runs = json.loads(path.read_text(encoding="utf-8")).get("runs")
    except (OSError, ValueError, AttributeError):
        return []
    return runs if isinstance(runs, list) else []


def resume_point(out, films):
    """The film where the last execution stopped, when that execution was a --refresh that stopped; ValueError otherwise (nothing is asked)."""
    runs = load_runs(Path(out) / "report.json")
    last = runs[-1] if runs and isinstance(runs[-1], dict) else {}
    stopped = last.get("stopped") if isinstance(last.get("stopped"), dict) else None
    if not (last.get("refresh") and stopped and isinstance(stopped.get("resumeFrom"), str)):
        raise ValueError("nothing to resume: the last execution recorded in %s was not a --refresh that stopped" % (Path(out) / "report.json"))
    if stopped["resumeFrom"] not in [f["imdb"] for f in films]:
        raise ValueError("the resume point %s is not in this input: use the input of the interrupted run" % stopped["resumeFrom"])
    return stopped["resumeFrom"]


def collect(films, out, fetch=None, max_requests=100, interval=2.0, refresh=False,
            clock=None, sleep=None, now=utc_now, resume=False):
    """Collect `films` into <out>/mubi.json (after every film) and <out>/report.json. Returns the report.

    resume=True continues a --refresh that stopped: it starts at the film where it stopped and does not ask again for the films
    before it (they were refreshed in that execution). It implies refresh and raises ValueError, before any request, when there is
    nothing to resume."""
    fetch = fetch or http_get
    clock = clock or time.monotonic
    sleep = sleep or time.sleep
    out = Path(out)
    first = 0
    if resume:
        point = resume_point(out, films)
        first, refresh = [f["imdb"] for f in films].index(point), True
    cache_path = out / "mubi.json"
    cache = load_cache(cache_path, now)
    prior_runs = load_runs(out / "report.json")
    session = Session(fetch, interval, max_requests, clock, sleep)
    started, started_at, stop = clock(), now(), None
    outcomes = collections.Counter()
    for film in films[first:]:
        previous = cache["films"].get(film["imdb"])
        # A confirmed record is kept unless --refresh; a stale one (an earlier refresh of it failed) is asked again, or it would stay stale forever.
        if previous and previous.get("status") == "confirmed" and not previous.get("stale") and not refresh:
            continue
        new = None
        try:
            new = collect_film(film, session, now)
        except Failure as failure:
            new = error_record(film, failure.reason, now())
        except Stop as halt:
            if halt.film_error:
                new = error_record(film, halt.reason, now())
            stop = {"reason": halt.reason}
            if halt.retry_after:
                stop["retryAfter"] = str(halt.retry_after)
            if halt.reason in ("blocked-http-403", "blocked-http-429", "challenge"):
                stop["waitBeforeRetry"] = True
        except KeyboardInterrupt:
            stop = {"reason": "interrupted"}
        if new is not None:
            outcomes[new["status"]] += 1
            cache["films"][film["imdb"]] = keep_or_replace(previous, new, now())
            cache["updatedAt"] = now()
            atomic_write(cache_path, cache)
        if stop is None and session.consecutive >= CONSECUTIVE_FAILURES:
            stop = {"reason": "consecutive-failures"}
        if stop:
            stop.update({"film": film["imdb"], "resumeFrom": film["imdb"], "requestsMade": session.made,
                         "exitCode": EXIT[stop["reason"]],
                         "how": ("run the command with --resume: it starts at this film and does not ask again for the ones refreshed before it"
                                 if refresh else "run the same command again: confirmed films are skipped, the rest is retried")})
            break
    if not cache_path.exists():
        atomic_write(cache_path, cache)
    run = {"startedAt": started_at, "finishedAt": now(), "refresh": bool(refresh),
           **({"resumedFrom": films[first]["imdb"]} if resume else {}),
           "elapsedSeconds": round(clock() - started, 2),
           "requests": {"made": session.made, "search": session.kinds["search"], "detail": session.kinds["detail"],
                        "slug": session.kinds["slug"], "max": max_requests, "intervalSeconds": interval},
           "outcomes": {k: outcomes.get(k, 0) for k in ("confirmed", "ambiguous", "not_found_in_search", "error")},
           "stopped": stop}
    report = summarize(films, cache, run, now)
    report["runs"] = prior_runs + [run]
    atomic_write(out / "report.json", report)
    return report


def resume_command(args, stopped):
    """The exact command that continues after a stop: the same input, folder and limits; --resume when the run that stopped was a --refresh."""
    parts = ["python3 -B scripts/collect-mubi.py", "--input", str(args.input), "--out", str(args.out)]
    if args.max_requests != 100:
        parts += ["--max-requests", "%d" % args.max_requests]
    if args.interval != 2.0:
        parts += ["--interval", "%g" % args.interval]
    if args.refresh or args.resume:
        parts.append("--resume")
    return " ".join(parts)


def print_summary(report, out, command=None):
    run, cache = report["thisRun"], report["cache"]
    s, c, r = cache["status"], cache["amongConfirmed"], run["requests"]
    o, n = run["outcomes"], report["requested"]
    print("MUBI: %d filmes pedidos" % n)
    print("Nesta execucao: confirmados %d | ambiguos %d | not_found_in_search %d | erro/bloqueio %d"
          % (o["confirmed"], o["ambiguous"], o["not_found_in_search"], o["error"]))
    print("  requisicoes: %d de no maximo %d (busca %d, detalhe %d, rota por slug %d) | tempo medido: %.1f s"
          % (r["made"], r["max"], r["search"], r["detail"], r["slug"], run["elapsedSeconds"]))
    print("Acumulado no cache (dos %d pedidos):" % n)
    print("  confirmados %d/%d | ambiguos %d/%d | not_found_in_search %d/%d | erro/bloqueio %d/%d | nao tentados %d/%d"
          % (s["confirmed"], n, s["ambiguous"], n, s["not_found_in_search"], n, s["error"], n, s["not_attempted"], n))
    for label, key in (("Our Take", "ourTake"), ("sinopse", "synopsis"), ("nota", "rating")):
        print("  entre os confirmados, %s disponivel: %d/%d" % (label, c[key]["available"], c[key]["of"]))
    print("  votos unknown: %d/%d | confirmados stale: %d" % (c["votesUnknown"]["count"], c["votesUnknown"]["of"], cache["staleConfirmed"]))
    print("  locales vistos: %s" % (json.dumps(cache["locales"], ensure_ascii=False) if cache["locales"] else "nenhum"))
    if run["stopped"]:
        st = run["stopped"]
        print("  PAROU: %s no filme %s (codigo %d). %s" % (st["reason"], st["film"], st["exitCode"], st["how"]))
        if command:
            print("  Retomar: %s" % command)
        if st.get("retryAfter"):
            print("  Retry-After: %s" % st["retryAfter"])
        if st.get("waitBeforeRetry"):
            print("  Espere antes de repetir: repetir em seguida pode piorar o bloqueio.")
    print("  relatorio: %s (historico de execucoes em runs[])" % (Path(out) / "report.json"))


def load_films(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = data.get("films") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise ValueError("input needs a non-empty films list")
    films, seen = [], set()
    for row in rows:
        ok = isinstance(row, dict) and isinstance(row.get("imdb"), str) and IMDB.fullmatch(row["imdb"]) \
            and isinstance(row.get("title"), str) and row["title"].strip() \
            and isinstance(row.get("year"), int) and not isinstance(row["year"], bool) \
            and isinstance(row.get("directors"), list) and all(isinstance(d, str) for d in row["directors"]) \
            and (row.get("runtime") is None or (isinstance(row["runtime"], int) and not isinstance(row["runtime"], bool)))
        if not ok or row["imdb"] in seen:
            raise ValueError("invalid or repeated film entry: " + str(row.get("imdb") if isinstance(row, dict) else row)[:40])
        seen.add(row["imdb"])
        # Only these fields are kept; anything else in the input is dropped here.
        films.append({"imdb": row["imdb"], "title": row["title"], "year": row["year"],
                      "directors": row["directors"], "runtime": row.get("runtime")})
    return films


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="JSON with films: [{imdb,title,year,directors,runtime}]")
    parser.add_argument("--out", required=True, help="folder for mubi.json and report.json")
    parser.add_argument("--max-requests", type=int, default=100, help="ceiling for search+detail+retries (default 100)")
    parser.add_argument("--interval", type=float, default=2.0, help="minimum seconds between requests (default 2.0)")
    parser.add_argument("--refresh", action="store_true", help="collect again even films already confirmed")
    parser.add_argument("--resume", action="store_true",
                        help="continue a --refresh that stopped, from the film where it stopped (implies --refresh); the stop message prints the command")
    args = parser.parse_args(argv)
    if args.max_requests < 0 or args.interval < 0:
        print("--max-requests and --interval must not be negative", file=sys.stderr)
        return 1
    try:
        films = load_films(args.input)
        report = collect(films, args.out, max_requests=args.max_requests, interval=args.interval, refresh=args.refresh, resume=args.resume)
    except (ValueError, OSError) as error:
        print("erro: " + str(error), file=sys.stderr)
        return 1
    stopped = report["thisRun"]["stopped"]
    print_summary(report, args.out, resume_command(args, stopped) if stopped else None)
    return report["thisRun"]["stopped"]["exitCode"] if report["thisRun"]["stopped"] else 0


if __name__ == "__main__":
    sys.exit(main())
