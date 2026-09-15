#!/usr/bin/env python3
"""Build the "uncut material" plate: the hero with the letters not yet cut.

The animation needs something to show where the beam has not reached yet. This
paints the lettering out so the laser has blank stock to cut into, which is what
lets the letters be created by the beam rather than merely traced.

The original photograph is never written to. This produces a separate asset,
assets/img/hero-blank.png, cropped to the lettering, which the animation lays
over the plate and then erases along the cut path. By the end every letter has
been erased, so the final frame is the untouched photograph again.

Takes the letter mask from tools/build-cut-program.py, so the two always agree.

    python3 tools/build-cut-program.py     # writes tools/letter-mask.png
    python3 tools/make-blank-plate.py
    python3 tools/build-cut-program.py     # picks up the stock entry

Requires pillow and numpy.
"""
import json, os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
MASK = os.path.join(ROOT, 'tools', 'letter-mask.png')
OUT = os.path.join(ROOT, 'assets', 'img', 'hero-blank.png')
META = os.path.join(ROOT, 'tools', 'blank-meta.json')

GROW = 27          # cover the acrylic's lit edges and its reflection, not just the face

im = Image.open(PLATE).convert('RGB')
W, H = im.size
src = np.asarray(im).astype(np.float32)
lum = 0.299 * src[:, :, 0] + 0.587 * src[:, :, 1] + 0.114 * src[:, :, 2]

letters = np.asarray(Image.open(MASK).convert('L')) > 127
if letters.shape != (H, W):
    raise SystemExit('letter mask is %s but the plate is %s -- rerun build-cut-program.py'
                     % (letters.shape, (H, W)))
grown = np.asarray(
    Image.fromarray((letters * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(GROW))) > 127

# Clear acrylic throws a lit edge and a reflection just outside the traced glyph.
# Those survive a plain grow and read as ghost lettering on blank stock, so any
# bright pixel in the glyph's neighbourhood is painted out too.
near = np.asarray(
    Image.fromarray((grown * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(45))) > 127
grown |= near & (lum > 105)
grown = np.asarray(
    Image.fromarray((grown * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 127
print('letter pixels %d -> grown %d' % (int(letters.sum()), int(grown.sum())))


def blur(a, r):
    return np.asarray(
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))
    ).astype(np.float32)


# ---- 1. tone: diffuse the surrounding material inward -----------------------
# Repeated blur with the known pixels pinned solves for a smooth fill whose edges
# match the sheet exactly, so no patch seam can show. A clone cannot do this: the
# sheet's lighting falls off across the word.
ring = np.asarray(
    Image.fromarray((grown * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(33))) > 127
ring = ring & ~grown
fill = src.copy()
fill[grown] = src[ring].mean(axis=0)
for radius in (30, 24, 19, 15, 12, 9, 7, 6, 5, 4, 3, 3, 2, 2, 2):
    for _ in range(3):
        b = blur(fill, radius)
        fill[grown] = b[grown]
print('tone diffused')

# ---- 2. texture: borrow the sheet's grain, which tone alone cannot invent ----
BH, BW = 120, 200
donor, best = None, None
for cy in range(0, H - BH, 20):
    for cx in range(0, W - BW, 20):
        if grown[cy:cy + BH, cx:cx + BW].any():
            continue
        pl = lum[cy:cy + BH, cx:cx + BW]
        m, sd = float(pl.mean()), float(pl.std())
        if m < 10 or m > 90 or sd > 26:
            continue                        # skip the void, the bed and hard edges
        if best is None or sd < best:       # flattest patch wins: grain, no structure
            best, donor = sd, (cy, cx)

if donor:
    cy, cx = donor
    grain = src[cy:cy + BH, cx:cx + BW] - blur(src[cy:cy + BH, cx:cx + BW], 7)
    tiled = np.tile(grain, (H // BH + 2, W // BW + 2, 1))[:H, :W]
    fill[grown] += tiled[grown] * 0.8
    print('grain borrowed from plain sheet at', donor)
else:
    print('no clean donor found; tone only')

out = np.clip(np.where(grown[..., None], fill, src), 0, 255)

# Feather the boundary so the join is invisible.
soft = blur(out, 1.4)
edge = np.asarray(
    Image.fromarray((grown * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3.5))
).astype(np.float32) / 255.0
seam = ((edge > 0.05) & (edge < 0.95))[..., None]
out = np.where(seam, soft, out)

# ---- crop to the lettering, with margin -------------------------------------
ys, xs = np.nonzero(grown)
pad = 26
bx0, by0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
bx1, by1 = min(W, xs.max() + pad), min(H, ys.max() + pad)

Image.fromarray(out.astype(np.uint8)).crop((bx0, by0, bx1, by1)).save(OUT)
box = [int(bx0), int(by0), int(bx1 - bx0), int(by1 - by0)]
json.dump({'box': box}, open(META, 'w'))
print('wrote', os.path.relpath(OUT, ROOT), 'box', box)

cmp = Image.new('RGB', ((bx1 - bx0), (by1 - by0) * 2 + 12), (12, 12, 14))
cmp.paste(im.crop((bx0, by0, bx1, by1)), (0, 0))
cmp.paste(Image.fromarray(out.astype(np.uint8)).crop((bx0, by0, bx1, by1)), (0, (by1 - by0) + 12))
cmp.save(os.path.join(ROOT, 'tools', 'verify-blank.png'))
print('wrote tools/verify-blank.png  (top: photograph, bottom: blank stock)')
