#!/usr/bin/env python3
"""Normalises the curation of 15/11/2026 (three regions, three shapes, fields in Portuguese) into research/2026-11-15-curadoria/<era id>.json, a compact snapshot the converter
(tools/eras/converter.py) reads WITHOUT network and WITHOUT the stremio repository's `.context`. Run once, with the curation folder as the only argument:

  python3 tools/eras/snapshot_curadoria.py <folder with americas/, asia/ and europa/>

A snapshot keeps, per film, only what the cut needs: imdb, tmdb, slug, title, year, director, class (core / periphery / disputed), the ids of the sources that name it, the
independent groups of institutions (New Hollywood), the IMDb votes and rating, whether it is a documentary or a short; and the list of sources with institution, title, url, revision
or date, and the mark "read" (the researcher read it) or "reported" (somebody else's reading). It also keeps what the era file of the previous round (4c8e805-era base, git rev
BASE_REV) said about the directors, so that the converter can run when `data/eras` has already been rewritten.
"""
import json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "research", "2026-11-15-curadoria")
BASE_REV = "d9971d3"  # a commit of this branch whose data/eras/<id>.json carry the directors, countries and candidates of the previous round (the end of the review of 15/11/2026)
FILES = {  # era id (the id of the option) -> region/file of the curation
    "e-new-hollywood": "americas/e-new-hollywood.json", "e-noir": "americas/e-noir.json", "e-precode": "americas/e-precode.json", "e-screwball": "americas/x-screwball.json",
    "e-cinema-novo": "americas/e-cinema-novo.json", "e-china-fifth-gen": "asia/e-china-fifth-gen.json", "e-china-sixth-gen": "asia/e-china-sixth-gen.json", "e-hk-new-wave": "asia/e-hk-new-wave.json",
    "e-iran-new-wave": "asia/e-iran-new-wave.json", "e-japan-new-wave": "asia/e-japan-new-wave.json", "e-korean-new-wave": "asia/e-korean-cinema-1996.json",
    "e-korean-new-wave-1980s": "asia/e-korean-new-wave-1980s.json", "e-parallel-cinema": "asia/e-parallel-cinema.json", "e-taiwan-new-cinema": "asia/e-taiwan-new-cinema.json",
    "e-british-new-wave": "europa/e-british-new-wave.json", "e-commedia-italiana": "europa/e-commedia-italiana.json", "e-czech-new-wave": "europa/e-czech-new-wave.json", "e-giallo": "europa/e-giallo.json",
    "e-moral-anxiety": "europa/e-moral-anxiety.json", "e-neorealism": "europa/e-neorealism.json", "e-new-german": "europa/e-new-german.json", "e-nouvelle-vague": "europa/e-nouvelle-vague.json",
    "e-poetic-realism": "europa/e-poetic-realism.json", "e-polish-school": "europa/e-polish-school.json", "e-german-expressionism": "europa/e-weimar.json",
}
CLS = {"núcleo": "core", "nucleo": "core", "core": "core", "periferia": "periphery", "periphery": "periphery", "disputado": "disputed", "disputed": "disputed"}
first = lambda d, ks, default=None: next((d[k] for k in ks if isinstance(d, dict) and d.get(k) not in (None, "")), default)
sid = lambda s: re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def mark_of(text):
    t = (text or "").lower()
    return "reported" if (t.startswith("relatado") or t.startswith("pesquisa") or t.startswith("leitura anterior")) else "read"


def rev_of(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str) and re.fullmatch(r"\d+", v.strip()):
        return int(v)
    return v if v not in ("", None) else None


def norm_sources(raw, prefix=None):
    out = []
    for s in raw:
        i = sid(s["id"].split(":", 1)[-1] if prefix else s["id"])
        mk = first(s, ["mark", "lido_por", "como"], "")
        out.append({"id": i, "institution": first(s, ["publication", "publicacao"], ""), "title": first(s, ["title", "titulo"], ""), "url": first(s, ["url"], ""),
                    "revision": rev_of(first(s, ["revision", "revisao"])), "date": first(s, ["revisionDate", "data", "readOn", "lido_em"], ""), "mark": mark_of(mk), "readNote": str(mk)[:160]})
    return out


def src_ids(v):
    out = []
    for x in v or []:
        i = x["id"] if isinstance(x, dict) else x
        out.append(sid(str(i).split(":", 1)[-1]))
    return out


def norm_film(f):
    title = first(f, ["title", "titulo"], "")
    year = first(f, ["year", "ano"])
    full = {"imdb": f.get("imdb") or None, "tmdb": f.get("tmdb") if isinstance(f.get("tmdb"), int) else None, "slug": f.get("slug") or None, "title": title, "year": year,
            "director": first(f, ["director", "diretor"], ""), "cls": CLS.get(first(f, ["classe", "class"], ""), None), "src": src_ids(f.get("fontes")),
            "groups": f.get("grupos_independentes") or [], "votes": first(f, ["imdbVotos", "imdb_votos"]), "rating": first(f, ["imdbNota", "imdb_nota"]),
            "doc": bool(f.get("ficcao_ou_nao_documentario") and "doc" in str(f.get("ficcao_ou_nao_documentario")).lower()), "short": bool(f.get("curta_metragem")),
            "countries": f.get("paises") or [], "disputed_note": (lambda v: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))(first(f, ["disputa"], "") or "")[:300]}
    out = {k: v for k, v in full.items() if v not in (None, "", [], False)}  # a compact snapshot: an absent key is "none"
    if full["cls"] != "disputed":
        out.pop("disputed_note", None)
    out.pop("countries", None)
    return out


def with_cache(f, facts):
    y, doc = facts.get(f.get("imdb"), (None, False))
    if y is not None and y != f.get("year"):
        f["tmdbYear"] = y  # the year of the TMDB record when it is not the year of the list
    if doc:
        f["doc"] = True  # the TMDB genre Documentary (the curation of the Americas had a field that did not exist; the genre does)
    return f


def exclusion(x):
    src = first(x, ["source", "fonte"], "")
    return {"imdb": x.get("imdb"), "title": first(x, ["title", "titulo"], ""), "year": first(x, ["year", "ano"]), "director": first(x, ["director", "diretor"], ""), "why": first(x, ["why", "motivo"], ""),
            "source": src if isinstance(src, str) else json.dumps(src, ensure_ascii=False)[:300], "nameSources": src_ids(first(x, ["fontesQueNomeiam", "fontes"], [])), "votes": first(x, ["imdbVotos", "imdb_votos"]), "rating": first(x, ["imdbNota", "imdb_nota"])}


def cache_facts():
    """imdb -> (TMDB year, is a documentary) from cache/tmdb.json of this repository (no network): the genre Documentary of the TMDB record decides `doc`; the year checks the id the curation gave."""
    out = {}
    for e in json.load(open(os.path.join(ROOT, "cache", "tmdb.json")))["movie"].values():
        v = (e or {}).get("v")
        if v and v.get("imdb"):
            out[v["imdb"]] = (v.get("year"), "Documentary" in (v.get("genres") or []))
    return out


def main(cur):
    facts = cache_facts()
    os.makedirs(OUT, exist_ok=True)
    for era, rel in FILES.items():
        d = json.load(open(os.path.join(cur, rel), encoding="utf8"))
        raw_src = first(d, ["sources", "fontes"], [])
        prefix = isinstance(raw_src[0]["id"], str) and ":" in raw_src[0]["id"]
        snap = {"era": era, "curationFile": rel, "sources": norm_sources(raw_src, prefix), "films": [with_cache(norm_film(f), facts) for f in first(d, ["films", "filmes"], [])] + [with_cache(dict(norm_film(f), outsideCuration=True), facts) for f in d.get("fora_dos_anos_ou_do_pais", [])],
                "exclusionsOfCuration": [exclusion(x) for x in first(d, ["exclusoes", "exclude"], [])],
                "directorsOfCuration": [{"name": first(x, ["name", "nome"], ""), "cls": CLS.get(first(x, ["classe", "class"], ""), None), "tmdb": x.get("tmdb"), "position": first(x, ["posicao", "pais"], "")} for x in d.get("diretores", [])],
                "noId": [{"title": first(x, ["titulo_na_fonte", "title", "titulo"], ""), "year": first(x, ["ano", "year"]), "why": first(x, ["motivo", "why"], "")} for x in d.get("candidatos_sem_id", [])]}
        # what the previous round's era file said about the directors, countries and candidates (git, offline)
        r = subprocess.run(["git", "-C", ROOT, "show", f"{BASE_REV}:data/eras/{era}.json"], capture_output=True, text=True)
        if r.returncode == 0:
            b = json.loads(r.stdout)
            if b.get("school"):
                snap["base"] = {"directors": b["school"]["directors"], "countries": b["school"]["countries"], "years": b["years"]}
                for k in ("candidates", "candidatesFrom", "notAdded"):
                    if k in b["school"]:
                        snap["base"][k] = b["school"][k]
        json.dump(snap, open(os.path.join(OUT, era + ".json"), "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
    print("snapshots:", len(FILES), "in", OUT)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
