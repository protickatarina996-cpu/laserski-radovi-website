#!/usr/bin/env python3
"""Rebuild the hero cutting programme from the clean plate.

The lettering is clear acrylic, so it has almost no fill contrast against the
sheet -- only its cut edges catch the light. Detection therefore runs on
brightness of those edges, then groups the resulting fragments into letters by
their position along the text's baseline, which is what keeps "LA" from
collapsing into one shape the way a plain morphological closing does.

Writes assets/js/laser-cut-program.js.

    python3 tools/build-cut-program.py

Needs the head sprite metadata, so run tools/cut-head-sprite.py first.
Requires pillow and numpy.
"""
import json, math, os, sys
from collections import deque
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLATE = os.path.join(ROOT, 'assets', 'img', 'hero-plate.png')
OUT_JS = os.path.join(ROOT, 'assets', 'js', 'laser-cut-program.js')
META = os.path.join(ROOT, 'tools', 'head-meta.json')
BLANK_META = os.path.join(ROOT, 'tools', 'blank-meta.json')

sys.setrecursionlimit(100000)

TEXT = 'LASERSKI RADOVI'
GLYPHS = [c for c in TEXT if c != ' ']
# Enclosed counters each glyph genuinely has, in reading order. A reflection on
# the sheet also traces as a loop, so trust the alphabet, not the area.
COUNTERS = [0, 1, 0, 0, 1, 0, 0, 0,   1, 1, 1, 1, 0, 0]

THRESH = 140
BAND = [(170, 258), (1030, 382), (1845, 560), (1845, 720), (1030, 508), (170, 395)]
BASELINE = (1610.0, 300.0)      # direction the text runs in
GAP = None                      # projected gap between letters; solved for below
CLOSE = 11                      # closes a letter's outline into a solid shape
MIN_COUNTER = 140               # smaller enclosed holes are reflections, not counters
ROD = 61                        # a bright run this tall is the rod's reflection, not a glyph

im = Image.open(PLATE).convert('RGB')
W, H = im.size
src = np.asarray(im).astype(np.float32)
lum = 0.299 * src[:, :, 0] + 0.587 * src[:, :, 1] + 0.114 * src[:, :, 2]

bm = Image.new('L', (W, H), 0)
ImageDraw.Draw(bm).polygon(BAND, fill=255)
band = np.asarray(bm) > 127
bright = (lum > THRESH) & band

# The support rod reflects as a long bright line straight through the sheet and
# touches a letter, so it cannot be dropped later as a separate fragment -- it
# has to go before anything is labelled. Anything belonging to a vertical run
# taller than a glyph is rod, not lettering.
col = bright.copy()
for k in range(1, ROD):
    col[:-k] &= bright[k:]
tall = np.zeros_like(bright)
for k in range(ROD):
    tall[k:] |= col[:H - k] if k else col
rod = np.asarray(
    Image.fromarray((tall * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 127
print('rod pixels found:', int(rod.sum()), '(subtracted per letter, after grouping)')


def label(mask):
    lab = np.zeros((H, W), np.int32)
    cur = 0
    parts = []
    for sy, sx in zip(*np.nonzero(mask)):
        if lab[sy, sx]:
            continue
        cur += 1
        q = deque([(sy, sx)])
        lab[sy, sx] = cur
        px = []
        while q:
            y, x = q.popleft()
            px.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        q.append((ny, nx))
        parts.append((cur, np.array(px)))
    return lab, parts


lab, parts = label(bright)
ux, uy = BASELINE
n = math.hypot(ux, uy)
ux, uy = ux / n, uy / n

frags = []
for cid, px in parts:
    if len(px) < 50:
        continue
    h = px[:, 0].max() - px[:, 0].min()
    w = px[:, 1].max() - px[:, 1].min()
    # A tall sliver is the rod's reflection running through the sheet, not a letter.
    if h > 90 and w < 14:
        continue
    frags.append({'id': cid, 'n': len(px), 'x0': int(px[:, 1].min()), 'x1': int(px[:, 1].max()),
                  's': px[:, 1].mean() * ux + px[:, 0].mean() * uy})
frags.sort(key=lambda f: f['s'])
print('fragments kept:', len(frags))

def split(cut):
    out, cur_g = [], [frags[0]]
    for i in range(len(frags) - 1):
        if frags[i + 1]['s'] - frags[i]['s'] > cut:
            out.append(cur_g)
            cur_g = []
        cur_g.append(frags[i + 1])
    out.append(cur_g)
    return [g for g in out if sum(f['n'] for f in g) > 300]


# Solve for the gap rather than hard-coding it: the right threshold shifts with
# the photograph, and the letter count is the thing actually known.
cuts = [c for c in range(20, 90) if len(split(c)) == len(GLYPHS)]
if not cuts:
    counts = sorted({len(split(c)) for c in range(20, 90)})
    raise SystemExit('no gap gives %d letters for %r (reachable counts: %s) -- retune THRESH'
                     % (len(GLYPHS), TEXT, counts))
GAP = cuts[len(cuts) // 2]      # middle of the stable band, not an edge case
groups = split(GAP)
print('letter groups: %d (gap %d, stable over %d..%d)' % (len(groups), GAP, cuts[0], cuts[-1]))
print('  spans:', ' '.join('%s[%d-%d]' % (GLYPHS[i], min(f['x0'] for f in g), max(f['x1'] for f in g))
                           for i, g in enumerate(groups)))


def mx(m, k):
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(k))) > 127


def mn(m, k):
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(k))) > 127


def enclosed(mask):
    """Regions of background fully surrounded by mask."""
    outside = np.zeros_like(mask)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if not mask[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if not mask[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and not mask[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                q.append((ny, nx))
    return (~mask) & (~outside)


# ---- contour tracing --------------------------------------------------------
NBR = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]


def trace(mask):
    pad = np.zeros((H + 2, W + 2), bool)
    pad[1:-1, 1:-1] = mask
    seen, loops = set(), []
    for sy, sx in sorted(zip(*np.nonzero(pad))):
        if not pad[sy, sx] or pad[sy - 1, sx] or (sy, sx) in seen:
            continue
        loop, cy, cx, bd, start = [], sy, sx, 6, (sy, sx)
        for _ in range(400000):
            loop.append((cx - 1, cy - 1))
            seen.add((cy, cx))
            hit = False
            for k in range(8):
                d = (bd + 1 + k) % 8
                ny, nx = cy + NBR[d][0], cx + NBR[d][1]
                if pad[ny, nx]:
                    bd = (d + 5) % 8
                    cy, cx = ny, nx
                    hit = True
                    break
            if not hit or ((cy, cx) == start and len(loop) > 2):
                break
        if len(loop) > 24:
            loops.append(loop)
    return loops


def area(p):
    return abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1]
                   for i in range(len(p)))) / 2


def smooth(l, w=3, it=2):
    p = list(l)
    for _ in range(it):
        k = len(p)
        p = [(sum(p[(i + j) % k][0] for j in range(-w, w + 1)) / (2 * w + 1),
              sum(p[(i + j) % k][1] for j in range(-w, w + 1)) / (2 * w + 1)) for i in range(k)]
    return p


def rdp_open(pts, eps):
    if len(pts) < 3:
        return pts

    def go(s, e):
        x1, y1 = pts[s]
        x2, y2 = pts[e]
        dx, dy = x2 - x1, y2 - y1
        nn = math.hypot(dx, dy) or 1e-9
        dmax, idx = 0.0, s
        for i in range(s + 1, e):
            x0, y0 = pts[i]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / nn
            if d > dmax:
                dmax, idx = d, i
        return go(s, idx)[:-1] + go(idx, e) if dmax > eps else [pts[s], pts[e]]

    return go(0, len(pts) - 1)


def rdp_loop(pts, eps):
    if len(pts) < 6:
        return pts
    h = len(pts) // 2
    return rdp_open(pts[:h + 1], eps)[:-1] + rdp_open(pts[h:] + [pts[0]], eps)[:-1]


def depth_scale(y):
    """Apparent size at image row y: the sheet recedes up-left, so anything
    standing on it -- letters, sparks, the machine head -- reads smaller there."""
    t = max(0.0, min(1.0, (y - 320.0) / (650.0 - 320.0)))
    return 0.82 + 0.72 * t


contours = []
letter_mask = np.zeros((H, W), bool)     # handed to make-blank-plate.py
for gi, g in enumerate(groups):
    m = np.zeros((H, W), bool)
    for f in g:
        m |= (lab == f['id'])
    m &= ~rod                              # drop the rod's reflection, keep the glyph
    solid = mn(mx(m, CLOSE), CLOSE)
    holes = enclosed(solid)
    hlab, hparts = label(holes)
    counters = sorted([p for _, p in hparts if len(p) >= MIN_COUNTER], key=len, reverse=True)
    counters = counters[:COUNTERS[gi]]
    filled = solid | holes
    for c in counters:                       # punch the real counters back out
        filled[c[:, 0], c[:, 1]] = False

    letter_mask |= (solid | holes)        # the whole glyph, counters included
    loops = [l for l in trace(filled) if area(l) > 150]
    loops.sort(key=lambda l: -area(l))
    keep = [loops[0]] + [l for l in loops[1:] if area(l) > MIN_COUNTER][:COUNTERS[gi]]
    simple = [[[round(float(x), 1), round(float(y), 1)] for x, y in rdp_loop(smooth(l), 1.2)]
              for l in keep]
    contours.append(simple)
    print(f'  {GLYPHS[gi]}: {len(simple)} loop(s), areas {[round(area(l)) for l in keep]}')


# ---- order into a toolpath --------------------------------------------------
def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def wind(loop, cw):
    s = sum((loop[(i + 1) % len(loop)][0] - loop[i][0]) * (loop[(i + 1) % len(loop)][1] + loop[i][1])
            for i in range(len(loop)))
    return loop if (s > 0) == cw else loop[::-1]


def rot(loop, ref):
    i = min(range(len(loop)), key=lambda j: dist(loop[j], ref))
    return loop[i:] + loop[:i]


Image.fromarray((letter_mask * 255).astype(np.uint8)).save(
    os.path.join(ROOT, 'tools', 'letter-mask.png'))
print('wrote tools/letter-mask.png -- %d letter pixels' % int(letter_mask.sum()))

meta = json.load(open(META))
blank = json.load(open(BLANK_META)) if os.path.exists(BLANK_META) else None

segs = []
cursor = list(meta['home'])
total = 0.0
for gi, loops in enumerate(contours):
    ys = [p[1] for p in loops[0]]
    scale = round(depth_scale((min(ys) + max(ys)) / 2), 3)
    ordered = [('inner', wind(l, False)) for l in loops[1:]] + [('outer', wind(loops[0], True))]
    for kind, loop in ordered:
        loop = rot(loop, cursor)
        segs.append({'letter': GLYPHS[gi], 'kind': kind, 'scale': scale,
                     'd': 'M' + 'L'.join(f'{x:.1f} {y:.1f}' for x, y in loop) + 'Z'})
        total += sum(dist(loop[i], loop[(i + 1) % len(loop)]) for i in range(len(loop)))
        cursor = loop[0]

homeScale = round(depth_scale(meta['home'][1]), 3)

L = ['/**',
     ' * Cutting programme for the hero plate (assets/img/hero-plate.png).',
     ' *',
     ' * GENERATED by tools/build-cut-program.py -- do not edit by hand.',
     ' *',
     ' * Contours were traced from the LASERSKI RADOVI letters already cut into the',
     ' * acrylic in the photograph, so the beam follows the real edges. They are',
     ' * invisible guides for the animation; nothing here draws or replaces the',
     ' * lettering.',
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
print('\nwrote %s -- %d segments, %.0f units of cut, homeScale %s'
      % (os.path.relpath(OUT_JS, ROOT), len(segs), total, homeScale))

vis = im.copy()
d = ImageDraw.Draw(vis)
cols = [(255, 80, 60), (60, 220, 255), (255, 220, 60), (140, 255, 120), (255, 120, 255),
        (120, 160, 255), (255, 170, 70)]
for gi, loops in enumerate(contours):
    for l in loops:
        d.line([tuple(p) for p in l] + [tuple(l[0])], fill=cols[gi % len(cols)], width=2)
vis.save(os.path.join(ROOT, 'tools', 'verify-contours.png'))
print('wrote tools/verify-contours.png')
