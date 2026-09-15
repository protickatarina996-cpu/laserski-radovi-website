#!/usr/bin/env python3
"""Build the "uncut material" plate: the hero with the letters not yet cut.

The animation needs something to show where a letter has not been reached yet.
This paints each letter out with material borrowed from the sheet around it, so
the laser has blank stock to cut into and the letters can be created by the beam
rather than merely traced.

The original photograph is never written to. This produces a separate asset,
assets/img/hero-blank.png, cropped to the lettering, which the animation lays
over the plate and then erases along the cut path. By the end every letter has
been erased, so the final frame is the untouched photograph again.

    python3 tools/make-blank-plate.py

Writes assets/img/hero-blank.png and tools/blank-meta.json.
Requires pillow and numpy.
"""
import json, os
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
OUT = os.path.join(ROOT, 'assets', 'img', 'hero-blank.png')
META = os.path.join(ROOT, 'tools', 'blank-meta.json')

# Same detection as tools/build-cut-program.py, so the two always agree.
ROI = (300, 793, 600, 1950)          # y0, y1, x0, x1
THRESH = 95
LETTER_IDS = [11, 22, 35, 62, 166, 228, 265, 271]
GROW = 21                            # cover the dark bevel and shadow, not just the face

im = Image.open(PLATE).convert('RGB')
W, H = im.size
src = np.asarray(im).astype(np.float32)
lum = 0.299 * src[:, :, 0] + 0.587 * src[:, :, 1] + 0.114 * src[:, :, 2]

# ---- label the bright components ------------------------------------------
mask = np.zeros((H, W), bool)
y0, y1, x0, x1 = ROI
mask[y0:y1, x0:x1] = lum[y0:y1, x0:x1] > THRESH

lab = np.zeros((H, W), np.int32)
cur = 0
for sy, sx in zip(*np.nonzero(mask)):
    if lab[sy, sx]:
        continue
    cur += 1
    q = deque([(sy, sx)])
    lab[sy, sx] = cur
    while q:
        y, x = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    q.append((ny, nx))

letters = np.isin(lab, LETTER_IDS)
print('letter pixels:', int(letters.sum()))

grown = np.asarray(
    Image.fromarray((letters * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(GROW))
) > 127

out = src.copy()

def blur(a, r):
    return np.asarray(
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))
    ).astype(np.float32)

# ---- 1. tone: diffuse the surrounding material inward -----------------------
# Repeated blur with the known pixels pinned solves for a smooth fill whose
# edges match the sheet exactly, so no patch seam can show. A clone cannot do
# this: the sheet's lighting falls off across the word.
ring = np.asarray(
    Image.fromarray((grown * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(33))
) > 127
ring = ring & ~grown
fill = out.copy()
fill[grown] = src[ring].mean(axis=0)
for radius in (28, 22, 17, 13, 10, 8, 6, 5, 4, 3, 3, 2, 2, 2):
    for _ in range(3):
        b = blur(fill, radius)
        fill[grown] = b[grown]
print('tone diffused')

# ---- 2. texture: borrow the sheet's grain, which tone alone cannot invent ----
# A clean rectangle of plain material, reduced to its high-frequency part.
# Hunt the whole frame for the flattest letter-free rectangle of plain sheet.
BH, BW = 130, 220
donor_box, donor_score = None, None
for cy in range(0, H - BH, 24):
    for cx in range(0, W - BW, 24):
        if grown[cy:cy + BH, cx:cx + BW].any():
            continue
        pl = lum[cy:cy + BH, cx:cx + BW]
        m, sd = float(pl.mean()), float(pl.std())
        if m < 12 or m > 85 or sd > 30:
            continue                       # skip the void, the bed and hard edges
        score = sd                          # flattest patch wins: pure grain, no structure
        if donor_score is None or score < donor_score:
            donor_score, donor_box = score, (cy, cx)

if donor_box:
    cy, cx = donor_box
    donor = src[cy:cy + 140, cx:cx + 240]
    grain = donor - blur(donor, 7)
    th, tw = grain.shape[:2]
    tiled = np.tile(grain, (H // th + 2, W // tw + 2, 1))[:H, :W]
    fill[grown] = fill[grown] + tiled[grown] * 0.85
    print('grain borrowed from plain sheet at', donor_box)
else:
    print('no clean donor found; tone only')

out[grown] = fill[grown]
out = np.clip(out, 0, 255)

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
json.dump({'box': [int(bx0), int(by0), int(bx1 - bx0), int(by1 - by0)]}, open(META, 'w'))
print('wrote', os.path.relpath(OUT, ROOT), 'box', [int(bx0), int(by0), int(bx1 - bx0), int(by1 - by0)])

# Side-by-side check.
cmp = Image.new('RGB', ((bx1 - bx0) * 2 + 16, by1 - by0), (12, 12, 14))
cmp.paste(im.crop((bx0, by0, bx1, by1)), (0, 0))
cmp.paste(Image.fromarray(out.astype(np.uint8)).crop((bx0, by0, bx1, by1)), (bx1 - bx0 + 16, 0))
cmp.save(os.path.join(ROOT, 'tools', 'verify-blank.png'))
print('wrote tools/verify-blank.png  (left: photograph, right: blank stock)')
