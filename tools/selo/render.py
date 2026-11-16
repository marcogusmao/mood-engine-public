#!/usr/bin/env python3
"""Draws the ratings badge on covers. Called by build.js; needs Pillow (`pip install pillow`).

    python3 tools/selo/render.py jobs.json          draws every job, prints one JSON summary line
    python3 tools/selo/render.py --self-test        draws 5 sample covers in /tmp and checks them (dimensions, badges, the top-left year and flag, corners)

jobs.json: { "jobs": [ { "tt": "tt0068327", "raw": "cache/posters-raw/tt0068327.jpg", "out": "cache/posters-out/tt0068327.jpg",
                         "lb": 4.3, "imdb": 7.3, "amigos": 4.5, "viram": 3, "watchlist": true, "year": 1972, "flag": "cache/flags/us.png" } ],
             "workers": 4, "width": 342, "quality": 82 }
A number that is null or 0 leaves its badge out; "watchlist": true draws an icon-only bookmark at top right; a missing/false value draws none.
"year" and "flag" (a PNG path) fill the top-left pill, and either may be missing. A flag that
cannot be read is left out (the cover is still drawn, with the year alone) and counted. Summary: { "drawn": n, "failed": [ { "tt": ..., "error": ... } ],
"flagFailed": n }.
"""
import json
import os
import sys
import tempfile
from multiprocessing import Pool

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from selo import FONT_STEPS, aplicar_v2, layout, pilula_esquerda  # noqa: E402

WIDTH = 342
QUALITY = 82


def _load_flag(path):
    """The flag picture, or None when there is no path or the file cannot be read (a cover without its flag is better than no cover)."""
    if not path:
        return None, False
    try:
        with Image.open(path) as f:
            f.load()
            return f.convert("RGBA"), False
    except Exception:
        return None, True


def draw_one(job, width=WIDTH, quality=QUALITY, notes=None):
    """One cover → its JPEG. Returns None when drawn, or the error text. Written whole to a temp name, then renamed: a reader never meets half a file.
    `notes`, when given, gets "flag" appended if the job's flag could not be read."""
    try:
        flag, flag_bad = _load_flag(job.get("flag"))
        if flag_bad and notes is not None:
            notes.append("flag")
        with Image.open(job["raw"]) as raw:
            raw.load()
            out = aplicar_v2(
                raw, lb=job.get("lb") or None, imdb=job.get("imdb") or None, amigos=job.get("amigos") or None,
                n_viram=int(job.get("viram") or 0), na_watchlist=job.get("watchlist") is True, largura=width,
                ano=int(job["year"]) if job.get("year") else None, bandeira=flag,
            )
        os.makedirs(os.path.dirname(job["out"]) or ".", exist_ok=True)
        tmp = job["out"] + ".tmp.%d" % os.getpid()
        out.convert("RGB").save(tmp, format="JPEG", quality=quality, optimize=True)
        os.replace(tmp, job["out"])
        return None
    except Exception as e:  # a bad image must not stop the others
        return "%s: %s" % (type(e).__name__, e)


def _work(args):
    job, width, quality = args
    notes = []
    err = draw_one(job, width, quality, notes)
    return job["tt"], err, "flag" in notes


def run(spec):
    jobs = spec.get("jobs", [])
    width, quality = int(spec.get("width", WIDTH)), int(spec.get("quality", QUALITY))
    workers = max(1, min(int(spec.get("workers", os.cpu_count() or 2)), len(jobs) or 1))
    failed, drawn, flag_failed, flag_failed_ids = [], 0, 0, []
    if workers == 1 or len(jobs) < 8:
        for tt, err, fb in map(_work, [(j, width, quality) for j in jobs]):
            flag_failed += fb
            if fb: flag_failed_ids.append(tt)
            if err: failed.append({"tt": tt, "error": err})
            else: drawn += 1
    else:
        with Pool(workers) as pool:
            for n, (tt, err, fb) in enumerate(pool.imap_unordered(_work, [(j, width, quality) for j in jobs], chunksize=16), 1):
                flag_failed += fb
                if fb: flag_failed_ids.append(tt)
                if err: failed.append({"tt": tt, "error": err})
                else: drawn += 1
                if n % 1000 == 0:
                    print("progress covers drawn %d/%d" % (n, len(jobs)), file=sys.stderr, flush=True)
    return {"drawn": drawn, "failed": failed, "flagFailed": flag_failed, "flagFailedIds": flag_failed_ids}


# ── self-test ────────────────────────────────────────────────────────────────

def _close(px, want, tol):
    return all(abs(a - b) <= tol for a, b in zip(px[:3], want[:3]))


def _row_has(img, y, color, tol=40):
    """True when some pixel on row y is within `tol` of `color` (JPEG blurs the edges, so not exact)."""
    px = img.load()
    return any(_close(px[x, y], color, tol) for x in range(img.width))


BLUE, WHITE, RED = (0, 60, 200), (255, 255, 255), (220, 20, 40)
PILL = (20, 24, 28)  # the dark pill's colour, with the alpha the cover drops when it is saved


def _flag_file(path, bands):
    """A 80x53 flag of vertical bands, written as a PNG (the self-test needs no downloaded flag)."""
    im = Image.new("RGB", (80, 53))
    px = im.load()
    for x in range(80):
        for y in range(53):
            px[x, y] = bands[min(x * len(bands) // 80, len(bands) - 1)]
    im.save(path)
    return path


def _first_x(img, y, x0, x1, color, tol=40):
    px = img.load()
    return next((x for x in range(x0, x1) if _close(px[x, y], color, tol)), None)


def _top_left_in_memory(folder, problems):
    """The top-left pill, checked on the picture before it is saved (exact pixels): where it is, the flag's colours in order, the year,
    the corners and the border of the flag, the pill's height against the top-right marker's, and the font going down when the pills would meet."""
    BASE = (200, 200, 200)
    L = layout(WIDTH)
    h, m, pad = L["h"], L["margin"], L["pad"]
    hb = int(h * 0.8)
    mid = m + hb // 2
    flag = Image.open(_flag_file(os.path.join(folder, "flag-bluewhitered.png"), [BLUE, WHITE, RED])).convert("RGBA")
    im = aplicar_v2(Image.new("RGB", (500, 750), BASE), imdb=7.8, na_watchlist=True, ano=1957, bandeira=flag, largura=WIDTH).convert("RGB")
    px = im.load()
    is_base, is_pill = (lambda p: _close(p, BASE, 6)), (lambda p: _close(p, PILL, 30))
    if not is_base(px[m - 2, mid]) or not is_pill(px[m + 2, mid]): problems.append("top left: the pill does not start at the margin (%d px from the edge)" % m)
    for name, x in (("top left", m + 30), ("top right", WIDTH - m - 14)):  # one column through each pill, clear of its rounded corners and of the flag
        if not is_base(px[x, m - 2]): problems.append("%s: something is drawn above the pill, in the margin" % name)
        if not is_pill(px[x, m + 1]): problems.append("%s: the pill does not start %d px from the top" % (name, m))
        if not is_pill(px[x, m + hb - 2]): problems.append("%s: the pill is shorter than the %d px marker" % (name, hb))
        if not is_base(px[x, m + hb + 3]): problems.append("%s: the pill is taller than the %d px marker" % (name, hb))
    if not is_base(px[WIDTH - m + 3, mid]) or not is_pill(px[WIDTH - m - 3, mid]): problems.append("top right: the marker moved off its margin")
    xb, xw, xr = (_first_x(im, mid, m, m + 70, c) for c in (BLUE, WHITE, RED))
    if None in (xb, xw, xr) or not xb < xw < xr: problems.append("top left: the flag's blue, white and red are not there in that order on the left of the pill (%r)" % ((xb, xw, xr),))
    if xb is not None and xb > m + pad * 2: problems.append("top left: the flag does not sit at the left of the pill (blue starts %d px in)" % (xb - m))
    white = sum(1 for x in range(m + 50, m + 84) for y in range(m, m + hb) if _close(px[x, y], WHITE, 30))
    if white < 40: problems.append("top left: the year is not drawn in white to the right of the flag (%d white pixels)" % white)
    # the year sits after a small gap from the flag and is centred on the pill's height (the white pixels right of the flag, inside the pill)
    d0 = ImageDraw.Draw(Image.new("RGBA", (WIDTH, 513)))
    tri = pilula_esquerda(d0, WIDTH, m, hb, pad, 1957, flag, WIDTH - m)
    fx0, fw0 = tri["flag_xy"][0], tri["flag"].width
    cols = [x for x in range(fx0 + fw0, m + tri["w"]) if any(_close(px[x, y], WHITE, 30) for y in range(m + 2, m + hb - 2))]
    rows = [y for y in range(m + 1, m + hb - 1) if any(_close(px[x, y], WHITE, 30) for x in range(fx0 + fw0 + 1, m + tri["w"] - 3))]
    if not cols or cols[0] - (fx0 + fw0) < 3: problems.append("top left: the year touches the flag (first white pixel %s px after it, wanted 3 or more)" % (cols[0] - (fx0 + fw0) if cols else "none"))
    if not rows or abs((rows[0] + rows[-1]) / 2 - (m + hb / 2)) > 2.5: problems.append("top left: the year is not centred on the pill's height (its digits span rows %s to %s, the pill's middle is %s)" % (rows[0] if rows else None, rows[-1] if rows else None, m + hb / 2))
    # the flag's corners and border, on a solid red flag
    red = Image.open(_flag_file(os.path.join(folder, "flag-red.png"), [RED])).convert("RGBA")
    box = pilula_esquerda(ImageDraw.Draw(Image.new("RGBA", (WIDTH, 513))), WIDTH, m, hb, pad, 2002, red, WIDTH - m)
    fx, fy = box["flag_xy"]
    fw, fh = box["flag"].size
    im2 = aplicar_v2(Image.new("RGB", (500, 750), BASE), ano=2002, bandeira=red, largura=WIDTH).convert("RGB")
    q = im2.load()
    if q[fx + fw // 2, fy][1] < 60 or q[fx, fy + fh // 2][1] < 60: problems.append("flag: no white border on its edge (green %d, %d; red flag, so green must come from the border)" % (q[fx + fw // 2, fy][1], q[fx, fy + fh // 2][1]))
    if q[fx + fw // 2, fy + 4][1] > 30 or q[fx + fw // 2, fy + 4][0] < 170: problems.append("flag: the inside is not the flag's own red (%r)" % (q[fx + fw // 2, fy + 4],))
    if q[fx, fy][0] > 180: problems.append("flag: its corner is square (red %d at the very corner; slightly rounded corners let the dark pill show)" % q[fx, fy][0])
    if abs(fh - hb * 0.6) > 1: problems.append("flag: %d px tall, wanted 60%% of the pill (%.1f px)" % (fh, hb * 0.6))
    # the year alone, a flag alone, and the font going one step down when the pills would meet
    d = ImageDraw.Draw(Image.new("RGBA", (WIDTH, 513)))
    roomy = pilula_esquerda(d, WIDTH, m, hb, pad, 1957, flag, WIDTH - m)
    snug = pilula_esquerda(d, WIDTH, m, hb, pad, 1957, flag, roomy["x"] + roomy["w"] + m - 3)
    tight = pilula_esquerda(d, WIDTH, m, hb, pad, 1957, flag, 0)
    if roomy["step"] != 0: problems.append("pills: with room to spare the year is already a step smaller")
    if snug["step"] != 1 or not snug["font"].size < roomy["font"].size: problems.append("pills: when they would meet, the font should go exactly one step down (step %s)" % snug["step"])
    if snug["x"] + snug["w"] + m > roomy["x"] + roomy["w"] + m - 3: problems.append("pills: one step down still leaves the two pills meeting")
    if tight["step"] != len(FONT_STEPS) - 1: problems.append("pills: with no room at all the smallest font should be used (step %s)" % tight["step"])
    if pilula_esquerda(d, WIDTH, m, hb, pad, None, None, WIDTH - m) is not None: problems.append("pills: a film with no year and no flag still gets a pill")
    only_flag = pilula_esquerda(d, WIDTH, m, hb, pad, None, flag, WIDTH - m)
    if only_flag is None or only_flag["text"] or only_flag["w"] >= roomy["w"]: problems.append("pills: a flag with no year should be a pill with the flag alone")


def self_test(folder=None):
    folder = folder or os.path.join("/tmp" if os.path.isdir("/tmp") else tempfile.gettempdir(), "mood-selo-selftest")
    os.makedirs(folder, exist_ok=True)
    BASE = (200, 200, 200)  # a flat mid-grey "cover": any dark corner or coloured badge on it came from the badge code
    raw_path = os.path.join(folder, "raw.png")
    Image.new("RGB", (500, 750), BASE).save(raw_path)
    flag_path = _flag_file(os.path.join(folder, "flag-bluewhitered.png"), [BLUE, WHITE, RED])
    cases = {
        "all": dict(lb=4.3, imdb=7.3, amigos=4.5, viram=3, watchlist=True, year=1957, flag=flag_path),
        "year-only": dict(imdb=7.8, year=2002),
        "bad-flag": dict(imdb=7.8, year=2002, flag=os.path.join(folder, "no-such-flag.png")),
        "imdb-only": dict(imdb=7.8),
        "nothing": dict(),
    }
    jobs = [dict(tt="selftest-" + k, raw=raw_path, out=os.path.join(folder, k + ".jpg"), **v) for k, v in cases.items()]
    summary = run({"jobs": jobs, "workers": 1})
    problems = []
    if summary["failed"]:
        problems.append("drawing failed: %r" % summary["failed"])
    else:
        L = layout(WIDTH)
        h, m = L["h"], L["margin"]
        if abs(L["sup"].size - h * 0.5) > 1: problems.append("the superscript is %s px, wanted half the badge height (%s px)" % (L["sup"].size, h * 0.5))
        if summary.get("flagFailed") != 1: problems.append("an unreadable flag should be counted once in flagFailed (got %r)" % summary.get("flagFailed"))
        ims = {k: Image.open(os.path.join(folder, k + ".jpg")).convert("RGB") for k in cases}
        for k, im in ims.items():
            if im.size != (WIDTH, 513):
                problems.append("%s: size %s, wanted (%d, 513)" % (k, im.size, WIDTH))
        row = ims["all"].height - m - h // 2  # the middle of the badge strip
        corner_bottom, corner_top = (3, ims["all"].height - 3), (WIDTH - m - 3, m + int(h * 0.4))
        corner_top_left = (m + 3, m + int(h * 0.4))
        a, b, c = ims["all"], ims["imdb-only"], ims["nothing"]
        if not _close(c.getpixel(corner_bottom), BASE, 6): problems.append("nothing: the bottom-left corner is not the plain cover")
        if not _close(c.getpixel(corner_top), BASE, 6): problems.append("nothing: the top-right corner is not the plain cover")
        if not _close(c.getpixel(corner_top_left), BASE, 6): problems.append("nothing: the top-left corner is not the plain cover")
        for name, im in (("all", a), ("imdb-only", b)):
            if _close(im.getpixel(corner_bottom), BASE, 40): problems.append("%s: no dark strip in the bottom-left corner" % name)
        if not _close(a.getpixel(corner_top), (40, 44, 48), 28): problems.append("all: no watchlist bookmark in the top-right corner (got %r)" % (a.getpixel(corner_top),))
        if not _close(b.getpixel(corner_top), BASE, 6): problems.append("imdb-only: a marker appeared in the top-right corner")
        if not _row_has(a, row, (245, 197, 24)): problems.append("all: no IMDb yellow in the strip")
        if not _row_has(a, row, (124, 58, 237)): problems.append("all: no friends purple in the strip")
        if not _row_has(a, row, (20, 24, 28), 14): problems.append("all: no Letterboxd dark badge in the strip")
        if not _row_has(b, row, (245, 197, 24)): problems.append("imdb-only: no IMDb yellow in the strip")
        if _row_has(b, row, (124, 58, 237)): problems.append("imdb-only: friends purple where there are no friends")
        if _row_has(c, row, (245, 197, 24)) or _row_has(c, row, (124, 58, 237)): problems.append("nothing: a badge where there is nothing to show")
        # the top-left pill, as saved (JPEG blurs, so the tolerances are wide)
        mid = m + int(h * 0.8) // 2
        for name in ("all", "year-only", "bad-flag"):
            if not _close(ims[name].getpixel(corner_top_left), PILL, 30): problems.append("%s: no year pill in the top-left corner (got %r)" % (name, ims[name].getpixel(corner_top_left)))
        for name in ("imdb-only", "nothing"):
            if not _close(ims[name].getpixel(corner_top_left), BASE, 6): problems.append("%s: a pill appeared in the top-left corner of a cover with no year" % name)
        xb, xw, xr = (_first_x(a, mid, m, m + 70, col) for col in (BLUE, WHITE, RED))
        if None in (xb, xw, xr) or not xb < xw < xr: problems.append("all: the flag is not in the top-left pill (blue, white, red at %r)" % ((xb, xw, xr),))
        for name in ("year-only", "bad-flag"):
            if any(_first_x(ims[name], mid, m, m + 70, col) is not None for col in (BLUE, RED)): problems.append("%s: flag colours in a pill that has no flag" % name)
        for name in ("all", "year-only", "bad-flag"):
            white = sum(1 for x in range(m, m + 90) for y in range(m, m + int(h * 0.8)) if _close(ims[name].getpixel((x, y)), WHITE, 40))
            if white < 40: problems.append("%s: the year is not drawn in the top-left pill (%d white pixels)" % (name, white))
        _top_left_in_memory(folder, problems)
    for p in problems:
        print("✖ " + p)
    if not problems:
        print("✔ self-test: %d covers drawn in %s (all badges with year and flag, year only, a flag that cannot be read, IMDb only, nothing): size, strip, badges, top-left pill, flag, corners as expected" % (len(cases), folder))
    return 0 if not problems else 1


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    with open(sys.argv[1]) as f:
        out = run(json.load(f))
    print(json.dumps(out))
    sys.exit(0 if not out["failed"] else 3)
