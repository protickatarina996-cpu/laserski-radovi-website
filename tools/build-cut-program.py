#!/usr/bin/env python3
"""Rebuild the hero cutting programme from the clean plate.

Finds the LASERSKI letters in assets/img/hero-plate.png by brightness, traces
their contours, orders them into a toolpath, and writes
assets/js/laser-cut-program.js.

Run it again if the hero photograph is ever replaced.

    python3 tools/build-cut-program.py

Needs the head sprite metadata, so run tools/cut-head-sprite.py first.
Requires pillow and numpy.
"""
import json, math, sys, os
from collections import deque
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
OUT_JS = os.path.join(ROOT, 'assets', 'js', 'laser-cut-program.js')
META = os.path.join(ROOT, 'tools', 'head-meta.json')
BLANK_META = os.path.join(ROOT, 'tools', 'blank-meta.json')

sys.setrecursionlimit(100000)

# Component ids come out of the labelling pass below; they are reported when the
# script runs so they can be re-pinned if the photograph changes.
LETTERS = [('L',11),('A',22),('S1',35),('E',62),('R',166),('S2',228),('K',265),('I',271)]
# How many enclosed counters each glyph genuinely has. A dark speck on the cut
# face also traces as a closed loop, so trust the alphabet, not the area.
COUNTERS = {'L':0, 'A':1, 'S1':0, 'E':0, 'R':1, 'S2':0, 'K':0, 'I':0}

im = Image.open(PLATE).convert('RGB')
a = np.asarray(im).astype(np.int16)
H, W, _ = a.shape
lum = 0.299*a[:,:,0] + 0.587*a[:,:,1] + 0.114*a[:,:,2]

mask = np.zeros((H, W), bool)
mask[300:793, 600:1950] = lum[300:793, 600:1950] > 95

lab = np.zeros((H, W), np.int32); cur = 0; comps = []
ys, xs = np.nonzero(mask)
for sy, sx in zip(ys, xs):
    if lab[sy, sx]: continue
    cur += 1; q = deque([(sy, sx)]); lab[sy, sx] = cur; px = []
    while q:
        y, x = q.popleft(); px.append((y, x))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y+dy, x+dx
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur; q.append((ny, nx))
    px = np.array(px)
    comps.append((cur, len(px), px[:,1].min(), px[:,1].max(), px[:,0].min(), px[:,0].max()))

comps.sort(key=lambda c: -c[1])
print('--- brightest components (pin these ids in LETTERS if the photo changes) ---')
print(f'{"id":>4} {"area":>7} {"x0":>5} {"x1":>5} {"y0":>5} {"y1":>5}   w    h')
for c in comps[:16]:
    print(f'{c[0]:>4} {c[1]:>7} {c[2]:>5} {c[3]:>5} {c[4]:>5} {c[5]:>5} {c[3]-c[2]:>4} {c[5]-c[4]:>4}')


def dil(x):
    o = np.zeros_like(x)
    for dy in (-1,0,1):
        for dx in (-1,0,1):
            o[max(0,dy):H+min(0,dy), max(0,dx):W+min(0,dx)] |= \
              x[max(0,-dy):H+min(0,-dy), max(0,-dx):W+min(0,-dx)]
    return o
def clean(m): return ~dil(~dil(dil(m)))

NBR = [(-1,0),(-1,1),(0,1),(1,1),(1,0),(1,-1),(0,-1),(-1,-1)]
def trace(mask):
    pad = np.zeros((H+2, W+2), bool); pad[1:-1,1:-1] = mask
    seen, loops = set(), []
    for sy, sx in sorted(zip(*np.nonzero(pad))):
        if not pad[sy,sx] or pad[sy-1,sx] or (sy,sx) in seen: continue
        loop, cy, cx, bd, start = [], sy, sx, 6, (sy,sx)
        for _ in range(200000):
            loop.append((cx-1, cy-1)); seen.add((cy,cx))
            hit = False
            for k in range(8):
                d = (bd+1+k) % 8
                ny, nx = cy+NBR[d][0], cx+NBR[d][1]
                if pad[ny,nx]:
                    bd = (d+5) % 8; cy, cx = ny, nx; hit = True; break
            if not hit or (cy,cx) == start and len(loop) > 2: break
        if len(loop) > 20: loops.append(loop)
    return loops

def area(p):
    return abs(sum(p[i][0]*p[(i+1)%len(p)][1] - p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p))))/2
def smooth(l, w=3, it=2):
    p = list(l)
    for _ in range(it):
        n = len(p)
        p = [(sum(p[(i+k)%n][0] for k in range(-w,w+1))/(2*w+1),
              sum(p[(i+k)%n][1] for k in range(-w,w+1))/(2*w+1)) for i in range(n)]
    return p
def rdp_open(pts, eps):
    if len(pts) < 3: return pts
    def go(s, e):
        x1,y1 = pts[s]; x2,y2 = pts[e]; dx,dy = x2-x1, y2-y1
        n = math.hypot(dx,dy) or 1e-9; dmax, idx = 0.0, s
        for i in range(s+1, e):
            x0,y0 = pts[i]
            d = abs(dy*x0 - dx*y0 + x2*y1 - y2*x1)/n
            if d > dmax: dmax, idx = d, i
        return go(s,idx)[:-1] + go(idx,e) if dmax > eps else [pts[s], pts[e]]
    return go(0, len(pts)-1)
def rdp_loop(pts, eps):
    if len(pts) < 6: return pts
    h = len(pts)//2
    return rdp_open(pts[:h+1], eps)[:-1] + rdp_open(pts[h:]+[pts[0]], eps)[:-1]

contours = {}
for name, cid in LETTERS:
    loops = [l for l in trace(clean(lab == cid)) if area(l) > 120]
    loops.sort(key=lambda l: -area(l))
    # Keep only counters that are real letter openings; a dark speck on the cut
    # face also traces as a loop, but is tiny next to the glyph that holds it.
    kept = [loops[0]] + loops[1:1 + COUNTERS[name]]
    print(' ', name, 'loop areas', [round(area(l)) for l in loops],
          '-> kept', len(kept), 'counters', COUNTERS[name])
    loops = kept
    contours[name] = [[[round(float(x),1), round(float(y),1)] for x,y in rdp_loop(smooth(l), 1.1)]
                      for l in loops]
    print(name, 'loops', [len(s) for s in contours[name]])

# ---- order into a cutting programme -----------------------------------------
def dist(a,b): return math.hypot(a[0]-b[0], a[1]-b[1])
def wind(loop, cw):
    s = sum((loop[(i+1)%len(loop)][0]-loop[i][0])*(loop[(i+1)%len(loop)][1]+loop[i][1])
            for i in range(len(loop)))
    return loop if (s > 0) == cw else loop[::-1]
def rot(loop, ref):
    i = min(range(len(loop)), key=lambda j: dist(loop[j], ref)); return loop[i:]+loop[:i]

def depth_scale(y):
    """Apparent size at image row y. The plate recedes up-left, so anything
    standing on it -- letters, sparks, the machine head -- reads smaller there."""
    t = max(0.0, min(1.0, (y - 358.0) / (670.0 - 358.0)))
    return 0.82 + 0.72 * t

ORDER = [('L','L'),('A','A'),('S1','S'),('E','E'),('R','R'),('S2','S'),('K','K'),('I','I')]
LEAD = [576.0, 286.0]
segs, cur, tot = [], list(LEAD), 0.0
for key, label in ORDER:
    loops = contours[key]
    ys = [p[1] for p in loops[0]]
    scale = round(depth_scale((min(ys)+max(ys))/2), 3)
    for kind, loop in ([('inner', wind(l, False)) for l in loops[1:]] + [('outer', wind(loops[0], True))]):
        loop = rot(loop, cur)
        d = 'M' + 'L'.join(f'{x:.1f} {y:.1f}' for x, y in loop) + 'Z'
        segs.append({'letter': label, 'kind': kind, 'scale': scale, 'd': d})
        tot += sum(dist(loop[i], loop[(i+1)%len(loop)]) for i in range(len(loop)))
        cur = loop[0]

import json as _j
meta = _j.load(open(META))

print('scale at head home:', round(depth_scale(meta['home'][1]), 3))
print(f'\n{len(segs)} segments, total cut length {tot:.0f}')

# verification overlay
im = Image.open(PLATE).convert('RGB'); d = ImageDraw.Draw(im)
cols = [(0,255,0),(0,200,255),(255,0,255),(255,255,0),(255,80,0),(0,255,180),(255,0,80),(120,120,255)]
for i,(key,_) in enumerate(ORDER):
    for l in contours[key]:
        d.line([tuple(p) for p in l]+[tuple(l[0])], fill=cols[i], width=2)
im.save(os.path.join(ROOT, 'tools', 'verify-contours.png'))
print('wrote tools/verify-contours.png')


# ---- emit the JavaScript -----------------------------------------------------
homeScale = round(depth_scale(meta['home'][1]), 3)
blank = _j.load(open(BLANK_META)) if os.path.exists(BLANK_META) else None
L = ['/**',
 ' * Cutting programme for the hero plate (assets/img/hero-plate.png).',
 ' *',
 ' * GENERATED by tools/build-cut-program.py -- do not edit by hand.',
 ' *',
 ' * Contours were traced from the LASERSKI letters already cut into the material',
 ' * in the photograph, so the beam follows the real edges. They are invisible',
 ' * guides for the animation; nothing here draws or replaces the lettering.',
 ' *',
 " * Coordinates are the image's own pixel space and are used verbatim as the SVG",
 ' * viewBox, so the overlays scale with the plate at any viewport size.',
 ' *',
 ' * head.box    where the sprite sits at rest, [x, y, w, h] in image space',
 ' * head.tip    the beam/material contact point inside the sprite -- the anchor',
 ' *             that gets placed on the current cut point',
 ' * head.home   where the assembly rests before and after the run',
 ' * stock       the uncut-material plate laid over the photograph and erased',
 ' *             along the cut path, so letters are created by the beam rather',
 ' *             than merely traced; box is [x, y, w, h] in image space',
 ' * homeScale   apparent size at the home row; dividing a segment scale by this',
 ' *             gives how much bigger or smaller the head reads once it has',
 ' *             travelled to that letter',
 ' *',
 ' * segment.kind   "inner" = a letter counter (cut first, as a real CNC would)',
 " * segment.scale  apparent size from the plate's perspective depth",
 ' */',
 'window.LASER_CUT_PROGRAM = {',
 '  viewBox: [0, 0, %d, %d],' % (W, H),
 '  homeScale: %s,' % homeScale,
 '  head: {',
 '    src: "assets/img/laser-head.png",',
 '    box: [%s],' % ', '.join(map(str, meta['box'])),
 '    tip: [%s],' % ', '.join(map(str, meta['tip'])),
 '    home: [%s]' % ', '.join(map(str, meta['home'])),
 '  },']
if blank:
    L += ['  stock: { src: "assets/img/hero-blank.png", box: [%s] },'
          % ', '.join(map(str, blank['box']))]
L += ['  segments: [']
for s in segs:
    L += ['    {',
          '      letter: %s, kind: %s, scale: %s,' % (json.dumps(s['letter']), json.dumps(s['kind']), s['scale']),
          '      d: %s' % json.dumps(s['d']),
          '    },']
L += ['  ]', '};']
open(OUT_JS, 'w').write('\n'.join(L) + '\n')
print('wrote', os.path.relpath(OUT_JS, ROOT), '--', len(segs), 'segments, homeScale', homeScale)
