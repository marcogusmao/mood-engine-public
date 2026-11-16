"""Network-free checks of public research identity and parser boundaries."""
import importlib.util
from pathlib import Path
import unittest
from unittest import mock
import contextlib
import io

spec = importlib.util.spec_from_file_location("research", Path(__file__).resolve().parents[1] / "scripts/research-films.py")
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)
review_spec = importlib.util.spec_from_file_location("review", Path(__file__).resolve().parents[1] / "scripts/review-film-research.py")
review = importlib.util.module_from_spec(review_spec)
review_spec.loader.exec_module(review)
verify_spec = importlib.util.spec_from_file_location("verify", Path(__file__).resolve().parents[1] / "scripts/verify-film-research.py")
verify = importlib.util.module_from_spec(verify_spec)
verify_spec.loader.exec_module(verify)

PAGE = '''<html><head><meta property="og:title" content="A Film (2000)">
<link rel="canonical" href="https://letterboxd.com/film/a-film/"></head>
<body data-tmdb-id="123" data-tmdb-type="movie">
<section class="production-synopsis"><h4>A tagline</h4><div><p>A poet &amp; a friend.</p></div></section>
<div id="tab-panel-genres"><a href="/films/genre/drama/">Drama</a>
<a href="/films/mini-theme/test/by/best-match/">Quiet &amp; reflective</a></div>
<a href="https://www.imdb.com/title/tt1234567/">IMDb</a>
<article class="review"><p>SPOILER: somebody dies.</p><a href="/films/theme/other/">Other</a></article>
</body></html>'''


class ResearchTests(unittest.TestCase):
    def test_exact_identity_and_source_sections(self):
        r = research.parse_letterboxd(PAGE.encode(), "tt1234567")
        self.assertEqual(r["status"], "matched")
        self.assertEqual(r["synopsis"], "A poet & a friend.")
        self.assertEqual([x["text"] for x in r["facets"]], ["Drama", "Quiet & reflective"])
        self.assertNotIn("SPOILER", r["synopsis"])
        self.assertEqual(r["tmdb"]["type"], "movie")

    def test_wrong_film_is_not_researched_as_match(self):
        self.assertEqual(research.parse_letterboxd(PAGE.encode(), "tt7654321")["status"], "identity-not-confirmed")

    def test_identifier_routes_cover_records_without_letterboxd_slug(self):
        class MemoryLedger:
            def __init__(self): self.rows = {}
            def add(self, row): self.rows[row["id"]] = row
        for key, imdb, tmdb, slug, route in [("tt1234567", "tt1234567", 123, None, "imdb/tt1234567/"),
                                            ("tmdb:123", None, 123, None, "tmdb/123/"),
                                            ("tt1234567", "tt1234567", 123, "film:80033", "imdb/tt1234567/")]:
            records = {key: {"id": key, "imdb": imdb, "letterboxd": [{"slug": slug, "tmdb": tmdb}] if slug else [], "tmdb": [{"id": tmdb}]}}
            ledger = MemoryLedger()
            with mock.patch.object(research, "get", return_value=(PAGE.encode(), {})) as get, mock.patch.object(research.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
                research.letterboxd(records, ledger, 0, workers=1)
            self.assertEqual(get.call_args.args[0], "https://letterboxd.com/" + route)
            self.assertEqual(ledger.rows[key]["status"], "matched")
            ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
            ledgers["letterboxd"] = ledger
            self.assertEqual(verify.verify(records, ledgers)["identityErrors"], [])

    def test_missing_identifier_message_must_name_requested_imdb(self):
        page = '<html><h1>No-one has added ‘tt1234567’ yet.</h1></html>'.encode()
        self.assertEqual(research.parse_letterboxd(page, "tt1234567")["status"], "not-added")
        self.assertEqual(research.parse_letterboxd(page, "tt7654321")["status"], "invalid-film-page")

    def test_multiple_imdb_id_is_ambiguous(self):
        page = PAGE.replace("</body>", '<a href="https://imdb.com/title/tt7654321/">Other</a></body>')
        self.assertEqual(research.parse_letterboxd(page.encode(), "tt1234567")["status"], "identity-not-confirmed")

    def test_challenge_page_is_not_success(self):
        self.assertEqual(research.parse_letterboxd(b"<html>Checking your browser</html>", "tt1234567")["status"], "challenge-page")

    def test_legitimate_captcha_library_does_not_hide_film(self):
        page = PAGE.replace('</body>', '<script src="https://example.com/recaptcha/api.js"></script></body>')
        self.assertEqual(research.parse_letterboxd(page.encode(), "tt1234567")["status"], "matched")

    def test_real_dated_imdb_page_can_lack_tmdb_id(self):
        page = PAGE.replace('data-tmdb-id="123"', 'data-tmdb-id=""')
        row = research.parse_letterboxd(page.encode(), "tt1234567")
        self.assertEqual(row["status"], "matched")
        self.assertTrue(verify.film_document(row))

    def test_real_undated_page_needs_exact_tmdb_and_slug(self):
        page = PAGE.replace('A Film (2000)', 'A Film')
        row = research.parse_letterboxd(page.encode(), None, "a-film", 123)
        self.assertEqual(row["status"], "matched")
        self.assertTrue(verify.film_document(row))
        self.assertEqual(research.parse_letterboxd(page.encode(), None, "a-film", 999)["status"], "identity-not-confirmed")

    def test_challenge_with_generic_title_and_temporary_error_are_transient(self):
        for page in ['<meta property="og:title" content="Letterboxd"><div>Checking your browser</div>',
                     '<meta property="og:title" content="A Film (2000)"><div>Temporarily unavailable</div>']:
            self.assertIn(research.parse_letterboxd(page.encode(), "tt1234567")["status"], ("challenge-page", "invalid-film-page"))

    def test_imdb_lookalike_domain_is_not_an_identifier(self):
        page = PAGE.replace("www.imdb.com", "not-imdb.com")
        self.assertEqual(research.parse_letterboxd(page.encode(), "tt1234567")["status"], "identity-not-confirmed")

    def test_no_imdb_requires_the_requested_canonical_and_tmdb(self):
        self.assertEqual(research.parse_letterboxd(PAGE.encode(), None, "another-film", 123)["status"], "identity-not-confirmed")
        self.assertEqual(research.parse_letterboxd(PAGE.encode(), None, "a-film", 999)["status"], "identity-not-confirmed")
        self.assertEqual(research.parse_letterboxd(PAGE.encode(), None, "a-film", 123)["status"], "matched")

    def test_challenge_stops_after_three_and_remains_resumable(self):
        class MemoryLedger:
            def __init__(self): self.rows = {}
            def add(self, row): self.rows[row["id"]] = row
        ledger = MemoryLedger()
        records = {"tt" + str(1234567 + i): {"id": "tt" + str(1234567 + i), "imdb": "tt" + str(1234567 + i),
                   "letterboxd": [{"slug": "a-film", "tmdb": 123}]} for i in range(5)}
        with mock.patch.object(research, "get", return_value=(b"<html>Checking your browser</html>", {})) as get, mock.patch.object(research.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            research.letterboxd(records, ledger, 0, workers=1)
            self.assertEqual(get.call_count, 3)
            self.assertEqual(ledger.rows, {})
        # When the source recovers, the same records are queried, not skipped.
        first = {"tt1234567": records["tt1234567"]}
        with mock.patch.object(research, "get", return_value=(PAGE.encode(), {})) as get, mock.patch.object(research.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            research.letterboxd(first, ledger, 0, workers=1)
            self.assertEqual(get.call_count, 1)
            self.assertEqual(ledger.rows["tt1234567"]["status"], "matched")

    def test_temporary_error_and_generic_title_do_not_complete_collection(self):
        records = {"tt" + str(1234567 + i): {"id": "tt" + str(1234567 + i), "imdb": "tt" + str(1234567 + i),
                   "letterboxd": [{"slug": "a-film", "tmdb": 123}]} for i in range(5)}
        for page in [b"<html><body>Service temporarily unavailable</body></html>",
                     b'<meta property="og:title" content="Just a moment"><body>Checking your browser</body>']:
            ledger = type("Ledger", (), {"rows": {}})()
            ledger.add = lambda row: ledger.rows.update({row["id"]: row})
            with mock.patch.object(research, "get", return_value=(page, {})) as get, mock.patch.object(research.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
                research.letterboxd(records, ledger, 0, workers=1)
            self.assertEqual(get.call_count, 3)
            self.assertEqual(ledger.rows, {})
            ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
            ledgers["imdb"].rows = {key: {"status": "not-in-dataset"} for key in records}
            ledgers["wikidata"].rows = {key: {"status": "not-found"} for key in records}
            ledgers["letterboxd"] = ledger
            result = verify.verify(records, ledgers)
            self.assertFalse(result["automatedCollectionComplete"])
            self.assertEqual(result["pending"]["letterboxd"], 5)

    def test_legacy_identity_rejection_without_document_is_pending(self):
        records = {"tt1234567": {"imdb": "tt1234567", "letterboxd": [{"slug": "a-film"}]}}
        ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
        ledgers["imdb"].rows = {"tt1234567": {"status": "not-in-dataset"}}
        ledgers["wikidata"].rows = {"tt1234567": {"status": "not-found"}}
        ledgers["letterboxd"].rows = {"tt1234567": {"status": "identity-not-confirmed", "foundIMDb": []}}
        result = verify.verify(records, ledgers)
        self.assertFalse(result["automatedCollectionComplete"])
        self.assertEqual(result["pending"]["letterboxd"], 1)

    def test_old_challenge_cannot_satisfy_complete_guard(self):
        records = {"tt1234567": {"imdb": "tt1234567", "letterboxd": [{"slug": "a-film"}]}}
        ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
        ledgers["imdb"].rows = {"tt1234567": {"status": "not-in-dataset"}}
        ledgers["wikidata"].rows = {"tt1234567": {"status": "not-found"}}
        ledgers["letterboxd"].rows = {"tt1234567": {"status": "challenge-page"}}
        result = verify.verify(records, ledgers)
        self.assertFalse(result["automatedCollectionComplete"])
        self.assertEqual(result["pending"]["letterboxd"], 1)

    def test_progress_counts_researched_replacements_not_ledger_growth(self):
        class MemoryLedger:
            def __init__(self): self.rows = {}
            def add(self, row): self.rows[row["id"]] = row
        ledger = MemoryLedger()
        records = {"tt" + str(1234567 + i): {"id": "tt" + str(1234567 + i), "imdb": "tt" + str(1234567 + i),
                   "letterboxd": [{"slug": "a-film", "tmdb": 123}]} for i in range(200)}
        ledger.rows = {key: {"id": key, "status": "identity-not-confirmed"} for key in list(records)[:100]}
        def get(url, limit): return PAGE.encode(), {}
        stream = io.StringIO()
        with mock.patch.object(research, "get", side_effect=get), mock.patch.object(research.time, "sleep"), contextlib.redirect_stdout(stream):
            research.letterboxd(records, ledger, 0, workers=1)
        reports = [research.json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(reports[-1]["processedThisRun"], 200)
        self.assertEqual(reports[-1]["remainingThisRun"], 0)

    def test_series_type_is_preserved(self):
        r = research.parse_letterboxd(PAGE.replace('type="movie"', 'type="tv"').encode(), "tt1234567")
        self.assertEqual(r["tmdb"]["type"], "tv")

    def test_real_page_uses_open_graph_canonical(self):
        page = PAGE.replace('<link rel="canonical" href="https://letterboxd.com/film/a-film/">',
                            '<meta property="og:url" content="https://letterboxd.com/film/a-film/">')
        self.assertEqual(research.parse_letterboxd(page.encode(), "tt1234567")["status"], "matched")

    def test_unknown_identity_does_not_gain_an_invented_imdb(self):
        page = PAGE.replace('<a href="https://www.imdb.com/title/tt1234567/">IMDb</a>', "")
        r = research.parse_letterboxd(page.encode(), None)
        self.assertIsNone(r["imdb"])

    def test_spreadsheet_formulas_with_leading_whitespace_stay_text(self):
        for text in ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1+1", "  =1+1", "\r=1+1"]:
            self.assertEqual(review.csv_safe(text), "'" + text)
        self.assertEqual(review.csv_safe("Tokyo Story"), "Tokyo Story")

    def test_genre_only_does_not_claim_comfort_or_editorial_review(self):
        rec = {"id": "tt1234567", "imdb": "tt1234567", "title": "Black comedy", "year": 2000,
               "tmdb": [{"id": 1, "genres": ["Comedy"], "keywords": [], "overview": "A story."}],
               "letterboxd": [], "identityWarnings": []}
        ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
        d = review.dossier(rec, ledgers)
        self.assertEqual(d["candidateFacets"], [])
        self.assertEqual(d["editorialStatus"], "not-reviewed")
        self.assertFalse(d["applied"])
        self.assertTrue(all(x["status"] == "needs-editorial-review" for x in d["moodReview"]))

    def test_dark_comedy_and_suicide_create_explicit_counterevidence(self):
        rec = {"id": "tt1234567", "imdb": "tt1234567", "title": "A film", "year": 2000,
               "tmdb": [{"id": 1, "genres": ["Comedy"], "keywords": ["black comedy", "suicide"]}],
               "letterboxd": [], "identityWarnings": []}
        ledgers = {name: type("Ledger", (), {"rows": {}})() for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
        d = review.dossier(rec, ledgers)
        lift = next(x for x in d["moodReview"] if x["id"] == "lift")
        self.assertIn("dark-humour", lift["counterEvidence"])
        self.assertIn("disturbing-material", lift["counterEvidence"])
        self.assertEqual(lift["status"], "needs-editorial-review")


if __name__ == "__main__":
    unittest.main()
