#!/usr/bin/env python3
"""Cut the laser assembly out of the head-bearing render as an RGBA sprite.

The sprite is what travels during the animation, so it has to be real pixels
from the photograph rather than a redraw. Its anchor is the point where the beam
meets the material, which is found here as the brightest pixel under the nozzle.

    python3 tools/cut-head-sprite.py path/to/render-with-head.png

Writes assets/img/laser-head.png and tools/head-meta.json.
Requires pillow and numpy.
"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'tools', 'hero-with-head.png')

# Silhouette, with the cable arm widened a touch for this render.
HEAD = [
    (1228, 0), (1800, 0), (1795, 58), (1745, 132), (1692, 200), (1672, 250),
    (1655, 268), (1625, 302), (1585, 308), (1570, 332), (1566, 398),
    (1540, 400), (1536, 426), (1512, 452), (1478, 476), (1456, 476),
    (1432, 450), (1420, 426), (1404, 424), (1402, 398),
    (1378, 332), (1372, 306), (1334, 300), (1332, 212),
    (1300, 190), (1294, 178), (1230, 172),
]

im = Image.open(SRC).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(float)

# Locate the beam exit precisely: brightest pixel in the small box under the cone.
lum = 0.299*a[:,:,0] + 0.587*a[:,:,1] + 0.114*a[:,:,2]
box = lum[478:515, 1430:1510]
iy, ix = np.unravel_index(np.argmax(box), box.shape)
TIP = (1430 + int(ix), 478 + int(iy))
print('beam exit found at', TIP)

m = Image.new('L', (W, H), 0)
ImageDraw.Draw(m).polygon(HEAD, fill=255)
m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.0))

xs = [p[0] for p in HEAD]; ys = [p[1] for p in HEAD]
pad = 6
bx0, by0 = max(0, min(xs)-pad), max(0, min(ys)-pad)
bx1, by1 = min(W, max(xs)+pad), min(H, max(ys)+pad)

sprite = im.crop((bx0, by0, bx1, by1)).convert('RGBA')
sprite.putalpha(m.crop((bx0, by0, bx1, by1)))
sprite.save(os.path.join(ROOT, 'assets', 'img', 'laser-head.png'))

meta = {'box': [bx0, by0, bx1-bx0, by1-by0], 'tip': [TIP[0]-bx0, TIP[1]-by0], 'home': list(TIP)}
json.dump(meta, open(os.path.join(ROOT, 'tools', 'head-meta.json'), 'w'))
print('sprite', sprite.size, '| tip in sprite', meta['tip'], '| home', meta['home'])

chk = Image.new('RGB', (sprite.width*2+24, sprite.height), (26,92,40))
chk.paste(sprite, (0,0), sprite)
chk.paste(sprite.getchannel('A').convert('RGB'), (sprite.width+24, 0))
d = ImageDraw.Draw(chk); tx, ty = meta['tip']
d.line([(tx-16,ty),(tx+16,ty)], fill=(255,230,0), width=2)
d.line([(tx,ty-16),(tx,ty+16)], fill=(255,230,0), width=2)
chk.save(os.path.join(ROOT, 'tools', 'verify-sprite.png'))
print('wrote tools/verify-sprite.png')
