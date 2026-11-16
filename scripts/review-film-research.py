#!/usr/bin/env python3
"""Build a reviewable evidence dossier, never alter production film records.

Candidate facets are literal-rule hypotheses, not human mood judgments. Genre
agreements, discrepancies, unknowns and source identity are retained separately.
"""
import collections
import csv
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector", ROOT / "scripts/research-films.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
OUT = ROOT / "research/2026-10-12-film-research"

# This vocabulary is a review aid. It does not enter config.json or lib/moods.js.
FACETS = {
    "tone": {
        "warm": r"heartwarming|feel[- ]good|uplifting|comforting|gentle humour|gentle humor",
        "melancholic": r"melanchol|bittersweet|nostalgic|loneliness",
        "dark-humour": r"black comedy|dark comedy|dark humo(?:ur|r)|bleak comedy|grim humor|grim humour",
        "absurd": r"absurd|surreal comedy|farcical|slapstick",
        "dreamlike": r"dreamlike|surreal|oneiric|hallucinatory",
        "tense": r"suspense|tense|paranoia|neo[- ]noir|psychological thriller",
        "bleak": r"bleak|harrowing|nihilis|despair|devastating",
        "intimate": r"intimate|tender|empathetic",
    },
    "pace": {
        "contemplative": r"contemplative|meditative|observational|slow cinema|long take|minimalist|minimalism",
        "energetic": r"high[- ]energy|fast[- ]paced|kinetic|propulsive|exhilarat",
    },
    "theme": {
        "identity-and-change": r"reinvention|self[- ]discovery|identity crisis|self[- ]acceptance|starting over|midlife crisis",
        "grief-and-loss": r"grief|bereavement|mourning|death of (?:a loved one|son|daughter|wife|husband)",
        "family": r"family relationships|father (?:daughter|son)|mother (?:daughter|son)|generational|parenthood",
        "friendship": r"friendship|buddy comedy|bromance",
        "romance": r"romance|romantic|falling in love|love affair|relationship",
        "ordinary-work-and-life": r"daily life|everyday life|routine|working class|factory worker|unemployment|workplace|salaryman",
        "war-and-repression": r"genocide|holocaust|war crimes|occupation|dictatorship|political repression",
        "crime": r"heist|robbery|gangster|hitman|film noir|neo[- ]noir|detective|crime boss",
        "food-and-community": r"cooking|food|chef|restaurant|community",
        "music-and-performance": r"concert film|music documentary|musical film|rock music|jazz|samba|bossa nova|musician|singer",
        "supernatural-and-body": r"body horror|folk horror|haunted house|demonic|possession|vampire|zombie",
        "queer-experience": r"lgbt|queer|lesbian|gay|transgender|homosexual",
    },
    "intensity": {
        "disturbing-material": r"torture|rape|sexual violence|genocide|holocaust|suicide|self[- ]harm|gore|harrowing",
    },
}
MOODS = {
    "lift": (["warm", "friendship", "food-and-community"], ["bleak", "dark-humour", "disturbing-material", "grief-and-loss"]),
    "escape": (["absurd", "energetic", "friendship", "crime"], ["bleak", "disturbing-material", "grief-and-loss"]),
    "reinvent": (["identity-and-change", "ordinary-work-and-life"], ["bleak", "disturbing-material"]),
    "letin": (["melancholic", "intimate", "grief-and-loss", "family"], []),
    "night": (["tense", "crime"], []),
    "wicked": (["supernatural-and-body", "tense", "dreamlike"], []),
    # Country, language and director are deliberately not evidence here.
    "wander": (["ordinary-work-and-life", "intimate", "food-and-community"], []),
    "slow": (["contemplative", "dreamlike"], ["energetic"]),
    # A musician in the premise is not enough to establish a music experience.
    "music": (["music-and-performance"], ["bleak", "disturbing-material"]),
}


def sources_for(rec, ledgers):
    key = rec["id"]
    statuses, data = {}, {}
    for name, ledger in ledgers.items():
        row = ledger.rows.get(key)
        statuses[name] = row["status"] if row else ("no-source-identity" if name in ("wikidata", "imdb") and not rec["imdb"] else "pending")
        if row and row["status"] == "matched":
            data[name] = row
    wd = ledgers["wikidata"].rows.get(key)
    if statuses["wikipedia"] == "pending" and wd and wd["status"] != "matched":
        statuses["wikipedia"] = "wikidata-" + wd["status"]
    elif statuses["wikipedia"] == "pending" and not rec["imdb"]:
        statuses["wikipedia"] = "no-source-identity"
    return statuses, data


def csv_safe(value):
    if isinstance(value, str) and value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def dossier(rec, ledgers):
    statuses, data = sources_for(rec, ledgers)
    evidence, genres, facts, taxonomies = [], {}, {}, {}
    if rec["tmdb"]:
        m = rec["tmdb"][0]
        url = "https://www.themoviedb.org/movie/" + str(m["id"])
        evidence.extend(("tmdb", url, x) for x in m.get("keywords") or [])
        genres["tmdb"] = m.get("genres") or []
        cached = m.get("cachedAtMs")
        timestamp = collector.datetime.datetime.fromtimestamp(cached / 1000, collector.datetime.timezone.utc).isoformat() if isinstance(cached, (int, float)) and 0 < cached < 10**13 else None
        facts["tmdb"] = {"year": m.get("year"), "runtime": m.get("runtime"), "url": url,
                         "cachedAt": timestamp, "timestampStatus": "known" if timestamp else "UNKNOWN"}
    if "imdb" in data:
        m = data["imdb"]["facts"]
        genres["imdb"] = m["genres"]
        facts["imdb"] = {"year": m["year"], "runtime": m["runtime"], "type": m["type"],
                         "url": "https://www.imdb.com/title/" + rec["imdb"] + "/",
                         "dataset": data["imdb"]["source"]}
    if "wikidata" in data:
        m = data["wikidata"]["candidates"][0]
        url = "https://www.wikidata.org/wiki/" + m["qid"]
        labels = [x["label"] for x in m["genres"]]
        genres["wikidata"] = labels
        evidence.extend(("wikidata", url, x) for x in labels)
        facts["wikidata"] = {"qid": m["qid"], "articles": m["articles"], "retrievedAt": data["wikidata"]["retrievedAt"]}
    if "wikipedia" in data:
        m = data["wikipedia"]
        # A Portuguese lead is not fed into an English literal vocabulary.
        if m["lang"] == "en":
            evidence.append(("wikipedia-lead", m["source"], m["lead"]))
        facts["wikipedia"] = {k: m[k] for k in ["title", "source", "revision", "lang", "retrievedAt", "sha256"]}
    if "letterboxd" in data:
        m = data["letterboxd"]
        genres["letterboxd"] = [x["text"] for x in m["facets"] if x["kind"] == "genre"]
        taxonomies["letterboxd"] = [{"kind": x["kind"], "id": collector.urllib.parse.urlparse(x["url"]).path.split("/")[3],
                                     "url": x["url"], "filmSource": m["source"]}
                                    for x in m["facets"] if x["kind"] in ("theme", "mini-theme")]
        # These are labels attributed to Letterboxd/Nanocrowd, not our film facts.
        evidence.extend(("letterboxd-theme", m["source"], x["text"]) for x in m["facets"] if x["kind"] != "genre")
        facts["letterboxd"] = {k: m[k] for k in ["source", "retrievedAt", "sha256", "tmdb"]}
    proposed = []
    for dimension, definitions in FACETS.items():
        for tag, expression in definitions.items():
            rule = re.compile(r"(?<![a-z])(?:" + expression + r")(?![a-z])", re.I)
            support = [{"source": name, "url": url} for name, url, text in evidence if rule.search(text)]
            support = list({(x["source"], x["url"]): x for x in support}.values())
            if support:
                proposed.append({"dimension": dimension, "tag": tag, "status": "literal-rule-candidate", "evidence": support})
    found = {x["tag"] for x in proposed}
    moods = [{"id": key, "status": "needs-editorial-review", "support": [x for x in good if x in found],
              "counterEvidence": [x for x in bad if x in found]} for key, (good, bad) in MOODS.items()]
    overview = rec["tmdb"][0].get("overview", "") if rec["tmdb"] else ""
    synopsis = {"currentExists": bool(overview), "rewriteStatus": "not-editorially-rewritten",
                "sourceAlternativeExists": bool(data.get("letterboxd", {}).get("synopsis")),
                "wikipediaIsPremise": False, "requiresSpoilerReview": True}
    if overview:
        synopsis["currentPreview"] = " ".join(overview.split()[:18])
        synopsis["currentSource"] = "https://www.themoviedb.org/movie/" + str(rec["tmdb"][0]["id"])
    alternative = data.get("letterboxd", {}).get("synopsis", "")
    if alternative:
        synopsis["alternativePreview"] = " ".join(alternative.split()[:18])
        synopsis["alternativeSource"] = data["letterboxd"]["source"]
    synopsis["previewsAreExcerptsNotRewrites"] = True
    issues = list(rec["identityWarnings"])
    if "imdb" in data and data["imdb"]["facts"]["type"] not in ("movie", "short", "tvMovie", "video"):
        issues.append("imdb-type-is-not-film:" + data["imdb"]["facts"]["type"])
    if len(facts) and "tmdb" in facts and "imdb" in facts:
        a, b = facts["tmdb"], facts["imdb"]
        if a["runtime"] and b["runtime"] and abs(a["runtime"] - b["runtime"]) > 10:
            issues.append("runtime-disagreement-over-10-minutes")
        if a["year"] and b["year"] and abs(a["year"] - b["year"]) > 1:
            issues.append("imdb-tmdb-year-disagreement")
    for dimension in ("tone", "pace", "theme", "intensity"):
        if not any(x["dimension"] == dimension for x in proposed):
            issues.append("no-explicit-evidence:" + dimension)
    return {"id": rec["id"], "title": rec["title"], "year": rec["year"], "sourceStatus": statuses,
            "sourceFacts": facts, "sourceGenres": genres, "sourceTaxonomies": taxonomies,
            "candidateFacets": proposed, "moodReview": moods,
            "synopsisReview": synopsis, "issues": issues, "editorialStatus": "not-reviewed", "applied": False}


def main():
    records = collector.inventory()
    ledgers = {name: collector.Ledger(name) for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
    OUT.mkdir(parents=True, exist_ok=True)
    editorial_file = OUT / "editorial.json"
    editorial = {x["imdb"]: x for x in collector.read(editorial_file)["records"]} if editorial_file.exists() else {}
    counters, warnings = collections.Counter(), collections.Counter()
    status_coverage = {name: collections.Counter() for name in ledgers}
    fields = ["id", "title", "year", "imdb", "wikidata", "wikipedia", "letterboxd", "tone", "pace", "theme", "intensity", "issues", "editorialStatus"]
    # A streaming gzip preserves the full dossier without another 30 MB plain copy.
    with gzip.open(OUT / "films.jsonl.gz", "wt", encoding="utf-8") as full, (OUT / "review.csv").open("w", encoding="utf-8", newline="") as csv_out:
        writer = csv.DictWriter(csv_out, fieldnames=fields)
        writer.writeheader()
        for rec in records.values():
            d = dossier(rec, ledgers)
            if rec["imdb"] in editorial:
                d["editorialProposal"] = editorial[rec["imdb"]]
                d["editorialStatus"] = "agent-prepared-needs-Marco-review"
                counters["editorialProposalsPrepared"] += 1
            for name, status in d["sourceStatus"].items():
                status_coverage[name][status] += 1
            full.write(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n")
            row = {"id": d["id"], "title": d["title"], "year": d["year"], **d["sourceStatus"], "issues": " | ".join(d["issues"]), "editorialStatus": d["editorialStatus"]}
            for dim in ("tone", "pace", "theme", "intensity"):
                tags = [x["tag"] for x in d["candidateFacets"] if x["dimension"] == dim]
                row[dim] = " | ".join(tags) if tags else "UNKNOWN"
                if tags:
                    counters["withCandidate:" + dim] += 1
            # CSV values beginning with =, +, -, @ cannot become formulas on open.
            writer.writerow({k: csv_safe(v) for k, v in row.items()})
            warnings.update(d["issues"])
            counters["records"] += 1
            counters["withCandidateFacets"] += bool(d["candidateFacets"])
            counters["withoutCurrentSynopsis"] += not d["synopsisReview"]["currentExists"]
    inputs = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT / "cache/tmdb.json", ROOT / "cache/friends.json"]}
    summary = {"generatedAt": collector.now(), "scope": "entire-cache-union", "counts": dict(counters),
               "sourceCoverage": {n: dict(collections.Counter(x["status"] for key, x in l.rows.items() if key in records)) for n, l in ledgers.items()},
               "inventorySourceStatuses": {n: dict(c) for n, c in status_coverage.items()},
               "issues": dict(warnings), "inputHashes": inputs, "editorialReviewed": 0, "applied": False,
               "limitations": ["Literal matches are proposals, not confirmed moods.", "Missing article or source is retained.",
                               "Letterboxd and TMDB share upstream film facts; their agreement is not independent corroboration.",
                               "No wholesale synopsis rewrite is claimed.", "No production changes or publication."]}
    collector.atomic(OUT / "coverage.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
