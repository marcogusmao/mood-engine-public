#!/usr/bin/env python3
"""Writes research/2026-11-15-eras-resultado.md: era by era, the main (before) against the branch (after), for Marco to see before anything is published.

  python3 tools/eras/resultado.py <before.json> <after.json> <labels-of-the-main.json> <index-v2.json> [<after-without-the-short-rule.json> <old-tree-today's-cache.json> <before-of-the-previous-main.json>]

before.json / after.json: the output of `node tools/eras/medir.js` run on the main and on the branch over the SAME public index of 14/11/2026; the third file: the Discover file of the main
(`git show origin/main:data/discover-catalogs.json`). The candidates (films the index does not have) come from the converter itself (research/2026-11-15-curadoria/), so nothing here needs the network.
"""
import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import converter

ROOT = converter.ROOT
PARENT = {"e-china-fifth-gen": "e-china-new-waves", "e-china-sixth-gen": "e-china-new-waves", "e-polish-school": "e-polish-cinema", "e-moral-anxiety": "e-polish-cinema"}
WHO = {"marco": "Marco", "session": "the session (authorized by Marco)", "session-differs": "the session, differing from the research"}


def film(f):
    director = (f.get("dirs") or "").split(",")[0].strip()
    return f"{f['name']} ({f['year']}{', ' + director if director else ''}{', ' + format(f['lb'], '.2f') if f.get('lb') is not None else ''}{', seen' if f.get('seen') else ''})"


def top(fs, n=15):
    return sorted(fs, key=lambda f: (-(f["lb"] if f.get("lb") is not None else -1), f["name"]))[:n]


def para_ver(D, files, index_f, extra=None):
    """The section "For you to see": the cases where the session chose alone or where a number differs from what was said, one line each, with titles."""
    idx = json.load(open(index_f))
    col = {c: i for i, c in enumerate(idx["cols"])}
    R = {r[col["tt"]]: r for r in idx["films"]}
    year = lambda tt: int(R[tt][col["year"]]) if tt in R and R[tt][col["year"]] not in ("", None) else None
    L = ["", "## For you to see (what is still a choice of the session, or where a number is not what was said)", "",
         "Each line is a case the table above does not make obvious. Measured over the same index of 14/11/2026; the genre `Short` or a runtime of 40 minutes or less in the index is what \"short\" means here.", ""]
    L.append("- **Variety Lights (Fellini and Lattuada, 1950) is in the Neorealism** by Lattuada's door (a listed director's film made in Italy), not by a source; its other door is Fellini, who is not listed.")
    hk, hkdata = D["e-hk-new-wave"], files["e-hk-new-wave"][0]
    inf = {f["imdb"] for f in hkdata["films"]}
    door = [f for f in hk["films"] if f["tt"] not in inf]
    L.append(f"- **Hong Kong has {hk['all']} films, not \"about 32\":** {hk['all'] - len(door)} named by a source (A Better Tomorrow, 1986, is marked core by the curation) and {len(door)} by the director door: " + ", ".join(f"{f['name']} ({f['year']})" for f in door) + ".")
    # shorts (Marco, 15/11/2026, "Only where you or a source put them"): the director's door takes no film under shortRow.minMinutes (P.isShort); the list door keeps the short a source names
    short_stay = []
    for k, v in D.items():
        if k not in files:
            continue
        for f in v["films"]:
            rt = R[f["tt"]][col["runtime"]]
            if rt not in ("", None) and 0 < int(rt) < 40:
                short_stay.append(f"{f['name']} ({f['year']}, {rt} min, {k[2:]})")
    left = []
    if extra and extra.get("noshort"):
        S = extra["noshort"]
        for k, v in D.items():
            if k in S and k in files:
                have = {f["tt"] for f in v["films"]}
                left += [f"{f['name']} ({f['year']}, {R[f['tt']][col['runtime']]} min, {k[2:]})" for f in S[k]["films"] if f["tt"] not in have]
    L.append(f"- **Shorts inside the eras: {len(left)} left and {len(short_stay)} stay.** The director's door takes no film under 40 minutes (`shortRow.minMinutes`, the same function `isShort` of the Discover cuts; a film with no known runtime stays); the door of the list keeps the short that a source names. Left ({len(left)}): " + "; ".join(left) + f". Stay, because a source names them ({len(short_stay)}): " + "; ".join(short_stay) + ".")
    # (a) "disputed stays out" is the rule of the LIST door; by the director's door a disputed film is in the menu
    A = (extra or {}).get("A") or {}
    dec = json.load(open(converter.DEC))
    parent = dict(PARENT, **{"e-iran-art-cinema": "e-iran-new-wave"})
    got = []
    for k, v in D.items():
        if k not in files:
            continue
        snap = json.load(open(os.path.join(converter.SNAP, dec["eras"][k]["curation"] + ".json")))
        cls = {f["imdb"]: f for f in snap["films"] if f.get("imdb")}
        listed = {f["imdb"] for f in files[k][0]["films"]}
        was = {f["tt"] for f in (A.get(k) or A.get(parent.get(k, "")) or {}).get("films", [])}
        got += [(k, f["name"], f["year"], f["tt"] in was) for f in v["films"] if f["tt"] not in listed and cls.get(f["tt"], {}).get("cls") == "disputed"]
    L.append(f"- **\"Disputed stays out\" is the rule of the LIST door; by the director's door {len(got)} disputed films are in the menu, {sum(1 for g in got if g[3])} of them already in the published main:** " + "; ".join(f"{n} ({y}, {k[2:]})" for k, n, y, _ in got) + ". A director of the list brings his films whatever the sources say of one of them; to take one out is a written exclusion.")
    # (b) On the Bowery
    L.append("- **On the Bowery (1956) is an American documentary by Lionel Rogosin**, and it is in the British New Wave because the option Marco chose (\"Let the British ones in\") named it among the four; it is not British cinema and the only source that names it is the Wikipedia article on Free Cinema (the films it names in the programmes of 1956–59). Taking it out is one line (`include` in `tools/eras/decisoes.json`).")
    # (c) shorts of the period eras
    ps = collections.Counter()
    for k, v in D.items():
        if k in files:
            continue
        for f in v["films"]:
            rt = R[f["tt"]][col["runtime"]]
            if rt not in ("", None) and 0 < int(rt) < 40:
                ps[v["label"]] += 1
    L.append(f"- **The eras of PERIOD (not of this branch: they keep their `where`) still hold {sum(ps.values())} shorts with no source:** " + ", ".join(f"{l} {n}" for l, n in ps.most_common()) + ". Out of the scope of the conversion; it is in the `BACKLOG.md` with Marco's sentence (\"Only where you or a source put them\").")
    kand = next((f for f in D["e-iran-art-cinema"]["films"] if f["name"] == "Kandahar"), None)
    L.append("- **Kandahar (2001, Mohsen Makhmalbaf) is in the Iranian art cinema 1980–**, by Makhmalbaf's door: the country rule of the PR #105 reads its TMDB origin (Iran, one of the producers, a film spoken in English by the TMDB record) as the main country, so it is Iranian. A Separation (2011, Farhadi) enters by Farhadi's door (the era has no last year)." if kand else "- **Kandahar is not in the Iranian art cinema 1980–.**")
    old_ir = {f["tt"] for f in (extra or {}).get("before_iran", [])}
    if old_ir:
        gone = old_ir - {f["tt"] for f in D["e-iran-new-wave"]["films"]}
        moved = gone & {f["tt"] for f in D["e-iran-art-cinema"]["films"]}
        L.append(f"- **The {len(gone)} films that leave the old Iranian era are not lost:** {len(moved)} of the {len(gone)} that leave it are in the Iranian art cinema 1980– (the films after 1979); the rest are films of the published main that no source names.")
    L.append(f"- **The Iranian New Wave 1962–79 has {D['e-iran-new-wave']['all']} films ({D['e-iran-new-wave']['shown']} not seen), under 20:** most of what the sources name before 1980 has no Letterboxd page known yet (it is in `pending`, with the reason); Kimiai, Farmanara, Shirdel and Sayyad are named by the curation but have no TMDB person id in the files, so their films come only by the list. The Iranian art cinema 1980– has {D['e-iran-art-cinema']['all']} ({D['e-iran-art-cinema']['shown']} not seen).")
    L.append("- **The Promise (2005) and Crouching Tiger, Hidden Dragon (2000, Ang Lee, main country Taiwan) have no written exclusion and effect 0 in the Fifth Generation:** the first is not in the index, the second is not by a listed director of the Fifth Generation; there is nothing to decide on them.")
    return L


def rebase_section(A, D, extra):
    """What changed because the main moved (PR #105: the countries and the cuts) and not because of the eras: the 'before' lines that differ from the previous main, and the films that enter or leave an era only by the new country rule."""
    if not extra.get("old_before") and not extra.get("old_tree"):
        return []
    L = ["", "## What changed because the main moved (PR #105), not because of the eras", ""]
    O = extra.get("old_before") or {}
    rows = []
    for k in sorted(set(A) & set(O)):
        if (A[k]["all"], A[k]["shown"]) != (O[k]["all"], O[k]["shown"]):
            was, now = {f["tt"] for f in O[k]["films"]}, {f["tt"] for f in A[k]["films"]}
            rows.append(f"- **{A[k]['label']}** ({k}): before the rebase {O[k]['all']} / {O[k]['shown']}, now {A[k]['all']} / {A[k]['shown']}; enter: " + (", ".join(f["name"] for f in A[k]["films"] if f["tt"] not in was) or "none") + "; leave: " + (", ".join(f["name"] for f in O[k]["films"] if f["tt"] not in now) or "none"))
    L.append(f"**The \"before\" column** (the published main, now `787d0d1`, was `0f092ff`): {len(rows)} lines moved." if rows else "**The \"before\" column:** no line moved.")
    L += rows
    V = extra.get("old_tree")
    S = extra.get("noshort")
    if V is not None and S is not None:
        eff = []
        for k in sorted(S):
            a = {f["tt"]: f for f in V.get(k, {}).get("films", [])}
            b = {f["tt"]: f for f in S[k]["films"]}
            i = [f"{f['name']} ({f['year']})" for t, f in b.items() if t not in a]
            o = [f"{f['name']} ({f['year']})" for t, f in a.items() if t not in b]
            if i or o:
                eff.append(f"- **{S[k]['label']}** ({k}): {len(a)} → {len(b)}; enter: {', '.join(i) or 'none'}; leave: {', '.join(o) or 'none'}")
        L += ["", "**The rule of the country (PR #105: in a film spoken in English the single TMDB origin wins when it is one of the producers) and the cuts, alone** (the same era files and the same index, the code before the rebase against the code after it, with today's `cache/` in both and the short rule off): " + (f"{len(eff)} eras change." if eff else "no era changes.")] + eff
    return L


def main(before_f, after_f, main_cat_f, index_f, noshort_f=None, old_tree_f=None, old_before_f=None):
    extra = {}
    if noshort_f:
        extra["noshort"] = json.load(open(noshort_f))["eras"]
    if old_tree_f:
        extra["old_tree"] = json.load(open(old_tree_f))["eras"]
    if old_before_f:
        extra["old_before"] = json.load(open(old_before_f))["eras"]
    extra["A"] = json.load(open(before_f))["eras"]
    extra["before_iran"] = json.load(open(before_f))["eras"].get("e-iran-new-wave", {}).get("films", [])
    A = json.load(open(before_f))["eras"]
    D = json.load(open(after_f))["eras"]
    main_cat = json.load(open(main_cat_f))
    now_cat = json.load(open(os.path.join(ROOT, "data", "discover-catalogs.json")))
    files, dec = converter.make_all(detail=True)
    old_labels = {o.get("id"): o["label"] for c in main_cat["catalogs"] for o in c["options"] if "label" in o and "directors" not in o}
    L = ["# Eras of the Discover: before and after (15/11/2026)", "",
         "For Marco to see before anything is published. **Before** = the published main (`787d0d1`, which carries the PR #105; the first version of this table used `0f092ff`); **after** = this branch. Both measured by `tools/eras/medir.js` over the same public index of 14/11/2026 09:49 UTC (11,594 films), "
         "with the films that qualify for the recommendation rule (3.5 on Letterboxd for everything, no era has a floor of its own). *Films* = all / not seen by you. **Bold** = an era with fewer than 20 not seen, or a new era. "
         "The films that the catalogue does not have yet are *candidates*: they are not in these numbers, they come in only after the next step (the night reads them). Nothing here was run through the real nightly build.", ""]
    rows, body = [], []
    for era, d in dec["eras"].items():
        a = A.get(era) or A.get(PARENT.get(era, ""))
        z = D[era]
        both = {f["tt"]: f for f in z["films"]}
        before = {f["tt"]: f for f in (a["films"] if a else [])}
        out = [f for t, f in before.items() if t not in both]
        inn = [f for t, f in both.items() if t not in before]
        new = bool(d.get("newEra"))
        low = z["shown"] < 20
        was = old_labels.get(era) or old_labels.get(PARENT.get(era, ""))  # the label of the published main (for a split era, the label of the era it came from)
        label = f"{was + ' → ' if was and was != d['label'] else ''}{d['label']}"
        mark = (lambda s: f"**{s}**" if (new or low) else s)
        a_txt = f"{a['all']} / {a['shown']}" if a and not new else "—"
        rows.append((len(out) + len(inn), f"| {mark(label)} | {WHO[d['who']]} | {a_txt} | {mark(str(z['all']) + ' / ' + str(z['shown']))} | {len(out)} | {len(inn)} |"))
        data = files[era][0]
        cands = [c for c in files[era][1]]
        floor = sorted([c for c in cands if (c['votes'] or 0) >= 100 and (c['rating'] or 0) >= 7.0], key=lambda c: (-c['rating'], c['title']))
        body.append(f"\n## {mark(label)}\n")
        body.append(f"- **Who decided:** {WHO[d['who']]}. {d['note']}")
        body.append(f"- **Years:** {d['years']['min']}–{d['years'].get('max', 'on')}. **Films now:** {z['all']} / {z['shown']} not seen" + (f" (before: {a['all']} / {a['shown']})" if a and not new else " (a new era)") + (". **Fewer than 20 not seen.**" if low else "."))
        body.append(f"- **Leave ({len(out)}; the {min(15, len(out))} best rated):** " + ("; ".join(film(f) for f in top(out)) if out else "none"))
        body.append(f"- **Enter ({len(inn)}; the {min(15, len(inn))} best rated):** " + ("; ".join(film(f) for f in top(inn)) if inn else "none"))
        c = data["counted"]
        body.append(f"- **Films the catalogue does not have that the sources name:** {c['notInIndexAdmitted']}; **{c['notInIndexPassingImdb7']}** have 100 votes and 7.0 on IMDb, the floor that predicts a pass on Letterboxd (about 65 of 100, measured on a sample)." + (" The ten best rated: " + "; ".join(f"{x['title']} ({x['year']}, IMDb {x['rating']})" for x in floor[:10]) + "." if floor else ""))
        if data.get("pending"):
            body.append(f"- **Written down, no id yet:** {len(data['pending'])} films (no IMDb id, or an id but no Letterboxd page known): they are in the file under `pending` with the reason.")
    rows.sort(key=lambda r: -r[0])
    L += ["## The eras that move most", "", "| Era | Who decided | Films before (all / not seen) | Films after | Leave | Enter |", "|---|---|---|---|---|---|"] + [r[1] for r in rows] + ["", "The eras that do not move (no decision on the sheet): " + ", ".join(sorted(o["label"] for c in now_cat["catalogs"] if c["id"] == "eras" for o in c["options"] if o.get("id", "").startswith("e-") and o["id"] not in dec["eras"] and o["id"] != "e-hk-kung-fu")) + " (HK kung fu changes only its years, 1970–85, as a period)."]
    L += body
    L += para_ver(D, files, index_f, extra)
    L += rebase_section(A, D, extra)
    # the Korean New Wave of the 1980s: not created
    snap = json.load(open(os.path.join(converter.SNAP, "e-korean-new-wave-1980s.json")))
    ref, ids = converter.load_ids()
    k = [f for f in snap["films"] if f.get("imdb") and 1980 <= (f.get("year") or 0) <= 1995]
    kp = [f for f in k if (f.get("votes") or 0) >= 100 and (f.get("rating") or 0) >= 7.0]
    L += ["", "## Korean New Wave 1980–95: **not created**", "", f"- **Who decided:** the session (differs from the research, which recommended creating it): it is created only if it passes 20 films after the rating floor. The curation names {len(snap['films'])} films, {len(k)} with an IMDb id in 1980–95, **none in the catalogue**; **{len(kp)}** have 100 votes and 7.0 on IMDb, so about {round(len(kp) * 0.65)} would probably pass 3.5 on Letterboxd: far below 20. The candidates are kept in `research/2026-11-15-curadoria/e-korean-new-wave-1980s.json`: " + "; ".join(f"{f['title']} ({f['year']}, IMDb {f.get('rating')})" for f in sorted(kp, key=lambda f: -f['rating'])) + "."]
    # labels
    old = {o.get("id"): o["label"] for c in main_cat["catalogs"] for o in c["options"] if "label" in o and "directors" not in o}
    new = {o.get("id"): o["label"] for c in now_cat["catalogs"] for o in c["options"] if "label" in o and "directors" not in o}
    changed = [(old[i], new[i]) for i in new if i in old and old[i] != new[i]]
    born = [new[i] for i in new if i not in old]
    gone = [old[i] for i in old if i not in new]
    L += ["", "## Every label that changes or is born against the published main", "", "Each of these asks for the **same single reinstall** of the addon on the account: until then a device that has the old menu asks for a label that no longer exists and shows an empty page (and does not show the new ones).", "",
          "**Changed (old → new):**"] + [f"- {a} → **{b}**" for a, b in changed] + ["", "**Born:**"] + [f"- **{b}**" for b in born] + ["", "**Gone:**"] + [f"- {a}" for a in gone] + ["", f"In all: {len(changed)} changed, {len(born)} born, {len(gone)} gone (the Chinese and Polish cases of 14/11 are counted here too)."]
    open(os.path.join(ROOT, "research", "2026-11-15-eras-resultado.md"), "w", encoding="utf8").write("\n".join(L) + "\n")
    print("rows", len(rows), "| labels changed", len(changed), "born", len(born), "gone", len(gone))


if __name__ == "__main__":
    main(*sys.argv[1:8])
