#!/usr/bin/env python3
"""
Regenerate app icons (128x128 PNG) with the same rounded-square BMW-style look.

Run: python docs/make_icons.py

Writes:
  apps/edzco_popbang/icon.png
  apps/edzco_mscene/icon.png

Pure stdlib + Pillow. Icons use the M tricolour stripe as the shared signature,
the app-specific motif centred above it (flame for Pop-Bang, radial halo for
M Scenes), on the same deep-black rounded square the other MGU apps use.
"""
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    print("Needs Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
SIZE = 128
CORNER = 24
BG = (10, 12, 16)          # deep near-black
EDGE = (36, 44, 57)         # panel edge
M_BLUE = (129, 196, 255)
M_MID = (22, 88, 142)
M_RED = (231, 34, 46)
TEXT = (244, 247, 251)
WARM = (255, 183, 60)
ACCENT_RED = (225, 0, 26)
ACCENT_AMBER = (255, 157, 0)
ACCENT_MAGENTA = (176, 80, 220)


def rounded_square(size, bg, edge, corner):
    """base plate with 1px stroked edge."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=corner, fill=bg, outline=edge, width=1)
    return img


def m_stripes(img, x, y, w, h):
    """Three-colour M stripe used by both icons (same width, same position)."""
    d = ImageDraw.Draw(img)
    parts = [M_BLUE, M_MID, M_RED]
    pw = w // 3
    for i, c in enumerate(parts):
        d.rectangle([x + i * pw, y, x + (i + 1) * pw - 1, y + h - 1], fill=c)


def pick_font(size):
    """Find a bold system font; fall back to the default bitmap font."""
    for cand in [
        "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc", "/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]:
        try:
            return ImageFont.truetype(cand, size)
        except Exception:
            pass
    return ImageFont.load_default()


def edz_wordmark(img, text="EDZ"):
    """Draw the EDZ wordmark along the top-left, big and legible, with a subtle shadow.
    Kept uniform between the two icons so they read as one brand."""
    d = ImageDraw.Draw(img)
    font = pick_font(22)
    # one-pixel dark shadow under the text so it stays legible on bright motifs
    d.text((11, 9), text, fill=(0, 0, 0, 180), font=font)
    d.text((10, 8), text, fill=TEXT, font=font)


def popbang_icon(path):
    """A flame + M stripe. Flame is three stacked ellipses, hot-amber ramp."""
    img = rounded_square(SIZE, BG, EDGE, CORNER)
    d = ImageDraw.Draw(img)

    # Flame body (outer glow -> inner tip)
    flame_center = (64, 58)
    # soft outer glow
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([flame_center[0] - 30, flame_center[1] - 36,
                flame_center[0] + 30, flame_center[1] + 36], fill=(225, 80, 30, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(5))
    img.alpha_composite(glow)

    # flame outer
    d.ellipse([flame_center[0] - 22, flame_center[1] - 28,
               flame_center[0] + 22, flame_center[1] + 28], fill=ACCENT_RED)
    # middle amber
    d.ellipse([flame_center[0] - 15, flame_center[1] - 18,
               flame_center[0] + 15, flame_center[1] + 22], fill=ACCENT_AMBER)
    # inner hot tip
    d.ellipse([flame_center[0] - 8, flame_center[1] - 8,
               flame_center[0] + 8, flame_center[1] + 14], fill=(255, 235, 170))

    # M stripe along the bottom
    m_stripes(img, 20, 100, 88, 12)

    edz_wordmark(img)
    img.save(path, "PNG")
    print(f"wrote {path}")


def lights_icon(path):
    """Two BMW-style quad headlights (angel eyes) casting beams. + M stripe + EDZ wordmark."""
    img = rounded_square(SIZE, BG, EDGE, CORNER)
    d = ImageDraw.Draw(img)

    # beams (soft cones from each lamp, blurred)
    beams = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bd = ImageDraw.Draw(beams)
    # left beam cone
    bd.polygon([(34, 56), (6, 76), (6, 44)], fill=(255, 220, 160, 90))
    # right beam cone
    bd.polygon([(94, 56), (122, 76), (122, 44)], fill=(255, 220, 160, 90))
    beams = beams.filter(ImageFilter.GaussianBlur(3))
    img.alpha_composite(beams)

    # two angel-eye rings (left + right lamps)
    for cx in (34, 94):
        # outer ring (cool white)
        d.ellipse([cx - 14, 56 - 14, cx + 14, 56 + 14],
                  outline=(235, 242, 255), width=3)
        # inner lamp body
        d.ellipse([cx - 9, 56 - 9, cx + 9, 56 + 9],
                  fill=(255, 231, 173))
        # hot centre
        d.ellipse([cx - 4, 56 - 4, cx + 4, 56 + 4],
                  fill=(255, 255, 240))

    # M stripe along the bottom
    m_stripes(img, 20, 100, 88, 12)

    edz_wordmark(img)
    img.save(path, "PNG")
    print(f"wrote {path}")


def main():
    popbang_icon(ROOT / "apps" / "edzco_popbang" / "icon.png")
    lights_icon(ROOT / "apps" / "edzco_lights" / "icon.png")


if __name__ == "__main__":
    main()
