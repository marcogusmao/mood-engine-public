"""Offline fixture and pixel assertions for the real cover renderer; requires Pillow."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/selo"))
from render import draw_one
from selo import layout, pilula_esquerda


def prepare(cache, tt):
    for folder in ["posters-raw", "posters-out", "flags"]:
        (cache / folder).mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (342, 513), (80, 90, 100)).save(cache / "posters-raw" / (tt + ".jpg"))
    flag = Image.new("RGB", (60, 40), (255, 0, 220))
    ImageDraw.Draw(flag).rectangle((30, 0, 59, 39), fill=(0, 245, 255))
    flag.save(cache / "flags/mx.png")


def check(cache, tt, published, year):
    with Image.open(published) as im:
        actual = im.convert("RGB")
    with Image.open(cache / "flags/mx.png") as im:
        flag = im.convert("RGBA")
    geometry = layout(actual.width)
    pill = pilula_esquerda(ImageDraw.Draw(actual), actual.width, geometry["margin"],
                          int(geometry["h"] * 0.8), geometry["pad"], year, flag, actual.width - geometry["margin"])
    x, y = pill["flag_xy"]
    w, h = pill["flag"].size
    # A no-flag control uses the same renderer, raw and year, including the pill background.
    control = cache / "control-no-flag.jpg"
    error = draw_one({"raw": str(cache / "posters-raw" / (tt + ".jpg")), "out": str(control), "year": year})
    assert error is None, error
    with Image.open(control) as im:
        absent = im.convert("RGB")
    points = [(x + w // 4, y + h // 2), (x + 3 * w // 4, y + h // 2)]
    for point, expected in zip(points, [(255, 0, 220), (0, 245, 255)]):
        pixel = actual.getpixel(point)
        assert max(abs(a - b) for a, b in zip(pixel, expected)) < 55, (point, pixel, expected)
        assert sum(abs(a - b) for a, b in zip(pixel, absent.getpixel(point))) > 150, "background is not evidence of a flag"
    print("flag pixels: both test colors present in flag region; no-flag control differs")


if __name__ == "__main__":
    mode, cache, tt, *rest = sys.argv[1:]
    if mode == "prepare":
        prepare(Path(cache), tt)
    elif mode == "check":
        check(Path(cache), tt, Path(rest[0]), int(rest[1]))
    else:
        raise ValueError(mode)
