"""Ratings badge on the cover (variant 1: a strip at the foot with the badges evenly spaced).

Official marks: lb-dots-crop.png (Letterboxd's three dots, from letterboxd-decal-dots-pos-rgb.svg without the round
background) and imdb-48-crop.png (from IMDB_Logo_2016.svg). Font: LiberationSans-Bold.ttf (SIL OFL 1.1, see
LiberationSans-LICENSE.txt), the same file on every machine, so the covers drawn on the Mac and on the GitHub runner match.

    from selo import aplicar_v2
    aplicar_v2(img, lb=4.3, imdb=7.3, amigos=4.5, n_viram=3, na_watchlist=True, ano=1957, bandeira=<PIL image>) -> RGBA, 342 px wide

Decided by Marco on 10/10/2026: the friends badge carries the number of followed people who saw the film as a superscript
(`4.5` with a small `2` = 2 saw it, average 4.5).
Marco, 12/10/2026: the top-right marker is a bookmark without a count, shown only for his own watchlist membership.
The superscript is half the badge height (it was 0.44 and read too small on the TV).

Decided by Marco on 10/10/2026 (v2.2): the top-left corner carries the film's release year and its country's flag, in a pill of the
same height and style as the top-right marker: the flag on the left (60% of the pill's height, slightly rounded corners, a 1 px white
border at 40% so a white flag such as Japan's or Poland's does not melt into the pill), the year on the right in bold. If the two
pills would meet on a narrow cover, the year's font goes one step down. A film with no known flag shows the year alone.
"""
from PIL import Image, ImageChops, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BOLD = os.path.join(HERE, "LiberationSans-Bold.ttf")
DOTS = Image.open(os.path.join(HERE, "lb-dots-crop.png")).convert("RGBA")
IMDB = Image.open(os.path.join(HERE, "imdb-48-crop.png")).convert("RGBA")
LB_BG = (20, 24, 28, 242)
IMDB_BG = (245, 197, 24, 250)
FR_BG = (124, 58, 237, 242)
SUP_RATIO = 0.50  # the superscript's height, as a fraction of the badge height
BAND_ALPHA = 150  # the strip behind the badges: black at this opacity (0-255)
MARKER_BG = (20, 24, 28, 225)
FLAG_RATIO = 0.60  # the flag's height, as a fraction of the pill's height
FLAG_RADIUS = 0.12  # its corner radius, as a fraction of its height ("slightly rounded")
FLAG_BORDER = (255, 255, 255, 102)  # 1 px, white at 40%
FONT_STEPS = (0.58, 0.50, 0.43)  # the pills' font as a fraction of the pill's height: the normal size, then one and two steps down


def _font(px):
    return ImageFont.truetype(BOLD, max(1, int(px)))


def _fit(img, h):
    return img.resize((max(1, int(img.width * h / img.height)), h), Image.LANCZOS)


def _people(h):
    """Two people, white, as the friends badge's icon."""
    ic = Image.new("RGBA", (int(h * 1.3), h), (0, 0, 0, 0))
    g = ImageDraw.Draw(ic)
    r = h * 0.19
    cy = h * 0.5
    g.ellipse([0, cy - r * 2.2, 2 * r, cy - r * 0.2], fill=(255, 255, 255))
    g.ellipse([r * 1.7, cy - r * 2.5, r * 4.1, cy - r * 0.2], fill=(255, 255, 255))
    g.rounded_rectangle([-r * 0.3, cy, r * 2.6, cy + r * 2.1], radius=r, fill=(255, 255, 255))
    g.rounded_rectangle([r * 1.5, cy, r * 4.8, cy + r * 2.4], radius=r, fill=(255, 255, 255))
    return ic


def bookmark(h):
    """A white bookmark, the marker's icon."""
    ic = Image.new("RGBA", (int(h * 0.7), h), (0, 0, 0, 0))
    g = ImageDraw.Draw(ic)
    w = ic.width
    g.polygon([(0, 0), (w, 0), (w, h), (w / 2, h * 0.72), (0, h)], fill=(255, 255, 255))
    return ic


def flag_badge(flag, h):
    """The flag as a picture `h` px tall: slightly rounded corners and a 1 px white border at 40% (the corners and the border are drawn 4x
    larger and brought down, so their edges are smooth)."""
    S = 4
    w = max(1, round(flag.width * h / flag.height))
    pic = flag.convert("RGBA").resize((w, h), Image.LANCZOS)
    r = max(1, round(h * FLAG_RADIUS))
    mask = Image.new("L", (w * S, h * S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w * S - 1, h * S - 1], radius=r * S, fill=255)
    pic.putalpha(ImageChops.multiply(pic.getchannel("A"), mask.resize((w, h), Image.LANCZOS)))
    ring = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle([0, 0, w * S - 1, h * S - 1], radius=r * S, outline=FLAG_BORDER, width=S)
    return Image.alpha_composite(pic, ring.resize((w, h), Image.LANCZOS))


def _pill(dr, x, y, w, hb):
    """The dark pill both top corners use (one function, so the two can never drift apart). Drawn straight into the RGBA picture, so MARKER_BG's
    alpha (225) replaces the cover's instead of blending with it, and the JPEG drops it: in practice both pills are opaque (20, 24, 28)."""
    dr.rounded_rectangle([x, y, x + w, y + hb], radius=int(hb * 0.32), fill=MARKER_BG)


def pilula_esquerda(dr, W, margem, hb, pad, ano, bandeira, limite_direito):
    """Geometry of the top-left pill (year + flag), without drawing it. `limite_direito` is where the top-right marker starts (W - margem when
    there is none). The year's font goes one step down, then two, until the pill ends at least `margem` before that; the last step is
    used when even it does not fit. → { x, y, w, hb, step, font, flag (a picture or None), flag_xy, text, text_xy } or None when there is nothing to show."""
    if not ano and bandeira is None:
        return None
    txt = str(ano) if ano else ""
    pic = flag_badge(bandeira, int(hb * FLAG_RATIO)) if bandeira is not None else None
    for step, ratio in enumerate(FONT_STEPS):
        f = _font(hb * ratio)
        w = int(pad * 0.8 + (pic.width if pic else 0) + (pad * 0.45 if pic and txt else 0) + (dr.textlength(txt, font=f) if txt else 0) + pad * 0.8)
        if margem + w + margem <= limite_direito or step == len(FONT_STEPS) - 1:
            break
    x, y = margem, margem
    fx = x + pad * 0.8
    return {
        "x": x, "y": y, "w": w, "hb": hb, "step": step, "font": f, "flag": pic, "flag_xy": (int(fx), int(y + (hb - pic.height) / 2)) if pic else None,
        "text": txt, "text_xy": (fx + (pic.width + pad * 0.45 if pic else 0), y + hb / 2 - f.size * 0.58),
    }


def layout(width):
    """Sizes derived from the cover's width: badge height, margin, padding, fonts."""
    h = int(width * 0.115)
    return {"h": h, "margin": int(width * 0.03), "pad": int(h * 0.24), "font": _font(h * 0.62), "sup": _font(h * SUP_RATIO)}


def aplicar_v2(im, lb=None, imdb=None, amigos=None, n_viram=0, n_querem=0, largura=342, ano=None, bandeira=None, na_watchlist=False):
    """Draws the strip, the top-right marker and the top-left year/flag pill on a copy of `im`, resized to `largura` px wide.

    lb, imdb, amigos are averages (Letterboxd 0-5, IMDb 0-10, friends 0-5); n_viram is a count. n_querem is ignored for legacy callers;
    na_watchlist=True shows the personal bookmark. ano is the release year and
    bandeira the flag (a PIL image, or None for the year alone). A badge whose number is missing is left out; with nothing to show the
    cover is only resized."""
    im = im.convert("RGBA")
    im = im.resize((largura, int(largura * im.height / im.width)), Image.LANCZOS)
    W, H = im.size
    L = layout(W)
    h, margem, pad, fnt, sup = L["h"], L["margin"], L["pad"], L["font"], L["sup"]
    items = []
    if lb:
        items.append((LB_BG, _fit(DOTS, int(h * 0.42)), f"{lb:.1f}", None, (255, 255, 255)))
    if imdb:
        items.append((IMDB_BG, _fit(IMDB, int(h * 0.46)), f"{imdb:.1f}", None, (20, 20, 20)))
    if n_viram:
        items.append((FR_BG, _fit(_people(64), int(h * 0.56)), f"{amigos:.1f}" if amigos else "–", str(n_viram), (255, 255, 255)))
    if not items and not na_watchlist and not ano and bandeira is None:
        return im
    if items:
        ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(ov).rectangle([0, H - h - 2 * margem, W, H], fill=(0, 0, 0, BAND_ALPHA))
        im = Image.alpha_composite(im, ov)
    dr = ImageDraw.Draw(im)
    if items:
        sizes = [int(pad + ic.width + int(pad * 0.55) + dr.textlength(txt, font=fnt) + (dr.textlength(ex, font=sup) + 3 if ex else 0) + pad) for bg, ic, txt, ex, fg in items]
        total = sum(sizes)
        gap = max(min((W - 2 * margem - total) / max(len(items) - 1, 1), int(W * 0.06)), 6)
        x, y = margem, H - h - margem
        for (bg, ic, txt, ex, fg), w in zip(items, sizes):
            dr.rounded_rectangle([x, y, x + w, y + h], radius=int(h * 0.32), fill=bg)
            im.alpha_composite(ic, (int(x + pad), int(y + (h - ic.height) / 2)))
            tx = x + pad + ic.width + int(pad * 0.55)
            dr.text((tx, y + h / 2 - fnt.size * 0.58), txt, font=fnt, fill=fg)
            if ex:
                dr.text((tx + dr.textlength(txt, font=fnt) + 3, y + h * 0.06), ex, font=sup, fill=fg)
            x += w + gap
    hb = int(h * 0.8)
    right_x = W - margem
    if na_watchlist is True:
        ic = _fit(bookmark(64), int(hb * 0.6))
        w = int(pad * 0.8 + ic.width + pad * 0.8)
        x, y = W - margem - w, margem
        right_x = x
        _pill(dr, x, y, w, hb)
        im.alpha_composite(ic, (int(x + pad * 0.8), int(y + (hb - ic.height) / 2)))
    left = pilula_esquerda(dr, W, margem, hb, pad, ano, bandeira, right_x)
    if left:
        _pill(dr, left["x"], left["y"], left["w"], hb)
        if left["flag"] is not None:
            im.alpha_composite(left["flag"], left["flag_xy"])
        if left["text"]:
            dr.text(left["text_xy"], left["text"], font=left["font"], fill=(255, 255, 255))
    return im
