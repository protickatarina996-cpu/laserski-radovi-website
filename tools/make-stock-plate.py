#!/usr/bin/env python3
"""Cut the "uncut material" layer out of the blank-sheet photograph.

The animation needs something to show where the beam has not reached yet. That
used to be painted in -- the plate with its lettering diffused away -- which
left faint ghost letters ahead of the beam. It is now a real photograph of the
same scene with a blank sheet, so nothing about the uncut material is invented.

This crops that photograph to the lettering band and feathers the crop's edges,
so the layer covers every glyph without its rectangle ever showing against the
plate underneath.

    python3 tools/build-cut-program.py      # writes tools/letter-mask.png
    python3 tools/make-stock-plate.py
    python3 tools/build-cut-program.py      # picks up the stock entry

Writes assets/img/hero-blank.png and tools/blank-meta.json.
Requires pillow and numpy.
"""
import json, os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'tools', 'hero-blank-source.png')
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
MASK = os.path.join(ROOT, 'tools', 'letter-mask.png')
OUT = os.path.join(ROOT, 'assets', 'img', 'hero-blank.png')
META = os.path.join(ROOT, 'tools', 'blank-meta.json')

GROW = 31       # clearance around each glyph, so the cut's kerf is covered too
PAD = 34        # margin beyond that, giving the feather somewhere to live
FEATHER = 22    # softens the crop's border into the plate

blank = Image.open(SOURCE).convert('RGB')
plate = Image.open(PLATE).convert('RGB')
letters = np.asarray(Image.open(MASK).convert('L')) > 127
H, W = letters.shape

if blank.size[1] != H:
    raise SystemExit('blank sheet is %s but the plate is %s -- they must be the same frame'
                     % (blank.size, plate.size))

grown = np.asarray(
    Image.fromarray((letters * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(GROW))) > 127
ys, xs = np.nonzero(grown)
bx0, by0 = max(0, int(xs.min()) - PAD), max(0, int(ys.min()) - PAD)
bx1, by1 = min(blank.size[0], int(xs.max()) + PAD), min(H, int(ys.max()) + PAD)
box = [bx0, by0, bx1 - bx0, by1 - by0]

crop = blank.crop((bx0, by0, bx1, by1))
bw, bh = crop.size

# How well does the blank agree with the plate away from the lettering? That is
# what decides whether the layer reads as the same material or as a patch.
b = np.asarray(crop).astype(int)
p = np.asarray(plate.crop((bx0, by0, bx1, by1))).astype(int)
sub = grown[by0:by1, bx0:bx1]
d = np.abs(b - p).max(axis=2)
print('agreement off the lettering: mean %.2f, %.2f%% of pixels over 40'
      % (d[~sub].mean(), 100 * (d[~sub] > 40).mean()))

# Feather the border. The glyphs sit at least PAD inside, so nothing that has to
# stay hidden is ever touched by the falloff.
alpha = Image.new('L', (bw, bh), 0)
inner = Image.new('L', (bw - 2 * FEATHER, bh - 2 * FEATHER), 255)
alpha.paste(inner, (FEATHER, FEATHER))
alpha = alpha.filter(ImageFilter.GaussianBlur(FEATHER / 2.2))
out = crop.convert('RGBA')
out.putalpha(alpha)
out.save(OUT)

json.dump({'box': box}, open(META, 'w'))
print('wrote %s  box %s' % (os.path.relpath(OUT, ROOT), box))

cmp = Image.new('RGB', (bw, bh * 2 + 12), (12, 12, 14))
cmp.paste(plate.crop((bx0, by0, bx1, by1)), (0, 0))
cmp.paste(crop, (0, bh + 12))
cmp.save(os.path.join(ROOT, 'tools', 'verify-blank.png'))
print('wrote tools/verify-blank.png  (top: plate with letters, bottom: blank stock)')
