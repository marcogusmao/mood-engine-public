#!/usr/bin/env python3
"""Verify identities and expose unfinished coverage; never claim full review."""
import argparse
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector", ROOT / "scripts/research-films.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def film_document(row):
    """Recognize source structure, including legacy identity-rejection rows."""
    dated_imdb = bool(re.search(r"\(\d{4}\)\s*$", row.get("title", "")) and
                      any(collector.IMDB.fullmatch(x) for x in ([row["imdb"]] if row.get("imdb") else row.get("foundIMDb", []))))
    tmdb_identity = (str((row.get("tmdb") or {}).get("id", "")).isdigit() and
                     (row.get("tmdb") or {}).get("type") in ("movie", "tv"))
    return bool(re.fullmatch(r"https://letterboxd\.com/film/[a-zA-Z0-9-]+/", row.get("source", ""))
                and row.get("title") and (dated_imdb or tmdb_identity))


def verify(records, ledgers):
    errors, pending = [], {}
    for name, ledger in ledgers.items():
        for key, row in ledger.rows.items():
            if key not in records:
                errors.append(name + ": checkpoint identity outside inventory: " + key)
                continue
            if row["status"] != "matched":
                continue
            rec = records[key]
            if name == "letterboxd":
                if not film_document(row):
                    errors.append(name + ": missing film document structure: " + key)
                parsed = urllib.parse.urlparse(row["source"])
                if parsed.scheme != "https" or parsed.hostname != "letterboxd.com" or not parsed.path.startswith("/film/"):
                    errors.append(name + ": invalid source: " + key)
                if rec["imdb"] and row.get("imdb") != rec["imdb"]:
                    errors.append(name + ": mismatched IMDb: " + key)
                if not rec["imdb"]:
                    known = rec["letterboxd"][0] if rec["letterboxd"] else {"tmdb": rec["tmdb"][0]["id"]}
                    if known.get("slug") and re.fullmatch(r"[a-zA-Z0-9-]+", known["slug"]) and parsed.path != "/film/" + known["slug"] + "/":
                        errors.append(name + ": no-IMDb slug mismatch: " + key)
                    if known.get("tmdb") is not None and (str(row.get("tmdb", {}).get("id")) != str(known["tmdb"]) or row.get("tmdb", {}).get("type") != "movie"):
                        errors.append(name + ": no-IMDb TMDB mismatch: " + key)
            if name == "wikidata":
                if len(row["candidates"]) != 1 or not re.fullmatch(r"Q\d+", row["candidates"][0]["qid"]):
                    errors.append(name + ": invalid unique match: " + key)
            if name == "wikipedia":
                wd = ledgers["wikidata"].rows.get(key)
                if not wd or wd["status"] != "matched" or row["qid"] != wd["candidates"][0]["qid"]:
                    errors.append(name + ": QID does not match identity: " + key)
                url = urllib.parse.urlparse(row["source"])
                if url.hostname not in ("en.wikipedia.org", "pt.wikipedia.org") or urllib.parse.parse_qs(url.query).get("oldid") != [str(row["revision"])]:
                    errors.append(name + ": unpinned source: " + key)
        target = {key for key, rec in records.items() if rec["imdb"]} if name in ("imdb", "wikidata") else set(records) if name == "letterboxd" else {key for key, row in ledgers["wikidata"].rows.items() if key in records and row["status"] == "matched"}
        transient = {key for key, row in ledger.rows.items() if key in target and
                     (row["status"] in ("challenge-page", "invalid-film-page", "invalid-slug") or
                      name == "letterboxd" and row["status"] == "identity-not-confirmed" and not film_document(row))}
        pending[name] = len(target - ledger.rows.keys()) + len(transient)
    unresolved = {name: sum(row["status"] == "identity-not-confirmed" for key, row in ledger.rows.items() if key in records)
                  for name, ledger in ledgers.items()}
    return {"inventory": len(records), "pending": pending, "sourceIdentitiesUnconfirmed": unresolved, "identityErrors": errors,
            "scheduledLookupsAttempted": not any(pending.values()),
            "automatedCollectionComplete": not any(pending.values()) and not errors,
            "wholeCatalogueEditoriallyReviewed": False, "applied": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    records = collector.inventory()
    ledgers = {name: collector.Ledger(name) for name in ["imdb", "wikidata", "wikipedia", "letterboxd"]}
    result = verify(records, ledgers)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if result["identityErrors"] or args.require_complete and not result["automatedCollectionComplete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
