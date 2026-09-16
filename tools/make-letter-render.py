#!/usr/bin/env python3
"""Grade the cut letters so they read against the dark bed.

The lettering in the hero photograph is clear acrylic on a black machine bed:
the glyph faces transmit most of what is behind them, so at hero size the word
is barely legible. There is no 3D scene here and no material to re-shade -- the
letters are pixels in a photograph -- so the fix is a grade applied to the glyph
faces alone: the photograph's own pixels, lifted in contrast and given back the
polished rim a real laser cut leaves.

Every pixel outside the glyph silhouettes is copied through untouched, so the
bed, the honeycomb, the sheet and all of the plate's reflections are exactly as
photographed. hero-plate.png itself is never written to: it stays the untouched
original the contours are traced from, and this writes a separate file that is
what the page actually displays.

    python3 tools/build-cut-program.py      # writes tools/letter-mask.png
    python3 tools/make-letter-render.py     # writes assets/img/hero-lit.png

Requires pillow and numpy.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
MASK = os.path.join(ROOT, 'tools', 'letter-mask.png')
OUT = os.path.join(ROOT, 'assets', 'img', 'hero-lit.png')

# --- the grade -------------------------------------------------------------
# Contrast about the faces' own median, so the glass keeps its internal
# reflections instead of flattening into a fill.
GAIN = 1.70
# A floor under the darkest faces: the ambient a real sheet picks up whatever
# shows through it. This is what stops a stroke dissolving into the bed.
LIFT = 14.0
# A weak, cool surface sheen -- the few per cent a polished face reflects
# straight back. Kept low: past about 0.15 the letters start reading as painted.
SHEEN = 0.09
SHEEN_RGB = (186.0, 194.0, 206.0)
# The cut edge. A laser leaves the rim polished, so it catches light the face
# does not. Confined to the inside of the contour, so it separates the letter
# from the bed without putting anything on the bed.
EDGE = 78.0
EDGE_PX = 3.8
EDGE_FALLOFF = 1.6

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)

plate = np.asarray(Image.open(PLATE).convert('RGB')).astype(np.float32)
mask_img = Image.open(MASK).convert('L')
alpha = np.asarray(mask_img).astype(np.float32) / 255.0
H, W = alpha.shape
if plate.shape[:2] != (H, W):
    raise SystemExit('mask is %dx%d but the plate is %dx%d'
                     % (W, H, plate.shape[1], plate.shape[0]))

# Distance inward from the contour, by repeated erosion -- enough for EDGE_PX.
dist = np.zeros((H, W), np.float32)
cur = mask_img
for _ in range(int(EDGE_PX) + 2):
    cur = cur.filter(ImageFilter.MinFilter(3))
    dist += (np.asarray(cur) > 127).astype(np.float32)

face = alpha > 0.5
pivot = float(np.median((plate @ LUMA)[face]))

lit = (plate - pivot) * GAIN + pivot + LIFT
lit = lit * (1.0 - SHEEN) + np.array(SHEEN_RGB, np.float32) * SHEEN
rim = np.clip(1.0 - dist / EDGE_PX, 0.0, 1.0) ** EDGE_FALLOFF
lit = np.clip(lit + (rim * EDGE)[..., None], 0.0, 255.0)

a = alpha[..., None]
out = np.clip(plate * (1.0 - a) + lit * a, 0.0, 255.0).astype(np.uint8)
Image.fromarray(out, 'RGB').save(OUT)

# The only thing that must hold: nothing outside a glyph moved.
off = np.abs(out.astype(int) - plate.astype(int)).max(axis=2)[alpha <= 0.0]
print('pixels outside the glyphs changed: %d (max channel diff %d)'
      % (int((off > 0).sum()), int(off.max()) if off.size else 0))

grown = np.asarray(mask_img.filter(ImageFilter.MaxFilter(41))) > 127
before, after = (plate @ LUMA)[face], (out.astype(np.float32) @ LUMA)[face]
bed = (plate @ LUMA)[grown & ~face]
print('faces  %.1f -> %.1f      bed  %.1f (unchanged)' % (before.mean(), after.mean(), bed.mean()))
print('face-to-bed separation  %.1f -> %.1f' % (before.mean() - bed.mean(), after.mean() - bed.mean()))
print('wrote %s' % os.path.relpath(OUT, ROOT))

ys, xs = np.nonzero(face)
band = (max(0, int(xs.min()) - 20), max(0, int(ys.min()) - 20),
        min(W, int(xs.max()) + 20), min(H, int(ys.max()) + 20))
bw, bh = band[2] - band[0], band[3] - band[1]
cmp_img = Image.new('RGB', (bw, 2 * bh + 12), (12, 12, 14))
cmp_img.paste(Image.open(PLATE).convert('RGB').crop(band), (0, 0))
cmp_img.paste(Image.fromarray(out).crop(band), (0, bh + 12))
cmp_img.save(os.path.join(ROOT, 'tools', 'verify-letters.png'))
print('wrote tools/verify-letters.png  (top: as photographed, bottom: graded)')
