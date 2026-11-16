"""Network-free checks of the MUBI collector: identity, field states, stops, resume, atomic writes.

Every answer here is synthetic. The network function is injected; a guard in setUp makes
any attempt at the real network fail the test, and one test proves the guard bites.
"""
import contextlib
import email.message
import functools
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request
import urllib.response

spec = importlib.util.spec_from_file_location("collect_mubi", Path(__file__).resolve().parents[1] / "scripts/collect-mubi.py")
mubi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mubi)

REAL_HTTP_GET = mubi.http_get  # the guard in setUp replaces mubi.http_get; tests that drive the real function use this
NOW = "2026-10-12T12:00:00.000Z"
DELETE = object()


def item(id=1, title="Paterson", original="Paterson", year=2016, directors=("Jim Jarmusch",), duration=119, **over):
    d = {"id": id, "slug": "film-%d" % id, "title": title, "title_locale": "en-US", "original_title": original,
         "year": year, "duration": duration, "web_url": "https://mubi.com/films/film-%d" % id,
         "directors": [{"name": n, "slug": "x"} for n in directors],
         "default_editorial": "Our take text.", "default_editorial_html": "<p>HTML take</p>",
         "short_synopsis": "A short synopsis.", "short_synopsis_html": "<p>HTML synopsis</p>",
         "average_rating": 4.2, "average_rating_out_of_ten": 8.3, "number_of_ratings": 24103,
         "critic_review_rating": 4.9, "star_rating": 3, "press_quote": "A press quote"}
    for k, v in over.items():
        if v is DELETE:
            d.pop(k, None)
        else:
            d[k] = v
    return d


def film(imdb="tt0000001", title="Paterson", year=2016, directors=("Jim Jarmusch",), runtime=118):
    return {"imdb": imdb, "title": title, "year": year, "directors": list(directors), "runtime": runtime}


def ok(items):
    return 200, "application/json; charset=utf-8", json.dumps({"films": items, "zero_results": not items}).encode()


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class Net:
    """Scripted network. `answers`: list of answers (or callables of url) consumed in order; the last repeats."""

    def __init__(self, answers, clock=None, latency=0.3):
        self.answers, self.calls, self.clock, self.latency = list(answers), [], clock, latency

    def __call__(self, url, headers):
        self.calls.append({"url": url, "headers": dict(headers), "at": self.clock() if self.clock else None})
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        a = a(url) if callable(a) else a
        if self.clock:
            self.clock.t += self.latency
        if isinstance(a, BaseException):
            raise a
        return a


class Base(unittest.TestCase):
    def setUp(self):
        # Guard: a collector that reaches for the real network fails here, loudly.
        for target in (mock.patch.object(urllib.request, "urlopen", side_effect=AssertionError("real network")),
                       mock.patch.object(mubi, "http_get", side_effect=AssertionError("real network")),
                       mock.patch.object(time, "sleep", side_effect=AssertionError("real sleep"))):
            target.start()
            self.addCleanup(target.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        self.clock = Clock()

    def run_collect(self, films, net, **kw):
        kw.setdefault("interval", 0.0)
        return mubi.collect(films, self.out, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, **kw)

    def cache(self):
        return json.loads((self.out / "mubi.json").read_text(encoding="utf-8"))["films"]

    def one(self, items, asked=None, **kw):
        """Collect one film into a fresh folder (an earlier confirmed record would be skipped) and return its record."""
        asked = asked or film()
        folder = Path(tempfile.mkdtemp(dir=self.tmp.name))
        kw.setdefault("interval", 0.0)

        def answer(url):  # a detail request is answered with the same object (a key missing in the search stays missing)
            if "/v3/films/" in url and items:
                return 200, "application/json", json.dumps(items[0]).encode()
            return ok(items)

        mubi.collect([asked], folder, fetch=Net([answer]), clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, **kw)
        return json.loads((folder / "mubi.json").read_text(encoding="utf-8"))["films"][asked["imdb"]]


class NetworkGuardTests(Base):
    def test_guard_fails_when_the_collector_reaches_for_the_real_network(self):
        with self.assertRaises(AssertionError):
            mubi.collect([film()], self.out, interval=0.0, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW)
        with self.assertRaises(AssertionError):
            urllib.request.urlopen("https://api.mubi.com/v3/films/1")


class IdentityTests(Base):
    def test_same_title_wrong_director_is_not_confirmed(self):
        r = self.one([item(directors=("Someone Else",))])
        self.assertEqual(r["status"], "not_found_in_search")
        for key in ("ourTake", "synopsis", "rating", "mubi"):
            self.assertNotIn(key, r)

    def test_year_outside_one_is_not_confirmed_and_one_off_is_noted(self):
        self.assertEqual(self.one([item(year=2018)])["status"], "not_found_in_search")
        r = self.one([item(year=2017)])
        self.assertEqual(r["status"], "confirmed")
        self.assertIn("2016", r["identity"]["note"])
        self.assertIn("2017", r["identity"]["note"])

    def test_two_plausible_candidates_are_ambiguous_without_content(self):
        r = self.one([item(id=1), item(id=2, year=2017)])
        self.assertEqual(r["status"], "ambiguous")
        self.assertEqual([c["mubi"]["id"] for c in r["candidates"]], [1, 2])
        for key in ("ourTake", "synopsis", "rating"):
            self.assertNotIn(key, r)
        self.assertNotIn("Our take text.", json.dumps(r))

    def test_first_result_is_not_enough_just_for_being_first(self):
        r = self.one([item(id=1, directors=("Someone Else",)), item(id=2)])
        self.assertEqual((r["status"], r["mubi"]["id"]), ("confirmed", 2))

    def test_title_only_through_original_title_part_confirms_with_evidence(self):
        asked = film(title="Tōkyō Monogatari", year=1953, directors=("Yasujirō Ozu",), runtime=137)
        r = self.one([item(title="Tokyo Story", original="東京物語 | Tōkyō Monogatari", year=1953,
                           directors=("Yasujirô Ozu",), duration=137)], asked)
        self.assertEqual(r["status"], "confirmed")
        self.assertEqual(r["identity"]["evidence"], ["original_title", "year", "director"])

    def test_diacritics_in_director_and_title_are_ignored(self):
        asked = film(title="Tokyo Story", year=1953, directors=("Yasujirō Ozu",))
        r = self.one([item(title="Tokyo Story", original="x", year=1953, directors=("Yasujirô Ozu",))], asked)
        self.assertEqual(r["identity"]["evidence"], ["title", "year", "director"])

    def test_different_title_by_the_same_director_in_the_same_year_is_not_confirmed(self):
        self.assertEqual(self.one([item(title="Another Film", original="Another Film")])["status"], "not_found_in_search")

    def test_accents_on_either_side_of_the_title_are_ignored(self):
        self.assertEqual(mubi.norm("Tōkyō"), mubi.norm("Tokyo"))
        self.assertEqual(mubi.norm("Zoë Ørsted"), "zoe orsted")
        for asked_title, found_title in (("Amélie", "Amelie"), ("Amelie", "Amélie")):
            r = self.one([item(title=found_title, original=found_title)], film(title=asked_title))
            self.assertEqual(r["status"], "confirmed", (asked_title, found_title))

    def test_ampersand_and_punctuation_are_normalised(self):
        self.assertEqual(mubi.norm("Fear & Loathing: in Las-Vegas!"), mubi.norm("fear and loathing in las vegas"))

    def test_duration_over_twenty_minutes_does_not_confirm_but_becomes_candidate(self):
        r = self.one([item(duration=118 + 21)])
        self.assertEqual(r["status"], "ambiguous")
        self.assertEqual(r["candidates"][0]["why"], "duration-differs-more-than-20-min")
        self.assertEqual(self.one([item(duration=118 + 20)])["status"], "confirmed")

    def test_other_cut_does_not_block_the_one_entry_that_passes_everything(self):
        r = self.one([item(id=1, duration=250), item(id=2, duration=119)])
        self.assertEqual((r["status"], r["mubi"]["id"]), ("confirmed", 2))
        self.assertIn("1", r["identity"]["note"])

    def test_missing_director_on_either_side_does_not_confirm(self):
        self.assertEqual(self.one([item(directors=())])["status"], "not_found_in_search")
        self.assertEqual(self.one([item()], film(directors=()))["status"], "not_found_in_search")


class FieldTests(Base):
    def test_empty_editorial_keeps_synopsis_and_rating(self):
        r = self.one([item(default_editorial="")])
        self.assertEqual(r["ourTake"], {"state": "absent"})
        self.assertEqual(r["synopsis"]["text"], "A short synopsis.")
        self.assertEqual(r["rating"]["outOfTen"], 8.3)

    def test_empty_synopsis_does_not_receive_the_editorial(self):
        r = self.one([item(short_synopsis="")])
        self.assertEqual(r["synopsis"], {"kind": "short", "state": "absent"})
        self.assertNotIn("Our take text.", json.dumps(r["synopsis"]))
        self.assertEqual(r["ourTake"]["text"], "Our take text.")

    def test_missing_key_is_unknown_and_null_or_empty_is_absent(self):
        r = self.one([item(default_editorial=DELETE, short_synopsis=None)])
        self.assertEqual(r["ourTake"], {"state": "unknown", "reason": "missing"})
        self.assertEqual(r["synopsis"]["state"], "absent")
        self.assertEqual(self.one([item(default_editorial="  \n ")])["ourTake"]["state"], "absent")

    def test_plain_fields_only_and_nothing_out_of_scope_is_stored(self):
        text = json.dumps(self.one([item()]))
        for banned in ("HTML take", "HTML synopsis", "press_quote", "A press quote", "critic_review_rating", "star_rating", "4.9"):
            self.assertNotIn(banned, text)

    def test_too_long_and_control_characters(self):
        self.assertEqual(self.one([item(default_editorial="x" * 4001)])["ourTake"], {"state": "unknown", "reason": "too-long"})
        self.assertEqual(self.one([item(default_editorial="a\x00b\x07c\nd")])["ourTake"]["text"], "a b c d")

    def test_wrong_type_text_is_unknown_invalid(self):
        self.assertEqual(self.one([item(short_synopsis=5)])["synopsis"]["reason"], "invalid")

    def test_rating_invalid_values_are_unknown(self):
        for over in ({"average_rating_out_of_ten": "8.3"}, {"average_rating_out_of_ten": -1},
                     {"average_rating_out_of_ten": 10.5, "average_rating": 5.2}, {"average_rating": 6},
                     {"average_rating_out_of_ten": True}, {"average_rating_out_of_ten": float("nan")}):
            with self.subTest(over=over):
                r = self.one([item(**over)])["rating"]
                self.assertEqual((r["state"], r["reason"]), ("unknown", "invalid"))
                self.assertEqual(r["votes"], 24103)
                self.assertNotIn("outOfTen", r)

    def test_rating_inconsistent_scales_are_unknown(self):
        for over in ({"average_rating": 2.0}, {"average_rating_out_of_ten": 8.3, "average_rating": 4.5}):
            with self.subTest(over=over):
                r = self.one([item(**over)])["rating"]
                self.assertEqual((r["state"], r["reason"]), ("unknown", "inconsistent"))
        # |average*2 - outOfTen| <= 0.15 is the limit: 0.15 passes, 0.16 does not.
        self.assertEqual(self.one([item(average_rating_out_of_ten=8.3, average_rating=4.225)])["rating"]["state"], "available")
        self.assertEqual(self.one([item(average_rating_out_of_ten=8.3, average_rating=4.23)])["rating"]["reason"], "inconsistent")

    def test_valid_rating_keeps_original_values_without_rounding_or_conversion(self):
        r = self.one([item(average_rating_out_of_ten=8.34, average_rating=4.17)])["rating"]
        self.assertEqual((r["outOfTen"], r["average"]), (8.34, 4.17))
        r = self.one([item(average_rating_out_of_ten=8, average_rating=4)])["rating"]
        self.assertIsInstance(r["outOfTen"], int)
        r = self.one([item(average_rating_out_of_ten=DELETE, average_rating=4.2)])["rating"]
        self.assertEqual((r["state"], r["reason"]), ("unknown", "no-out-of-ten"))
        self.assertNotIn("outOfTen", r)

    def test_votes_that_did_not_come_are_unknown_never_zero(self):
        for over in ({"number_of_ratings": DELETE}, {"number_of_ratings": None}):
            with self.subTest(over=over):
                r = self.one([item(**over)])["rating"]
                self.assertEqual(r["votes"], "unknown")
                self.assertEqual(r["state"], "available")

    def test_votes_that_are_negative_fractional_or_text_make_the_rating_unknown_invalid(self):
        # 12/10/2026 (final review): "unknown" is only for a count that did not come; a count that came wrong is an invalid rating.
        for bad in ("24103", -3, 12.5, True, [1], {"n": 1}, float("inf")):
            with self.subTest(votes=bad):
                r = self.one([item(number_of_ratings=bad)])["rating"]
                self.assertEqual((r["state"], r["reason"]), ("unknown", "invalid"))
                self.assertNotIn("outOfTen", r)

    def test_zero_votes_is_absent_whatever_the_rating_value(self):
        for over in ({"average_rating": None, "average_rating_out_of_ten": None}, {"average_rating": 0, "average_rating_out_of_ten": 0},
                     {"average_rating": 4.2, "average_rating_out_of_ten": 8.3}, {"average_rating_out_of_ten": "abc"},
                     {"average_rating_out_of_ten": DELETE, "average_rating": DELETE}):
            with self.subTest(over=over):
                r = self.one([item(number_of_ratings=0, **over)])["rating"]
                self.assertEqual(r, {"state": "absent", "reason": "no-votes", "votes": 0})

    def test_null_rating_with_votes_is_absent_but_a_missing_key_is_unknown(self):
        r = self.one([item(average_rating=None, average_rating_out_of_ten=None)])["rating"]
        self.assertEqual(r, {"state": "absent", "votes": 24103})
        for over in ({"average_rating_out_of_ten": DELETE, "average_rating": None}, {"average_rating_out_of_ten": None, "average_rating": DELETE},
                     {"average_rating_out_of_ten": DELETE, "average_rating": DELETE}):
            with self.subTest(over=over):
                r = self.one([item(**over)])["rating"]
                self.assertEqual((r["state"], r["reason"], r["votes"]), ("unknown", "missing", 24103))

    def test_locale_is_recorded_as_returned_not_as_requested(self):
        net = Net([ok([item(title_locale="pt-BR")])])
        self.run_collect([film()], net)
        self.assertEqual(net.calls[0]["headers"]["Accept-Language"], "en")
        self.assertEqual(self.cache()["tt0000001"]["locale"], "pt-BR")
        self.assertEqual(self.cache()["tt0000001"]["request"]["acceptLanguage"], "en")
        self.assertEqual(self.one([item(title_locale=DELETE)])["locale"], "unknown")
        self.assertEqual(self.one([item(title_locale="<b>")])["locale"], "unknown")

    def test_detail_is_requested_only_when_a_needed_field_is_missing(self):
        net = Net([ok([item()])])
        self.run_collect([film()], net)
        self.assertEqual(len(net.calls), 1)
        detail = item(id=1)
        net = Net([ok([item(id=1, default_editorial=DELETE)]), (200, "application/json", json.dumps(detail).encode())])
        mubi.collect([film()], self.out / "b", fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
        self.assertEqual(urllib.parse.urlparse(net.calls[1]["url"]).path, "/v3/films/1")
        self.assertEqual(net.calls[1]["url"], "https://api.mubi.com/v3/films/1")
        merged = json.loads((self.out / "b" / "mubi.json").read_text())["films"]["tt0000001"]
        self.assertEqual(merged["ourTake"]["text"], "Our take text.")
        self.assertEqual(merged["request"]["detail"], "ok")

    def test_detail_for_another_film_is_an_error_not_a_silent_unknown(self):
        net = Net([ok([item(id=1, default_editorial=DELETE)]), (200, "application/json", json.dumps(item(id=99)).encode())])
        self.run_collect([film()], net)
        r = self.cache()["tt0000001"]
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "detail-id-mismatch"))
        self.assertNotIn("ourTake", r)

    def test_failed_detail_is_an_error_with_the_real_reason(self):
        net = Net([ok([item(default_editorial=DELETE)]), (500, "application/json", b"{}")])
        self.run_collect([film()], net)
        r = self.cache()["tt0000001"]
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "http-500"))


class NetworkBoundaryTests(Base):
    def test_only_the_title_goes_out_with_fixed_headers(self):
        title = "Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles"
        asked = film(imdb="tt0073198", title=title, year=1976, directors=("Chantal Akerman",), runtime=202)
        net = Net([ok([item(title=title, year=1976, directors=("Chantal Akerman",), duration=202)])])
        self.run_collect([asked], net)
        url = urllib.parse.urlparse(net.calls[0]["url"])
        self.assertEqual((url.scheme, url.netloc, url.path), ("https", "api.mubi.com", "/v3/search/films"))
        self.assertEqual(urllib.parse.parse_qs(url.query, keep_blank_values=True), {"query": [title], "per_page": ["10"]})
        for secret in ("tt0073198", "Akerman"):
            self.assertNotIn(secret, net.calls[0]["url"])
        h = net.calls[0]["headers"]
        self.assertEqual({k: h[k] for k in ("Client", "Client-Country", "Accept-Language", "Accept")},
                         {"Client": "web", "Client-Country": "US", "Accept-Language": "en", "Accept": "application/json"})
        self.assertEqual(set(h), set(mubi.HEADERS))

    def test_network_error_is_an_error_status_never_not_found(self):
        self.run_collect([film()], Net([mubi.NetworkError("network-error")]))
        r = self.cache()["tt0000001"]
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "network-error"))

    def test_html_challenge_with_status_ok_stops_the_run(self):
        for ctype, body in (("application/json", b"<html>Just a moment...</html>"), ("text/html", b"<html></html>"),
                            ("application/json", b'{"films": ['), ("text/plain", b'{"films": []}')):
            with self.subTest(ctype=ctype, body=body[:12]):
                with tempfile.TemporaryDirectory() as d:
                    net = Net([(200, ctype, body)])
                    report = mubi.collect([film("tt0000001"), film("tt0000002")], d, fetch=net, clock=self.clock,
                                          sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                    self.assertEqual(len(net.calls), 1)
                    self.assertEqual(report["thisRun"]["stopped"]["reason"], "challenge")
                    self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000001")
                    self.assertNotEqual(report["thisRun"]["stopped"]["exitCode"], 0)
                    cache = json.loads((Path(d) / "mubi.json").read_text())["films"]
                    self.assertEqual(cache["tt0000001"]["status"], "error")
                    self.assertNotIn("tt0000002", cache)

    def test_403_and_429_stop_the_run(self):
        for code in (403, 429):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as d:
                net = Net([ok([item()]), (code, "text/html", b"<html>no</html>"), ok([item()])])
                report = mubi.collect([film("tt0000001"), film("tt0000002", title="Paterson"), film("tt0000003")], d, fetch=net,
                                      clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                self.assertEqual(len(net.calls), 2)
                self.assertEqual(report["thisRun"]["stopped"]["reason"], "blocked-http-%d" % code)
                self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000002")
                cache = json.loads((Path(d) / "mubi.json").read_text())["films"]
                self.assertEqual(cache["tt0000001"]["status"], "confirmed")
                self.assertEqual(cache["tt0000002"]["error"]["reason"], "blocked-http-%d" % code)
                self.assertEqual(report["cache"]["status"]["error"], 1)
                self.assertEqual(report["cache"]["status"]["not_attempted"], 1)

    def test_three_failures_in_a_row_stop_and_a_success_resets_the_count(self):
        films = [film("tt000000%d" % i) for i in range(1, 6)]
        # Network errors: a 5xx would open the slug route (own tests below), these never do.
        net = Net([mubi.NetworkError("network-error")])
        report = self.run_collect(films, net)
        self.assertEqual(len(net.calls), 3)
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")
        self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000003")
        self.assertEqual(report["cache"]["status"]["error"], 3)
        with tempfile.TemporaryDirectory() as d:
            e = mubi.NetworkError("network-error")
            net = Net([e, e, ok([item()]), e, e, ok([item()])])
            report = mubi.collect(films, d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
            self.assertIsNone(report["thisRun"]["stopped"])
            self.assertEqual(len(net.calls), 5)

    def test_request_ceiling_is_respected_and_counts_the_detail(self):
        films = [film("tt000000%d" % i) for i in range(1, 6)]
        net = Net([ok([item()])])
        report = self.run_collect(films, net, max_requests=3)
        self.assertEqual(len(net.calls), 3)
        self.assertEqual(report["thisRun"]["requests"]["made"], 3)
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "max-requests")
        self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000004")
        self.assertEqual(report["cache"]["status"]["confirmed"], 3)
        self.assertEqual(report["cache"]["status"]["not_attempted"], 2)
        with tempfile.TemporaryDirectory() as d:  # every film needs a detail: search + detail = 2 requests
            net = Net([ok([item(default_editorial=DELETE)]), (200, "application/json", json.dumps(item()).encode())])
            report = mubi.collect(films, d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW,
                                  interval=0.0, max_requests=3)
            self.assertEqual(len(net.calls), 3)
            self.assertEqual((report["thisRun"]["requests"]["search"], report["thisRun"]["requests"]["detail"]), (2, 1))
            self.assertEqual(report["thisRun"]["stopped"]["reason"], "max-requests")

    def test_minimum_interval_between_requests_without_real_sleep(self):
        films = [film("tt000000%d" % i) for i in range(1, 5)]
        net = Net([ok([item()])], clock=self.clock, latency=0.3)
        self.run_collect(films, net, interval=2.0)
        starts = [c["at"] for c in net.calls]
        self.assertEqual(len(starts), 4)
        for a, b in zip(starts, starts[1:]):
            self.assertGreaterEqual(b - a, 2.0)


class SlugFallbackTests(Base):
    """Search answered 5xx: one detail request by slug, same identity rules (coordinator, 12/10/2026)."""
    TITLE = "The Worst Person in the World"
    ASKED = film(imdb="tt10370710", title=TITLE, year=2021, directors=("Joachim Trier",), runtime=128)
    BAD = (500, "text/html", b"<html>boom</html>")

    def worst(self, **over):
        base = dict(id=235851, title=self.TITLE, original="Verdens verste menneske", year=2021,
                    directors=("Joachim Trier",), duration=128)
        base.update(over)
        return item(**base)

    def detail(self, **over):
        body = {k: v for k, v in self.worst(**over).items() if v is not DELETE}
        return 200, "application/json", json.dumps(body).encode()

    def go(self, answers, **kw):
        net = Net(answers, clock=self.clock, latency=0.1)
        report = self.run_collect([self.ASKED], net, **kw)
        return net, report, self.cache().get("tt10370710")

    def test_slug_is_the_normalised_title(self):
        self.assertEqual(mubi.slugify(self.TITLE), "the-worst-person-in-the-world")
        self.assertEqual(mubi.slugify("Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles"),
                         "jeanne-dielman-23-quai-du-commerce-1080-bruxelles")
        self.assertEqual(mubi.slugify("  Amélie & Co.! "), "amelie-and-co")
        self.assertEqual(mubi.slugify("東京物語"), "")

    def test_server_error_then_slug_confirms_with_the_same_identity_rules_and_marks_it(self):
        net, report, r = self.go([self.BAD, self.detail()])
        self.assertEqual(len(net.calls), 2)
        self.assertEqual(net.calls[1]["url"], "https://api.mubi.com/v3/films/the-worst-person-in-the-world")
        self.assertEqual(set(net.calls[1]["headers"]), set(mubi.HEADERS))
        self.assertEqual(r["status"], "confirmed")
        self.assertEqual(r["mubi"]["id"], 235851)
        self.assertEqual(r["identity"]["evidence"], ["title", "year", "director", "slug-fallback"])
        self.assertIn("slug-fallback", r["identity"]["note"])
        self.assertEqual(r["request"]["via"], "slug-fallback")
        self.assertEqual(r["ourTake"]["text"], "Our take text.")
        self.assertEqual((report["thisRun"]["requests"]["search"], report["thisRun"]["requests"]["slug"], report["thisRun"]["requests"]["detail"]), (1, 1, 0))
        self.assertIsNone(report["thisRun"]["stopped"])

    def test_slug_answering_another_film_is_an_error_never_not_found(self):
        for over in ({"directors": ("Someone Else",)}, {"year": 2015}, {"title": "Other Film", "original": "Other Film"}):
            with self.subTest(over=over), tempfile.TemporaryDirectory() as d:
                net = Net([self.BAD, self.detail(**over)])
                mubi.collect([self.ASKED], d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                r = json.loads((Path(d) / "mubi.json").read_text())["films"]["tt10370710"]
                self.assertEqual((r["status"], r["error"]["reason"]), ("error", "slug-fallback-mismatch"))
                for key in ("ourTake", "synopsis", "rating", "mubi", "searched"):
                    self.assertNotIn(key, r)

    def test_slug_mismatch_and_invalid_answers_keep_the_streak_toward_the_three_in_a_row(self):
        net = Net([lambda url: self.BAD if "/search/" in url else self.detail(directors=("Someone Else",))])
        films = [film("tt000000%d" % i, title=self.TITLE) for i in range(1, 6)]
        report = self.run_collect(films, net)
        self.assertEqual(len(net.calls), 6)
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")
        self.assertEqual(report["cache"]["status"]["error"], 3)

    def test_slug_with_duration_over_twenty_minutes_is_ambiguous_with_the_candidate(self):
        r = self.go([self.BAD, self.detail(duration=128 + 21)])[2]
        self.assertEqual(r["status"], "ambiguous")
        self.assertEqual([c["mubi"]["id"] for c in r["candidates"]], [235851])
        self.assertEqual(r["candidates"][0]["why"], "duration-differs-more-than-20-min")
        for key in ("ourTake", "synopsis", "rating"):
            self.assertNotIn(key, r)
        (self.out / "mubi.json").unlink()
        self.assertEqual(self.go([self.BAD, self.detail(duration=128 + 20)])[2]["status"], "confirmed")

    def test_slug_without_a_verifiable_runtime_is_ambiguous_not_confirmed(self):
        for asked, over in ((film(imdb="tt10370710", title=self.TITLE, year=2021, directors=("Joachim Trier",), runtime=None), {}),
                            (self.ASKED, {"duration": None}), (self.ASKED, {"duration": DELETE})):
            with self.subTest(asked_runtime=asked["runtime"], over=over), tempfile.TemporaryDirectory() as d:
                net = Net([self.BAD, self.detail(**over)])
                mubi.collect([asked], d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                r = json.loads((Path(d) / "mubi.json").read_text())["films"]["tt10370710"]
                self.assertEqual(r["status"], "ambiguous")
                self.assertEqual(r["identity"]["note"], "slug-fallback-runtime-unverifiable")
                self.assertEqual([c["mubi"]["id"] for c in r["candidates"]], [235851])
                for key in ("ourTake", "synopsis", "rating"):
                    self.assertNotIn(key, r)

    def test_search_without_runtime_still_confirms_on_the_ordinary_route(self):
        asked = film(title="Paterson", runtime=None)
        self.assertEqual(self.one([item()], asked)["status"], "confirmed")

    def test_search_server_error_with_slug_missing_is_an_error_never_not_found(self):
        net = Net([lambda url: self.BAD if "/search/" in url else (404, "application/json", b"{}")])
        self.run_collect([self.ASKED], net)
        r = self.cache()["tt10370710"]
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "search-5xx-slug-404"))
        self.assertNotIn("searched", r)

    def test_always_server_error_and_slug_missing_stop_after_three_films_with_code_four(self):
        net = Net([lambda url: self.BAD if "/search/" in url else (404, "application/json", b"{}")])
        films = [film("tt000000%d" % i, title=self.TITLE) for i in range(1, 6)]
        report = self.run_collect(films, net)
        self.assertEqual(len(net.calls), 6)
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")
        self.assertEqual(report["thisRun"]["stopped"]["exitCode"], 4)
        self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000003")
        self.assertEqual(report["cache"]["status"]["error"], 3)
        self.assertEqual(report["cache"]["status"]["not_found_in_search"], 0)

    def test_slug_ok_without_a_usable_id_is_an_error_and_counts_as_a_failure(self):
        for body in (b'{"title": "x"}', b'[]', b'{"id": "abc"}', b'{"id": null}', b'{"id": true}'):
            reason = "unexpected-shape" if body == b"[]" else "slug-fallback-invalid-response"
            with self.subTest(body=body), tempfile.TemporaryDirectory() as d:
                net = Net([lambda url, body=body: self.BAD if "/search/" in url else (200, "application/json", body)])
                films = [film("tt000000%d" % i, title=self.TITLE) for i in range(1, 6)]
                report = mubi.collect(films, d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                cache = json.loads((Path(d) / "mubi.json").read_text())["films"]
                self.assertEqual((cache["tt0000001"]["status"], cache["tt0000001"]["error"]["reason"]), ("error", reason))
                self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")
                self.assertEqual(len(net.calls), 6)

    def test_not_found_comes_only_from_an_ok_search_whose_results_were_examined(self):
        r = self.one([item(directors=("Someone Else",)), item(id=2, year=1999)])
        self.assertEqual((r["status"], r["searched"]), ("not_found_in_search", {"results": 2}))
        self.assertEqual(self.one([])["searched"], {"results": 0})

    def test_other_server_error_or_network_error_on_the_slug_leaves_an_error_and_counts_as_one_failure(self):
        for second in (self.BAD, mubi.NetworkError("network-error")):
            with self.subTest(second=second), tempfile.TemporaryDirectory() as d:
                net = Net([lambda url, second=second: self.BAD if "/search/" in url else second])
                films = [film("tt000000%d" % i, title=self.TITLE) for i in range(1, 6)]
                report = mubi.collect(films, d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                # one failure per film: the third film stops the run, after 3 x (search + slug) requests
                self.assertEqual(len(net.calls), 6)
                self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")
                cache = json.loads((Path(d) / "mubi.json").read_text())["films"]
                self.assertEqual(cache["tt0000001"]["status"], "error")
                self.assertEqual(cache["tt0000001"]["error"]["reason"], "http-500" if second is self.BAD else "network-error")

    def test_server_error_on_a_title_without_slug_stays_an_error_without_extra_request(self):
        net = Net([self.BAD])
        self.run_collect([film(title="東京物語")], net)
        self.assertEqual(len(net.calls), 1)
        self.assertEqual(self.cache()["tt0000001"]["error"]["reason"], "http-500")

    def test_blocks_challenge_and_other_client_errors_on_the_search_do_not_open_the_route(self):
        for answer in ((403, "text/html", b"<html>"), (429, "text/html", b"<html>"), (200, "text/html", b"<html>"),
                       (200, "application/json", b"<html>"), (404, "application/json", b"{}"), (400, "application/json", b"{}")):
            with self.subTest(status=answer[0], ctype=answer[1]), tempfile.TemporaryDirectory() as d:
                net = Net([answer, self.detail()])
                mubi.collect([self.ASKED], d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                self.assertEqual(len(net.calls), 1)
                self.assertNotIn("/v3/films/", net.calls[0]["url"])

    def test_search_without_results_does_not_open_the_route(self):
        net = Net([ok([]), self.detail()])
        report = self.run_collect([self.ASKED], net)
        self.assertEqual(len(net.calls), 1)
        self.assertEqual(self.cache()["tt10370710"]["identity"].get("note"), None)
        self.assertEqual(report["thisRun"]["requests"]["slug"], 0)

    def test_ceiling_counts_the_extra_request(self):
        films = [self.ASKED, film("tt0000002", title=self.TITLE)]
        net = Net([self.BAD, self.detail()])
        report = self.run_collect(films, net, max_requests=2)
        self.assertEqual((len(net.calls), report["thisRun"]["requests"]["made"]), (2, 2))
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "max-requests")
        self.assertEqual(report["thisRun"]["stopped"]["resumeFrom"], "tt0000002")
        self.assertEqual(report["cache"]["status"]["confirmed"], 1)
        with tempfile.TemporaryDirectory() as d:  # the ceiling falls between the search and the slug request
            net = Net([self.BAD, self.detail()])
            report = mubi.collect([self.ASKED], d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW,
                                  interval=0.0, max_requests=1)
            self.assertEqual(len(net.calls), 1)
            self.assertEqual(report["thisRun"]["stopped"]["reason"], "max-requests")
            self.assertEqual(report["cache"]["status"]["not_attempted"], 1)

    def test_the_slug_request_respects_the_interval(self):
        net, report, r = self.go([self.BAD, self.detail()], interval=2.0)
        self.assertGreaterEqual(net.calls[1]["at"] - net.calls[0]["at"], 2.0)


class ResumeTests(Base):
    def test_interruption_keeps_finished_films_and_second_run_only_does_the_rest(self):
        films = [film("tt000000%d" % i) for i in range(1, 4)]
        net = Net([ok([item()]), KeyboardInterrupt(), ok([item()])])
        report = self.run_collect(films, net)
        self.assertEqual(report["thisRun"]["stopped"]["reason"], "interrupted")
        self.assertEqual(list(self.cache()), ["tt0000001"])
        net2 = Net([ok([item()])])
        report = self.run_collect(films, net2)
        self.assertEqual(len(net2.calls), 2)
        self.assertIsNone(report["thisRun"]["stopped"])
        self.assertEqual(sorted(self.cache()), ["tt0000001", "tt0000002", "tt0000003"])

    def test_without_refresh_confirmed_are_skipped_but_others_are_retried(self):
        films = [film("tt0000001"), film("tt0000002", directors=("Nobody",))]
        self.run_collect(films, Net([ok([item()])]))
        self.assertEqual(self.cache()["tt0000002"]["status"], "not_found_in_search")
        net = Net([ok([item()])])
        self.run_collect(films, net)
        self.assertEqual(len(net.calls), 1)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(net.calls[0]["url"]).query)["query"], ["Paterson"])

    def test_refresh_with_failure_keeps_the_valid_record_as_stale(self):
        self.run_collect([film()], Net([ok([item()])]))
        before = self.cache()["tt0000001"]
        for answer, reason in ((mubi.NetworkError("network-error"), "network-error"), ((500, "application/json", b"{}"), "http-500"),
                               ((403, "text/html", b"x"), "blocked-http-403"), ((200, "text/html", b"<html>"), "challenge"),
                               (ok([]), "refresh-not_found_in_search"), (ok([item(id=1), item(id=2)]), "refresh-ambiguous")):
            with self.subTest(reason=reason):
                self.run_collect([film()], Net([answer]), refresh=True)
                kept = self.cache()["tt0000001"]
                self.assertTrue(kept["stale"])
                self.assertEqual(kept["lastError"], {"at": NOW, "reason": reason})
                self.assertEqual(kept["status"], "confirmed")
                for key in ("ourTake", "synopsis", "rating", "mubi", "capturedAt"):
                    self.assertEqual(kept[key], before[key])

    def test_refresh_success_replaces_the_record_and_clears_stale(self):
        self.run_collect([film()], Net([ok([item()])]))
        self.run_collect([film()], Net([mubi.NetworkError("x")]), refresh=True)
        self.assertTrue(self.cache()["tt0000001"]["stale"])
        self.run_collect([film()], Net([ok([item(default_editorial="New take.")])]), refresh=True)
        r = self.cache()["tt0000001"]
        self.assertEqual(r["ourTake"]["text"], "New take.")
        self.assertNotIn("stale", r)
        self.assertNotIn("lastError", r)

    def test_unreadable_existing_cache_is_refused_not_overwritten(self):
        (self.out / "mubi.json").write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.run_collect([film()], Net([ok([item()])]))
        self.assertEqual((self.out / "mubi.json").read_text(), "{not json")


class AtomicWriteTests(Base):
    def test_target_is_replaced_from_a_same_directory_temp_file(self):
        target = self.out / "mubi.json"
        target.write_text('{"old": true}', encoding="utf-8")
        seen = []
        real = os.replace

        def spy(src, dst):
            seen.append((Path(src).parent, Path(dst), target.read_text(), json.loads(Path(src).read_text())))
            return real(src, dst)

        with mock.patch.object(mubi.os, "replace", spy):
            mubi.atomic_write(target, {"new": 1})
        self.assertEqual(len(seen), 1)
        parent, dst, old_content, new_content = seen[0]
        self.assertEqual((parent, dst), (target.parent, target))
        self.assertEqual(old_content, '{"old": true}')
        self.assertEqual(new_content, {"new": 1})
        self.assertEqual(json.loads(target.read_text()), {"new": 1})
        self.assertEqual(os.listdir(self.out), ["mubi.json"])

    def test_failure_before_the_swap_leaves_the_valid_file_and_no_temp(self):
        target = self.out / "mubi.json"
        target.write_text('{"old": true}', encoding="utf-8")
        with mock.patch.object(mubi.os, "replace", side_effect=OSError("disk")), self.assertRaises(OSError):
            mubi.atomic_write(target, {"new": 1})
        self.assertEqual(target.read_text(), '{"old": true}')
        self.assertEqual(os.listdir(self.out), ["mubi.json"])
        with mock.patch.object(mubi.os, "fsync", side_effect=OSError("disk")), self.assertRaises(OSError):
            mubi.atomic_write(target, {"new": 1})
        self.assertEqual(target.read_text(), '{"old": true}')
        with self.assertRaises(ValueError):
            mubi.atomic_write(target, {"bad": float("nan")})
        self.assertEqual(target.read_text(), '{"old": true}')

    def test_cache_is_written_after_every_film(self):
        sizes = []

        def answer(url):
            path = self.out / "mubi.json"
            sizes.append(len(json.loads(path.read_text())["films"]) if path.exists() else 0)
            return ok([item()])

        self.run_collect([film("tt000000%d" % i) for i in range(1, 4)], Net([answer]))
        self.assertEqual(sizes, [0, 1, 2])


class ReportAndCliTests(Base):
    def test_report_counts_are_computed_with_explicit_denominators(self):
        films = [film("tt0000001"), film("tt0000002"), film("tt0000003", directors=("Nobody",)), film("tt0000004"), film("tt0000005")]
        no_fields = item(id=6, number_of_ratings=DELETE, title_locale=DELETE)
        answers = [ok([item(id=1)]),
                   ok([item(id=2, default_editorial=None, average_rating=None, average_rating_out_of_ten=None,
                            number_of_ratings=0, title_locale="pt-BR")]),
                   ok([item(id=3)]),
                   ok([item(id=4), item(id=5)]),
                   ok([no_fields]),  # film 5: fields missing, so the detail is requested...
                   (200, "application/json", json.dumps(no_fields).encode())]  # ...and answers without them too
        report = self.run_collect(films, Net(answers))
        self.assertEqual(report["requested"], 5)
        self.assertEqual(report["cache"]["status"], {"confirmed": 3, "ambiguous": 1, "not_found_in_search": 1, "error": 0, "not_attempted": 0})
        self.assertEqual(report["cache"]["amongConfirmed"]["ourTake"], {"available": 2, "of": 3})
        self.assertEqual(report["cache"]["amongConfirmed"]["synopsis"], {"available": 3, "of": 3})
        self.assertEqual(report["cache"]["amongConfirmed"]["rating"], {"available": 2, "of": 3})
        self.assertEqual(report["cache"]["amongConfirmed"]["votesUnknown"], {"count": 1, "of": 3})
        self.assertEqual(report["cache"]["locales"], {"en-US": 1, "pt-BR": 1, "unknown": 1})
        self.assertEqual(report["thisRun"]["requests"]["made"], 6)
        self.assertEqual(report["thisRun"]["requests"]["detail"], 1)
        self.assertEqual(report["thisRun"]["elapsedSeconds"], 0.0)
        self.assertEqual(json.loads((self.out / "report.json").read_text())["cache"]["status"], report["cache"]["status"])
        self.assertEqual(report["thisRun"]["outcomes"], {"confirmed": 3, "ambiguous": 1, "not_found_in_search": 1, "error": 0})

    def run_cli(self, films, answers, *args):
        src = self.out / "in.json"
        src.write_text(json.dumps({"films": films}), encoding="utf-8")
        net = Net(answers)
        with mock.patch.object(mubi, "http_get", net), contextlib.redirect_stdout(io.StringIO()) as buf, \
                contextlib.redirect_stderr(io.StringIO()):
            code = mubi.main(["--input", str(src), "--out", str(self.out / "o"), "--interval", "0", *args])
        return code, net, buf.getvalue()

    def test_exit_codes_and_resume_hint(self):
        films = [film("tt000000%d" % i) for i in range(1, 4)]
        code, net, text = self.run_cli(films, [ok([item()])])
        self.assertEqual(code, 0)
        self.assertIn("confirmados 3/3", text)
        code, net, text = self.run_cli(films, [ok([item()])], "--refresh", "--max-requests", "2")
        self.assertEqual((code, len(net.calls)), (3, 2))
        self.assertIn("tt0000003", text)
        self.assertIn("max-requests", text)
        code, net, text = self.run_cli(films, [(429, "text/html", b"<html>")], "--refresh")
        self.assertEqual((code, len(net.calls)), (2, 1))
        code, net, text = self.run_cli(films, [mubi.NetworkError("network-error")], "--refresh")
        self.assertEqual((code, len(net.calls)), (4, 3))

    def test_bad_input_stops_before_any_request(self):
        src = self.out / "in.json"
        for bad in ({"films": [{"imdb": "tt1", "title": "A"}]}, {"films": []},
                    {"films": [film(), film()]}):
            src.write_text(json.dumps(bad), encoding="utf-8")
            net = Net([ok([item()])])
            with mock.patch.object(mubi, "http_get", net), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(mubi.main(["--input", str(src), "--out", str(self.out / "o")]), 1)
            self.assertEqual(net.calls, [])


# ------------------------------------------------------------------ second review round (12/10/2026)

class FakeResponse:
    def __init__(self, status=200, body=b'{"films": []}', ctype="application/json",
                 url="https://api.mubi.com/v3/search/films?query=x", read_error=None):
        self.status, self._body, self.read_error, self._url = status, body, read_error, url
        self.headers = email.message.Message()
        self.headers["Content-Type"] = ctype

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass

    def geturl(self):
        return self._url

    def read(self, n=-1):
        if self.read_error:
            raise self.read_error
        return self._body if n < 0 else self._body[:n]


class FakeOpener:
    def __init__(self, *steps):
        self.steps, self.calls = list(steps), []

    def open(self, request, timeout=None):
        self.calls.append(request)
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if isinstance(step, BaseException):
            raise step
        return step


def redirect_error(code=302, to="http://outro.example/"):
    headers = email.message.Message()
    headers["Location"] = to
    return urllib.error.HTTPError("https://api.mubi.com/v3/search/films", code, "Found", headers, io.BytesIO(b""))


class NetworkHardeningTests(Base):
    """api.mubi.com only: no proxy from the environment, no redirects, final URL checked (security finding)."""

    def collect_through(self, opener, films=None, **kw):
        fetch = functools.partial(REAL_HTTP_GET, opener=opener)
        return mubi.collect(films or [film()], self.out, fetch=fetch, clock=self.clock, sleep=self.clock.sleep,
                            now=lambda: NOW, interval=0.0, **kw)

    def test_redirect_to_another_host_is_an_error_and_is_not_followed(self):
        opener = FakeOpener(redirect_error(302))
        report = self.collect_through(opener)
        r = self.cache()["tt0000001"]
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "http-302"))
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual([c.full_url for c in opener.calls], [mubi.search_url("Paterson")])
        self.assertIsNone(report["thisRun"]["stopped"])

    def test_redirects_count_as_failures_toward_the_three_in_a_row(self):
        for code in (301, 303, 307, 308):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as d:
                opener = FakeOpener(redirect_error(code))
                films = [film("tt000000%d" % i) for i in range(1, 6)]
                report = mubi.collect(films, d, fetch=functools.partial(REAL_HTTP_GET, opener=opener), clock=self.clock,
                                      sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                self.assertEqual(len(opener.calls), 3)
                self.assertEqual(report["thisRun"]["stopped"]["reason"], "consecutive-failures")

    def test_the_real_opener_refuses_to_follow_a_redirect(self):
        class Hop(urllib.request.BaseHandler):
            handler_order = 400  # before the stock handlers

            def __init__(self):
                self.https, self.http = [], []

            def https_open(self, req):
                self.https.append(req.full_url)
                headers = email.message.Message()
                headers["Location"] = "http://outro.example/"
                response = urllib.response.addinfourl(io.BytesIO(b""), headers, req.full_url, 302)
                response.msg = "Found"
                return response

            def http_open(self, req):
                self.http.append(req.full_url)
                raise AssertionError("the redirect was followed to " + req.full_url)

        hop = Hop()
        self.collect_through(mubi.build_opener([hop]))
        self.assertEqual(self.cache()["tt0000001"]["error"]["reason"], "http-302")
        self.assertEqual((len(hop.https), hop.http), (1, []))

    def test_proxy_settings_of_the_environment_are_ignored(self):
        def env_proxies(opener):  # ProxyHandler({}) registers nothing; one built from the environment shows up with its proxies
            return [h.proxies for h in opener.handlers if isinstance(h, urllib.request.ProxyHandler)]

        with mock.patch.dict(os.environ, {"https_proxy": "http://proxy.example:3128", "HTTPS_PROXY": "http://proxy.example:3128"}):
            self.assertTrue(env_proxies(urllib.request.build_opener()))  # control: the stock opener would use the proxy
            self.assertEqual(env_proxies(mubi.build_opener()), [])

    def test_the_final_url_must_be_https_on_api_mubi_com(self):
        for url in ("http://api.mubi.com/v3/search/films", "https://api.mubi.com.evil.example/v3", "https://evil.example/",
                    "https://api.mubi.com@evil.example/", "ftp://api.mubi.com/x"):
            with self.subTest(url=url), tempfile.TemporaryDirectory() as d:
                opener = FakeOpener(FakeResponse(url=url, body=ok([item()])[2]))
                mubi.collect([film()], d, fetch=functools.partial(REAL_HTTP_GET, opener=opener), clock=self.clock,
                             sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                r = json.loads((Path(d) / "mubi.json").read_text())["films"]["tt0000001"]
                self.assertEqual((r["status"], r["error"]["reason"]), ("error", "unexpected-final-url"))

    def test_a_clean_answer_through_the_opener_is_parsed_and_the_pinned_identity_is_sent(self):
        opener = FakeOpener(FakeResponse(url=mubi.search_url("Paterson"), body=ok([item()])[2]))
        self.collect_through(opener)
        self.assertEqual(self.cache()["tt0000001"]["status"], "confirmed")
        sent = opener.calls[0]
        self.assertEqual(sent.get_header("User-agent"),
                         "MoodEngineMubiCollector/1.0 (personal film catalogue; https://github.com/marcogusmao/mood-engine)")
        self.assertEqual((sent.get_header("Client"), sent.get_header("Client-country"), sent.get_header("Accept-language")),
                         ("web", "US", "en"))

    def test_user_agent_is_pinned(self):
        self.assertEqual(mubi.UA, "MoodEngineMubiCollector/1.0 (personal film catalogue; https://github.com/marcogusmao/mood-engine)")
        self.assertEqual(mubi.HEADERS["User-Agent"], mubi.UA)


class CutConnectionTests(Base):
    def run_with(self, opener=None, fetch=None):
        fetch = fetch or functools.partial(REAL_HTTP_GET, opener=opener)
        return mubi.collect([film()], self.out, fetch=fetch, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)

    def test_incomplete_read_and_http_exceptions_are_network_failures_without_traceback(self):
        cut = http_cut = http.client.IncompleteRead(b"ab", 10)
        err500 = urllib.error.HTTPError("https://api.mubi.com/x", 500, "boom", email.message.Message(),
                                        FakeResponse(read_error=http.client.IncompleteRead(b"a", 5)))
        for step in (FakeResponse(read_error=cut), http.client.RemoteDisconnected("gone"), http.client.BadStatusLine("x"),
                     http.client.ImproperConnectionState("x"), err500, ConnectionResetError("reset"), TimeoutError("slow")):
            with self.subTest(step=type(step).__name__):
                (self.out / "mubi.json").unlink() if (self.out / "mubi.json").exists() else None
                self.run_with(FakeOpener(step))
                r = self.cache()["tt0000001"]
                self.assertEqual((r["status"], r["error"]["reason"]), ("error", "network-error"))

    def test_http_get_itself_turns_every_cut_into_network_error(self):
        err500 = urllib.error.HTTPError("https://api.mubi.com/x", 500, "boom", email.message.Message(),
                                        FakeResponse(read_error=http.client.IncompleteRead(b"a", 5)))
        for step in (FakeResponse(read_error=http.client.IncompleteRead(b"ab", 10)), http.client.RemoteDisconnected("gone"),
                     http.client.BadStatusLine("x"), err500, ConnectionResetError("reset")):
            with self.subTest(step=type(step).__name__), self.assertRaises(mubi.NetworkError):
                REAL_HTTP_GET("https://api.mubi.com/v3/x", dict(mubi.HEADERS), opener=FakeOpener(step))

    def test_an_injected_fetch_raising_http_exception_is_also_a_network_failure(self):
        for exc in (http.client.IncompleteRead(b"", 3), http.client.HTTPException("x")):
            with self.subTest(exc=type(exc).__name__):
                self.run_with(fetch=Net([exc]))
                self.assertEqual(self.cache()["tt0000001"]["error"]["reason"], "network-error")


class BlockOnAnyRequestTests(Base):
    BAD = (500, "text/html", b"<html>boom</html>")
    DETAIL_NEEDED = item(default_editorial=DELETE)

    def routes(self):
        """(name, answers before the blocking one): the blocking answer is appended by the test."""
        return (("search", []), ("slug", [self.BAD]), ("detail", [ok([self.DETAIL_NEEDED])]))

    def test_blocks_and_challenge_stop_on_search_slug_and_detail_requests(self):
        blocks = ((403, "text/html", b"<html>no</html>", "blocked-http-403"), (429, "text/html", b"<html>no</html>", "blocked-http-429"),
                  (200, "text/html", b"<html>Just a moment...</html>", "challenge"),
                  (200, "application/json", b"<html>x</html>", "challenge"), (200, "application/json", b'{"films": [', "challenge"))
        for name, before in self.routes():
            for status, ctype, body, reason in blocks:
                with self.subTest(route=name, reason=reason, body=body[:10]), tempfile.TemporaryDirectory() as d:
                    net = Net(before + [(status, ctype, body)])
                    films = [film("tt0000001"), film("tt0000002")]
                    report = mubi.collect(films, d, fetch=net, clock=self.clock, sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                    self.assertEqual(len(net.calls), len(before) + 1)
                    stop = report["thisRun"]["stopped"]
                    self.assertEqual((stop["reason"], stop["exitCode"], stop["resumeFrom"]), (reason, 2, "tt0000001"))
                    self.assertEqual(report["cache"]["status"]["not_attempted"], 1)
                    cache = json.loads((Path(d) / "mubi.json").read_text())["films"]
                    self.assertEqual(cache["tt0000001"]["error"]["reason"], reason)

    def test_challenge_page_with_any_status_stops_and_never_opens_the_slug_route(self):
        pages = (b"<html><title>Just a moment...</title></html>", b"<html>Checking your browser before accessing</html>",
                 b'<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>', b"<html>Please complete the CAPTCHA</html>")
        for status in (200, 404, 500, 502, 503, 504):
            for page in pages:
                with self.subTest(status=status, page=page[:20]):
                    net = Net([(status, "text/html; charset=utf-8", page)])
                    with tempfile.TemporaryDirectory() as d:
                        report = mubi.collect([film("tt0000001"), film("tt0000002")], d, fetch=net, clock=self.clock,
                                              sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
                    self.assertEqual(len(net.calls), 1)
                    self.assertEqual((report["thisRun"]["stopped"]["reason"], report["thisRun"]["stopped"]["exitCode"]), ("challenge", 2))

    def test_challenge_header_with_a_server_error_stops_too(self):
        net = Net([(503, "text/html", b"<html>x</html>", {"cf-mitigated": "challenge"})])
        report = self.run_collect([film()], net)
        self.assertEqual((len(net.calls), report["thisRun"]["stopped"]["reason"]), (1, "challenge"))

    def test_an_ordinary_html_server_error_is_not_a_challenge_and_still_opens_the_slug_route(self):
        net = Net([(500, "text/html", b"<html><body>Internal Server Error</body></html>"), ok([])])
        net.answers = [(500, "text/html", b"<html><body>Internal Server Error</body></html>"),
                       (200, "application/json", json.dumps(item(id=5, slug="paterson")).encode())]
        report = self.run_collect([film()], net)
        self.assertEqual(len(net.calls), 2)
        self.assertEqual(self.cache()["tt0000001"]["status"], "confirmed")
        self.assertIsNone(report["thisRun"]["stopped"])


class RefreshHalfFailureTests(Base):
    def test_refresh_whose_detail_fails_keeps_the_whole_valid_record_as_stale(self):
        self.run_collect([film()], Net([ok([item()])]))
        before = self.cache()["tt0000001"]
        net = Net([ok([item(default_editorial=DELETE)]), (500, "application/json", b"{}")])
        self.run_collect([film()], net, refresh=True)
        kept = self.cache()["tt0000001"]
        self.assertEqual(len(net.calls), 2)
        self.assertTrue(kept["stale"])
        self.assertEqual(kept["lastError"], {"at": NOW, "reason": "http-500"})
        for key in ("status", "ourTake", "synopsis", "rating", "mubi", "locale", "capturedAt", "identity"):
            self.assertEqual(kept[key], before[key], key)
        self.assertEqual(kept["ourTake"]["text"], "Our take text.")

    def test_refresh_with_a_detail_for_another_film_also_keeps_the_valid_record(self):
        self.run_collect([film()], Net([ok([item()])]))
        net = Net([ok([item(id=1, default_editorial=DELETE)]), (200, "application/json", json.dumps(item(id=99)).encode())])
        self.run_collect([film()], net, refresh=True)
        kept = self.cache()["tt0000001"]
        self.assertEqual((kept["status"], kept["stale"], kept["lastError"]["reason"]), ("confirmed", True, "detail-id-mismatch"))
        self.assertEqual(kept["ourTake"]["state"], "available")

    def test_refresh_where_the_slug_route_is_unusable_keeps_the_valid_record(self):
        self.run_collect([film()], Net([ok([item()])]))
        net = Net([lambda url: (500, "text/html", b"<html>x</html>") if "/search/" in url else (404, "application/json", b"{}")])
        self.run_collect([film()], net, refresh=True)
        kept = self.cache()["tt0000001"]
        self.assertEqual((kept["status"], kept["stale"], kept["lastError"]["reason"]), ("confirmed", True, "search-5xx-slug-404"))


class ReportRunsTests(Base):
    def test_runs_start_with_the_next_run_and_the_summary_separates_this_run_from_the_cache(self):
        (self.out / "report.json").write_text(json.dumps({"schema": 1, "requested": 20, "status": {"confirmed": 19}}))
        films = [film("tt000000%d" % i) for i in range(1, 4)]
        first = self.run_collect(films[:2], Net([ok([item()])]))
        self.assertEqual(len(first["runs"]), 1)
        second = self.run_collect(films, Net([ok([item()])]))
        self.assertEqual(len(second["runs"]), 2)
        runs = json.loads((self.out / "report.json").read_text())["runs"]
        self.assertEqual(runs[0], first["runs"][0])
        self.assertEqual([r["requests"]["made"] for r in runs], [2, 1])
        self.assertEqual(set(runs[1]), {"startedAt", "finishedAt", "refresh", "elapsedSeconds", "requests", "outcomes", "stopped"})
        self.assertEqual(set(runs[1]["requests"]), {"made", "search", "detail", "slug", "max", "intervalSeconds"})
        self.assertEqual((runs[1]["startedAt"], runs[1]["finishedAt"], runs[1]["stopped"]), (NOW, NOW, None))
        self.assertEqual(second["thisRun"]["requests"]["made"], 1)
        self.assertEqual(second["thisRun"]["outcomes"]["confirmed"], 1)
        self.assertEqual(second["cache"]["status"]["confirmed"], 3)

    def test_a_stopped_run_is_recorded_in_the_history(self):
        report = self.run_collect([film("tt000000%d" % i) for i in range(1, 4)], Net([ok([item()])]), max_requests=1)
        self.assertEqual(report["runs"][-1]["stopped"]["reason"], "max-requests")

    def test_unreadable_report_starts_a_new_history_without_failing(self):
        (self.out / "report.json").write_text("{not json")
        report = self.run_collect([film()], Net([ok([item()])]))
        self.assertEqual(len(report["runs"]), 1)

    def test_printed_summary_has_both_blocks(self):
        films = [film("tt000000%d" % i) for i in range(1, 3)]
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            mubi.print_summary(self.run_collect(films, Net([ok([item()])])), self.out)
        text = buf.getvalue()
        self.assertIn("Nesta execucao", text)
        self.assertIn("Acumulado no cache", text)
        self.assertIn("confirmados 2/2", text)


class StopAdviceAndOthersTests(Base):
    def cli(self, films, answers, *args):
        return ReportAndCliTests.run_cli(self, films, answers, *args)

    def test_retry_after_is_reported_and_waiting_is_advised_after_a_block(self):
        for code, headers in ((429, {"Retry-After": "120"}), (403, {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"})):
            with self.subTest(code=code):
                _, text = self.cli([film()], [(code, "text/html", b"<html>no</html>", headers)])[1:]
                stop = json.loads((self.out / "o" / "report.json").read_text())["thisRun"]["stopped"]
                self.assertEqual(stop["retryAfter"], list(headers.values())[0])
                self.assertIn("Retry-After: " + list(headers.values())[0], text)
                self.assertIn("Espere", text)
                shutil_rmtree(self.out / "o")

    def test_without_retry_after_there_is_no_value_but_the_advice_stays(self):
        code, net, text = self.cli([film()], [(403, "text/html", b"<html>no</html>")])
        stop = json.loads((self.out / "o" / "report.json").read_text())["thisRun"]["stopped"]
        self.assertNotIn("retryAfter", stop)
        self.assertNotIn("Retry-After", text)
        self.assertIn("Espere", text)
        self.assertEqual(code, 2)

    def test_ambiguous_record_is_not_replaced_by_an_error_it_keeps_the_candidates_and_last_error(self):
        self.run_collect([film()], Net([ok([item(id=1), item(id=2)])]))
        before = self.cache()["tt0000001"]
        self.run_collect([film()], Net([mubi.NetworkError("network-error")]))
        kept = self.cache()["tt0000001"]
        self.assertEqual(kept["status"], "ambiguous")
        self.assertEqual(kept["candidates"], before["candidates"])
        self.assertEqual(kept["lastError"], {"at": NOW, "reason": "network-error"})
        self.assertNotIn("stale", kept)
        self.run_collect([film()], Net([ok([])]))  # a real new verdict does replace it
        self.assertEqual(self.cache()["tt0000001"]["status"], "not_found_in_search")
        self.assertNotIn("lastError", self.cache()["tt0000001"])

    def test_the_sleep_guard_also_covers_the_default_sleep(self):
        with self.assertRaises(AssertionError):
            mubi.collect([film("tt0000001"), film("tt0000002")], self.out, fetch=Net([ok([item()])]), interval=0.5, now=lambda: NOW)

    def test_captured_at_is_taken_after_the_response(self):
        clk = Clock()
        stamp = lambda: "t=%.1f" % clk.t
        cases = (("search", [ok([item()])]),
                 ("detail", [ok([item(default_editorial=DELETE)]), (200, "application/json", json.dumps(item()).encode())]),
                 ("slug", [(500, "text/html", b"<html>x</html>"), (200, "application/json", json.dumps(item()).encode())]),
                 ("ambiguous", [ok([item(id=1), item(id=2)])]), ("not_found", [ok([])]))
        for name, answers in cases:
            with self.subTest(route=name), tempfile.TemporaryDirectory() as d:
                clk.t = 100.0
                net = Net(answers, clock=clk, latency=0.5)
                mubi.collect([film()], d, fetch=net, clock=clk, sleep=clk.sleep, now=stamp, interval=0.0)
                r = json.loads((Path(d) / "mubi.json").read_text())["films"]["tt0000001"]
                self.assertEqual(r["capturedAt"], "t=%.1f" % (net.calls[-1]["at"] + 0.5))

    def test_the_header_comment_points_to_the_versioned_cache_contract(self):
        self.assertIn("skills/mubi-research/references/cache-contract.md", mubi.__doc__)
        self.assertNotIn(".context/mubi-contrato", mubi.__doc__)


# ------------------------------------------------------------------ final review round (12/10/2026)

def by_title(version):
    """A search answer built from the asked title ("Film 3" -> id 3); the editorial carries the run number in `version`."""
    def answer(url):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["query"][0]
        n = int(query.split()[1])
        return ok([item(id=n, title=query, default_editorial="take v%d" % version[0])])
    return answer


def numbered(n=5):
    return [film("tt000000%d" % i, title="Film %d" % i) for i in range(1, n + 1)]


class ResumeRefreshTests(Base):
    """Final review: an interrupted --refresh is resumed from the film where it stopped, repeating nothing that was refreshed in that execution."""

    def refreshed_until_429(self, version, films=None):
        films = films or numbered()
        self.run_collect(films, Net([by_title(version)]))  # five confirmed, five requests
        version[0] = 2
        net = Net([by_title(version), by_title(version), by_title(version), (429, "text/html", b"<html>wait</html>")])
        return films, self.run_collect(films, net, refresh=True), net

    def takes(self):
        return {k: v["ourTake"]["text"] for k, v in self.cache().items()}

    def test_five_films_blocked_on_the_fourth_request_and_the_resume_asks_only_what_is_missing(self):
        version = [1]
        films, report, net = self.refreshed_until_429(version)
        stop = report["thisRun"]["stopped"]
        self.assertEqual((stop["reason"], stop["resumeFrom"], len(net.calls)), ("blocked-http-429", "tt0000004", 4))
        self.assertEqual(self.takes(), {"tt0000001": "take v2", "tt0000002": "take v2", "tt0000003": "take v2", "tt0000004": "take v1", "tt0000005": "take v1"})
        self.assertTrue(self.cache()["tt0000004"]["stale"])
        version[0] = 3
        net2 = Net([by_title(version)])
        report2 = self.run_collect(films, net2, resume=True)
        asked = [urllib.parse.parse_qs(urllib.parse.urlparse(c["url"]).query)["query"][0] for c in net2.calls]
        self.assertEqual(asked, ["Film 4", "Film 5"], "the three films refreshed in the interrupted run are not asked again")
        self.assertIsNone(report2["thisRun"]["stopped"])
        self.assertTrue(report2["thisRun"]["refresh"])
        self.assertEqual(report2["thisRun"]["resumedFrom"], "tt0000004")
        self.assertEqual(self.takes(), {"tt0000001": "take v2", "tt0000002": "take v2", "tt0000003": "take v2", "tt0000004": "take v3", "tt0000005": "take v3"})
        self.assertFalse(any("stale" in r or "lastError" in r for r in self.cache().values()))
        self.assertEqual(report2["cache"]["status"]["confirmed"], 5)

    def test_a_resume_that_stops_again_resumes_from_where_it_stopped_the_second_time(self):
        version = [1]
        films, _, _ = self.refreshed_until_429(version)
        version[0] = 3
        net = Net([by_title(version), (429, "text/html", b"<html>wait</html>")])
        report = self.run_collect(films, net, resume=True)  # Film 4 passes, Film 5 is blocked
        self.assertEqual((report["thisRun"]["stopped"]["resumeFrom"], len(net.calls)), ("tt0000005", 2))
        net3 = Net([by_title(version)])
        self.run_collect(films, net3, resume=True)
        self.assertEqual(len(net3.calls), 1)
        self.assertEqual(self.takes()["tt0000005"], "take v3")

    def test_a_resume_with_nothing_interrupted_is_refused_before_any_request(self):
        films = numbered(3)
        net = Net([by_title([1])])
        with self.assertRaises(ValueError):  # no report at all
            self.run_collect(films, net, resume=True)
        self.run_collect(films, net)  # a plain run that finished
        with self.assertRaises(ValueError):
            self.run_collect(films, net, resume=True)
        self.run_collect(films, Net([by_title([2])]), refresh=True)  # a refresh that finished
        with self.assertRaises(ValueError):
            self.run_collect(films, net, resume=True)
        self.run_collect(films, Net([(429, "text/html", b"<html>x</html>")]), refresh=True)  # a refresh that stopped
        self.run_collect(films, Net([by_title([3])]), resume=True)  # ...is resumable once
        with self.assertRaises(ValueError):
            self.run_collect(films, net, resume=True)

    def test_a_stopped_plain_run_is_not_a_refresh_to_resume(self):
        films = numbered(3)
        self.run_collect(films, Net([(429, "text/html", b"<html>x</html>")]))
        with self.assertRaises(ValueError):
            self.run_collect(films, Net([by_title([1])]), resume=True)

    def test_the_resume_point_must_be_in_the_input_and_nothing_is_asked_otherwise(self):
        version = [1]
        films, _, _ = self.refreshed_until_429(version)
        net = Net([by_title(version)])
        with self.assertRaises(ValueError):
            self.run_collect([f for f in films if f["imdb"] != "tt0000004"], net, resume=True)
        self.assertEqual(net.calls, [])

    def test_without_refresh_a_stale_record_is_asked_again_and_a_fresh_one_still_is_not(self):
        version = [1]
        films, _, _ = self.refreshed_until_429(version)
        version[0] = 3
        net = Net([by_title(version)])
        self.run_collect(films, net)  # plain run: the stale Film 4 and Film 5 (untouched, fresh) -> only the stale one
        self.assertEqual([urllib.parse.parse_qs(urllib.parse.urlparse(c["url"]).query)["query"][0] for c in net.calls], ["Film 4"])
        self.assertNotIn("stale", self.cache()["tt0000004"])

    def run_cli(self, films, answers, *args):
        return ReportAndCliTests.run_cli(self, films, answers, *args)

    def test_the_stop_message_prints_the_exact_command_that_resumes(self):
        films = numbered()
        code, net, text = self.run_cli(films, [by_title([1])])
        self.assertEqual(code, 0)
        code, net, text = self.run_cli(films, [by_title([2]), by_title([2]), by_title([2]), (429, "text/html", b"<html>x</html>")],
                                       "--refresh", "--max-requests", "50")
        self.assertEqual((code, len(net.calls)), (2, 4))
        src, out = str(self.out / "in.json"), str(self.out / "o")
        self.assertIn("python3 -B scripts/collect-mubi.py --input %s --out %s --max-requests 50 --interval 0 --resume" % (src, out), text)
        self.assertNotIn("--refresh --resume", text)
        code, net, text = self.run_cli(films, [by_title([3])], "--resume")
        self.assertEqual((code, len(net.calls)), (0, 2))
        code, net, text = self.run_cli(films, [by_title([3])], "--resume")  # nothing left to resume
        self.assertEqual((code, len(net.calls)), (1, 0))

    def test_the_stop_message_of_a_plain_run_is_the_same_command_without_resume(self):
        films = numbered(3)
        code, net, text = self.run_cli(films, [(429, "text/html", b"<html>x</html>")])
        self.assertIn("--input %s --out %s --interval 0" % (self.out / "in.json", self.out / "o"), text)
        self.assertNotIn("--resume", text.split("Retomar")[1].split("\n")[0])


class HostAndSizeGuardTests(Base):
    """The two guards of http_get that had no test: the host must be exactly api.mubi.com, and the answer may not pass 4 MB."""

    def error_of(self, opener):
        with tempfile.TemporaryDirectory() as d:
            mubi.collect([film()], d, fetch=functools.partial(REAL_HTTP_GET, opener=opener), clock=self.clock,
                         sleep=self.clock.sleep, now=lambda: NOW, interval=0.0)
            return json.loads((Path(d) / "mubi.json").read_text())["films"]["tt0000001"]

    def test_only_the_exact_host_api_mubi_com_is_accepted(self):
        body = ok([item()])[2]
        for host in ("evil-api.mubi.com.example", "xmubi.com", "mubi.com", "sub.api.mubi.com", "api.mubi.com.", "apimubi.com", "api-mubi.com"):
            with self.subTest(host=host):
                r = self.error_of(FakeOpener(FakeResponse(url="https://%s/v3/search/films" % host, body=body)))
                self.assertEqual((r["status"], r["error"]["reason"]), ("error", "unexpected-final-url"))
        r = self.error_of(FakeOpener(FakeResponse(url=mubi.search_url("Paterson"), body=body)))
        self.assertEqual(r["status"], "confirmed")

    def padded(self, size):
        head = b'{"films": [], "pad": "'
        return head + b"x" * (size - len(head) - 2) + b'"}'

    def test_an_answer_of_exactly_four_megabytes_is_read_and_one_byte_more_is_refused(self):
        exact = self.padded(4_000_000)
        self.assertEqual(len(exact), 4_000_000)
        self.assertEqual(json.loads(exact)["films"], [])
        r = self.error_of(FakeOpener(FakeResponse(url=mubi.search_url("Paterson"), body=exact)))
        self.assertEqual(r["status"], "not_found_in_search", "4,000,000 bytes is inside the ceiling")
        r = self.error_of(FakeOpener(FakeResponse(url=mubi.search_url("Paterson"), body=self.padded(4_000_001))))
        self.assertEqual((r["status"], r["error"]["reason"]), ("error", "response-too-large"))
        r = self.error_of(FakeOpener(FakeResponse(url=mubi.search_url("Paterson"), body=self.padded(9_000_000))))
        self.assertEqual(r["error"]["reason"], "response-too-large")

    def test_the_reader_asks_for_one_byte_beyond_the_ceiling_and_no_more(self):
        asked = []

        class Spy(FakeResponse):
            def read(self, n=-1):
                asked.append(n)
                return super().read(n)

        self.error_of(FakeOpener(Spy(url=mubi.search_url("Paterson"), body=ok([item()])[2])))
        self.assertEqual(asked, [4_000_001], "never an unbounded read")


def shutil_rmtree(path):
    import shutil
    shutil.rmtree(path)


if __name__ == "__main__":
    unittest.main()
