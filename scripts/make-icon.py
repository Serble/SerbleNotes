#!/usr/bin/env python3
"""Builds the platform icon sources from the one drawing of the mark.

`SerbleNotes.App/public/icon.svg` is the mark, and it is the only place its geometry exists outside
the app's own `LogoIcon`. This script rasterises it rather than redrawing it, so a change to the
mark reaches the desktop, Windows, iOS and Android icons without anyone copying paths around.

It writes three sources into `SerbleNotes.App/icon-build/`, which is ignored by git - only the icon
sets they produce are committed:

    icon-source.png      1024px tile, the mark on the app's own dark ground. Desktop, Windows, iOS.
    icon-foreground.png  1024px transparent, the mark alone, inside an adaptive icon's safe zone.
    icon-background.png  1024px of flat ground, the other half of the Android adaptive icon.
    manifest.json        what `tauri icon` reads to use all three.

Then:

    python3 scripts/make-icon.py
    cd SerbleNotes.App; npx tauri icon icon-build/manifest.json
    python3 scripts/make-icon.py --sync-android

`tauri icon` writes the Android set straight into `gen/android` when that project exists, and leaves
`src-tauri/icons/android` alone - which is the copy `tauri android init` seeds a *new* project from.
The last step copies the first back over the second so the two cannot drift.

Needs `pillow` and `cairosvg`.
"""

import argparse
import io
import json
import shutil
import sys
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MARK = ROOT / "SerbleNotes.App" / "public" / "icon.svg"
BUILD = ROOT / "SerbleNotes.App" / "icon-build"
ICONS = ROOT / "SerbleNotes.App" / "src-tauri" / "icons"
ANDROID_RES = ROOT / "SerbleNotes.App" / "src-tauri" / "gen" / "android" / "app" / "src" / "main" / "res"

SIZE = 1024

# The app's own --surface and --border, and the accent that is meant for a dark ground. The mark's
# committed colour is the deep blue, which is the one that survives being embedded on an unknown
# background; here the background is known, so it takes the light one.
GROUND = (17, 21, 26, 255)
EDGE = (44, 52, 63, 255)
ON_DARK = "#74a4ff"

# Fractions of the canvas. The tile is a launcher icon and can fill most of it. An adaptive icon's
# foreground is masked to a circle covering about two thirds of the canvas, and anything outside
# that can be cropped off by the launcher, so the mark has to be small enough to sit inside it.
TILE_MARK = 0.62
ADAPTIVE_MARK = 0.46
CORNER = 0.215


def mark(pixels: int, colour: str) -> Image.Image:
    """The mark on its own, transparent, at the given size."""
    svg = MARK.read_text().replace("#2f6feb", colour)
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=pixels, output_height=pixels)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def rounded_tile() -> Image.Image:
    """The dark ground the mark sits on, rounded like an app icon rather than square."""
    from PIL import ImageDraw

    # Drawn oversized and downsampled, which is how the corners come out clean.
    scale = 4
    canvas = SIZE * scale
    tile = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    radius = CORNER * canvas
    draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=radius, fill=GROUND)
    inset = canvas * 0.006
    draw.rounded_rectangle(
        [inset, inset, canvas - inset - 1, canvas - inset - 1],
        radius=radius - inset,
        outline=EDGE,
        width=int(canvas * 0.009),
    )
    return tile.resize((SIZE, SIZE), Image.LANCZOS)


def centred(background: Image.Image, glyph: Image.Image) -> Image.Image:
    out = background.copy()
    offset = ((out.width - glyph.width) // 2, (out.height - glyph.height) // 2)
    out.alpha_composite(glyph, offset)
    return out


def build() -> None:
    BUILD.mkdir(exist_ok=True)

    tile = centred(rounded_tile(), mark(int(SIZE * TILE_MARK), ON_DARK))
    tile.save(BUILD / "icon-source.png")

    foreground = centred(
        Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mark(int(SIZE * ADAPTIVE_MARK), ON_DARK)
    )
    foreground.save(BUILD / "icon-foreground.png")

    Image.new("RGBA", (SIZE, SIZE), GROUND).save(BUILD / "icon-background.png")

    (BUILD / "manifest.json").write_text(
        json.dumps(
            {
                "default": "icon-source.png",
                "android_fg": "icon-foreground.png",
                "android_bg": "icon-background.png",
                # iOS icons cannot have transparency, so this is what shows through behind the mark.
                "bg_color": "#11151a",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {BUILD.relative_to(ROOT)}/ - now run: cd SerbleNotes.App; npx tauri icon icon-build/manifest.json")


def sync_android() -> None:
    """Copy the launcher icon out of the generated Android project and back into src-tauri/icons.

    Backwards from what it looks like, on purpose. `tauri icon` notices that gen/android exists and
    writes the Android set directly there, so that project is already right; what it does not touch
    is src-tauri/icons/android, which is what `tauri android init` copies from when the project is
    created from scratch. Left alone, that seed keeps whatever icon the app had when it was first
    generated, and reappears the day someone wipes gen/android.
    """
    if not (ANDROID_RES / "mipmap-anydpi-v26").is_dir():
        sys.exit("no generated Android resources - run `npx tauri icon icon-build/manifest.json` first")

    copied = 0
    for source in sorted(ANDROID_RES.glob("mipmap-*/*")):
        target = ICONS / "android" / source.relative_to(ANDROID_RES)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copied += 1

    # The adaptive icon now names a background image rather than a colour resource, so the colour
    # that used to stand in for it is dead weight in the seed.
    stale = ICONS / "android" / "values"
    if stale.is_dir():
        shutil.rmtree(stale)

    print(f"copied {copied} files into {(ICONS / 'android').relative_to(ROOT)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sync-android", action="store_true", help="copy the Android set into gen/android")
    args = parser.parse_args()

    if args.sync_android:
        sync_android()
    else:
        build()
