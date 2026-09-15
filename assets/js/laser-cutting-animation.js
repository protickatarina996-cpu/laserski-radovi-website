/**
 * LaserCuttingAnimation
 * ---------------------
 * A cinematic laser-cutting intro drawn on top of the hero photograph.
 *
 * The photograph is never touched. Everything here lives in two SVG overlays
 * that share the image's own coordinate system (viewBox 0 0 1983 793), so the
 * beam stays registered to the letters at every viewport size:
 *
 *   #1  "kerf"  (normal blending)  -- the dark cooled cut left behind
 *   #2  "glow"  (screen blending)  -- heat, beam, sparks, smoke
 *
 * Screen blending is what keeps the glow sitting *inside* the photograph
 * instead of on top of it: it can only add light, never flatten the image.
 *
 * Usage:  LaserCuttingAnimation.create(document.querySelector('.hero'))
 * Auto-inits on DOMContentLoaded for any [data-laser-hero] element.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var CONFIG = {
    startDelay: 420,        // ms before the first pierce (spec: 300-500ms)
    feed: 1180,              // nominal cutting speed, viewBox units / s
    rapid: 2800,            // travel speed between letters
    pierceDwell: 130,       // ms the beam rests before it starts moving
    cornerSlowdown: 5.2,    // how hard corners brake the feed
    minFeedRatio: 0.30,     // a corner never brings the head fully to a stop
    sampleStep: 2.2,        // arc-length resolution of the pre-baked path
    heatRadius: 205,        // reach of the cooling gradient behind the head
    coolOutMs: 1500,        // fade of the finished cut, once the run completes
    residualCut: 0,         // kerf opacity left behind (0 = pristine photo)
    sparks: { pool: 52, rate: 108, life: [0.26, 0.62], speed: [150, 430] },
    sparksMobile: { pool: 20, rate: 40, life: [0.22, 0.48], speed: [120, 330] },
    smokePuffs: 5,
    smokePuffsMobile: 3
  };

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  function el(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---------------------------------------------------------------------------
  // Path baking
  //
  // getPointAtLength() is exact but far too slow to call every frame, so each
  // segment is sampled once at build time into flat typed arrays. At runtime we
  // only walk a cursor through them, which is O(1) per frame.
  //
  // The same pass measures local curvature, which drives the feed rate: the head
  // brakes into corners and opens up along straights, the way a real CNC does.
  // ---------------------------------------------------------------------------

  function bakePath(pathEl, closed) {
    var total = pathEl.getTotalLength();
    var count = Math.max(2, Math.ceil(total / CONFIG.sampleStep) + 1);
    var step = total / (count - 1);

    var xs = new Float32Array(count);
    var ys = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      var p = pathEl.getPointAtLength(i * step);
      xs[i] = p.x; ys[i] = p.y;
    }

    // Turn angle across a window either side of each sample -> curvature.
    var span = Math.max(2, Math.round(6 / CONFIG.sampleStep) + 2);
    var curve = new Float32Array(count);
    for (i = 0; i < count; i++) {
      var a = closed ? (i - span + count) % count : Math.max(0, i - span);
      var b = closed ? (i + span) % count : Math.min(count - 1, i + span);
      var ax = xs[i] - xs[a], ay = ys[i] - ys[a];
      var bx = xs[b] - xs[i], by = ys[b] - ys[i];
      var la = Math.hypot(ax, ay) || 1e-6, lb = Math.hypot(bx, by) || 1e-6;
      var dot = clamp((ax * bx + ay * by) / (la * lb), -1, 1);
      curve[i] = Math.acos(dot) / Math.PI;      // 0 straight .. 1 hairpin
    }

    // Smooth the curvature so the speed change reads as acceleration rather
    // than a step, and so a single noisy sample cannot jolt the head.
    var smooth = new Float32Array(count);
    var w = Math.max(1, Math.round(9 / CONFIG.sampleStep));
    for (i = 0; i < count; i++) {
      var sum = 0, n = 0;
      for (var k = -w; k <= w; k++) {
        var j = closed ? (i + k + count * 2) % count : clamp(i + k, 0, count - 1);
        sum += curve[j]; n++;
      }
      smooth[i] = sum / n;
    }

    // Integrate 1/speed over arc length -> a time for every sample.
    var times = new Float32Array(count);
    var speeds = new Float32Array(count);
    for (i = 0; i < count; i++) {
      var f = 1 / (1 + CONFIG.cornerSlowdown * smooth[i]);
      speeds[i] = CONFIG.feed * Math.max(CONFIG.minFeedRatio, f);
    }
    for (i = 1; i < count; i++) {
      times[i] = times[i - 1] + step / (0.5 * (speeds[i - 1] + speeds[i]));
    }

    return {
      xs: xs, ys: ys, step: step, count: count, total: total,
      times: times, duration: times[count - 1]
    };
  }

  // A travel move: an arc that lifts away from the material between letters,
  // eased in and out so the head never teleports.
  function bakeTravel(from, to) {
    var dx = to[0] - from[0], dy = to[1] - from[1];
    var dist = Math.hypot(dx, dy) || 1;
    var lift = Math.min(38, dist * 0.30);
    var mid = [(from[0] + to[0]) / 2 - dy / dist * lift,
               (from[1] + to[1]) / 2 + dx / dist * lift];
    var count = Math.max(8, Math.ceil(dist / 3));
    var xs = new Float32Array(count), ys = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      var t = i / (count - 1), u = 1 - t;
      xs[i] = u * u * from[0] + 2 * u * t * mid[0] + t * t * to[0];
      ys[i] = u * u * from[1] + 2 * u * t * mid[1] + t * t * to[1];
    }
    return { xs: xs, ys: ys, count: count, duration: dist / CONFIG.rapid + 0.10 };
  }

  // ---------------------------------------------------------------------------
  // Spark pool -- fixed element count, recycled forever, never touches the DOM
  // after construction.
  // ---------------------------------------------------------------------------

  function SparkPool(layer, opts) {
    this.opts = opts;
    this.nodes = [];
    this.x = new Float32Array(opts.pool);
    this.y = new Float32Array(opts.pool);
    this.px = new Float32Array(opts.pool);
    this.py = new Float32Array(opts.pool);
    this.vx = new Float32Array(opts.pool);
    this.vy = new Float32Array(opts.pool);
    this.age = new Float32Array(opts.pool);
    this.life = new Float32Array(opts.pool);
    this.size = new Float32Array(opts.pool);
    this.live = new Uint8Array(opts.pool);
    this.next = 0;
    this.debt = 0;
    this.active = 0;
    for (var i = 0; i < opts.pool; i++) {
      var n = el('line', { 'stroke-linecap': 'round', 'stroke-opacity': '0', x1: 0, y1: 0, x2: 0, y2: 0 });
      layer.appendChild(n);
      this.nodes.push(n);
    }
  }

  SparkPool.prototype.emit = function (x, y, dirX, dirY, scale, count) {
    var o = this.opts;
    for (var c = 0; c < count; c++) {
      var i = this.next;
      this.next = (this.next + 1) % o.pool;
      // Ejected mostly backwards along the kerf and upwards, with spread.
      var base = Math.atan2(-dirY, -dirX) + rand(-0.95, 0.95);
      var sp = rand(o.speed[0], o.speed[1]) * scale;
      this.x[i] = x + rand(-1.6, 1.6);
      this.y[i] = y + rand(-1.6, 1.6);
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.vx[i] = Math.cos(base) * sp;
      this.vy[i] = Math.sin(base) * sp - rand(40, 150) * scale;
      this.age[i] = 0;
      this.life[i] = rand(o.life[0], o.life[1]);
      this.size[i] = rand(0.8, 2.1) * scale;
      if (!this.live[i]) this.active++;
      this.live[i] = 1;
    }
  };

  SparkPool.prototype.emitOver = function (dt, x, y, dirX, dirY, scale, intensity) {
    this.debt += this.opts.rate * intensity * dt;
    var n = this.debt | 0;
    if (n > 0) { this.debt -= n; this.emit(x, y, dirX, dirY, scale, Math.min(n, 6)); }
  };

  SparkPool.prototype.update = function (dt) {
    var any = false;
    for (var i = 0; i < this.opts.pool; i++) {
      var n = this.nodes[i];
      if (!this.live[i]) continue;
      this.age[i] += dt;
      var t = this.age[i] / this.life[i];
      if (t >= 1) {
        this.live[i] = 0;
        this.active--;
        n.setAttribute('stroke-opacity', '0');
        continue;
      }
      any = true;
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.vy[i] += 700 * dt;                    // gravity
      var drag = Math.exp(-3.1 * dt);            // air drag
      this.vx[i] *= drag; this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;

      // Hot white -> amber -> dull red as the particle loses heat.
      var r = 255;
      var g = Math.round(lerp(238, 96, Math.pow(t, 0.7)));
      var b = Math.round(lerp(196, 26, Math.pow(t, 0.45)));
      n.setAttribute('x1', this.px[i].toFixed(1));
      n.setAttribute('y1', this.py[i].toFixed(1));
      n.setAttribute('x2', this.x[i].toFixed(1));
      n.setAttribute('y2', this.y[i].toFixed(1));
      n.setAttribute('stroke', 'rgb(' + r + ',' + g + ',' + b + ')');
      n.setAttribute('stroke-width', (this.size[i] * (1 - t * 0.45)).toFixed(2));
      n.setAttribute('stroke-opacity', ((1 - t) * (1 - t) * 0.95).toFixed(3));
    }
    return any;
  };

  SparkPool.prototype.clear = function () {
    for (var i = 0; i < this.opts.pool; i++) {
      this.live[i] = 0;
      this.nodes[i].setAttribute('stroke-opacity', '0');
    }
    this.active = 0;
    this.debt = 0;
  };

  // ---------------------------------------------------------------------------
  // Smoke -- a few soft radial-gradient puffs that drift up off the kerf.
  // Gradients rather than a blur filter: same softness, none of the cost.
  // ---------------------------------------------------------------------------

  function Smoke(layer, gradId, count) {
    this.n = count;
    this.nodes = [];
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.r0 = new Float32Array(count);
    this.live = new Uint8Array(count);
    this.cursor = 0;
    this.debt = 0;
    this.active = 0;
    for (var i = 0; i < count; i++) {
      var c = el('circle', { r: 1, fill: 'url(#' + gradId + ')', opacity: '0' });
      layer.appendChild(c);
      this.nodes.push(c);
    }
  }

  Smoke.prototype.emitOver = function (dt, x, y, scale, intensity) {
    this.debt += 7 * intensity * dt;
    if (this.debt < 1) return;
    this.debt -= 1;
    var i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.x[i] = x + rand(-3, 3);
    this.y[i] = y + rand(-2, 2);
    this.vx[i] = rand(-9, 9);
    this.vy[i] = rand(-30, -16);
    this.age[i] = 0;
    this.life[i] = rand(0.7, 1.25);
    this.r0[i] = rand(7, 12) * scale;
    if (!this.live[i]) this.active++;
    this.live[i] = 1;
  };

  Smoke.prototype.update = function (dt) {
    var any = false;
    for (var i = 0; i < this.n; i++) {
      if (!this.live[i]) continue;
      this.age[i] += dt;
      var t = this.age[i] / this.life[i];
      var n = this.nodes[i];
      if (t >= 1) { this.live[i] = 0; this.active--; n.setAttribute('opacity', '0'); continue; }
      any = true;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      n.setAttribute('cx', this.x[i].toFixed(1));
      n.setAttribute('cy', this.y[i].toFixed(1));
      n.setAttribute('r', (this.r0[i] * (1 + t * 1.9)).toFixed(1));
      // Rise, spread, and thin out; never dense enough to veil the lettering.
      n.setAttribute('opacity', (Math.sin(Math.min(1, t * 1.6) * Math.PI) * 0.16).toFixed(3));
    }
    return any;
  };

  Smoke.prototype.clear = function () {
    for (var i = 0; i < this.n; i++) {
      this.live[i] = 0;
      this.nodes[i].setAttribute('opacity', '0');
    }
    this.active = 0;
    this.debt = 0;
  };

  // ---------------------------------------------------------------------------
  // The animation
  // ---------------------------------------------------------------------------

  function LaserCuttingAnimation(root, program) {
    this.root = root;
    this.program = program;
    this.stage = root.querySelector('[data-laser-stage]') || root;
    this.uid = 'lc' + Math.random().toString(36).slice(2, 8);

    this.reduceQuery = global.matchMedia('(prefers-reduced-motion: reduce)');
    this.mobileQuery = global.matchMedia('(max-width: 780px), (pointer: coarse)');

    this.state = 'idle';       // idle | running | done
    this.rate = 0;             // eased 0..1 playback rate, driven by scroll
    this.targetRate = 0;
    this.raf = 0;
    this.lastT = 0;
    this.elapsed = 0;          // ms of programme time consumed
    this.tailT = 0;            // seconds since the run finished
    this.pageHidden = false;

    this.build();
    this.observe();

    if (this.reduceQuery.matches) this.applyReducedMotion(true);

    var self = this;
    this.onMotionChange = function () { self.applyReducedMotion(self.reduceQuery.matches); };
    if (this.reduceQuery.addEventListener) {
      this.reduceQuery.addEventListener('change', this.onMotionChange);
    } else if (this.reduceQuery.addListener) {
      this.reduceQuery.addListener(this.onMotionChange);
    }

    this.onVisibility = function () {
      self.pageHidden = document.hidden;
      if (document.hidden) self.stop(); else self.sync();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  LaserCuttingAnimation.prototype.build = function () {
    var vb = this.program.viewBox.join(' ');
    var u = this.uid;
    var mobile = this.mobileQuery.matches;

    // ---- Layer 1: the kerf. Normal blending, because a cut is a dark line. ---
    var kerfSvg = el('svg', {
      'class': 'laser-fx laser-fx--kerf', viewBox: vb,
      preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false'
    });
    var kerfGroup = el('g', { 'class': 'laser-fx__kerf' });
    kerfSvg.appendChild(kerfGroup);

    // ---- Layer 2: everything luminous. Screen blending, so the light adds
    //      into the photograph rather than covering it. -------------------------
    var glowSvg = el('svg', {
      'class': 'laser-fx laser-fx--glow', viewBox: vb,
      preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false'
    });
    var defs = el('defs');
    glowSvg.appendChild(defs);

    // Heat gradient, anchored to the head in image space. Everything the mask
    // reveals is coloured by distance from the beam, which is what produces
    // "white-hot at the point -> amber -> dull red -> cold" along the kerf.
    var heat = el('radialGradient', {
      id: u + '-heat', gradientUnits: 'userSpaceOnUse',
      cx: 0, cy: 0, r: CONFIG.heatRadius
    });
    [['0', '#fff7e6', '1'], ['0.03', '#ffd58c', '0.88'], ['0.08', '#ff9527', '0.60'],
     ['0.20', '#e2490c', '0.26'], ['0.45', '#8e2703', '0.09'], ['1', '#2a0700', '0']
    ].forEach(function (s) {
      heat.appendChild(el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }));
    });
    defs.appendChild(heat);
    this.heatGrad = heat;

    // The mask that makes the heat appear only where the beam has already been.
    var mask = el('mask', {
      id: u + '-cut', maskUnits: 'userSpaceOnUse',
      x: this.program.viewBox[0], y: this.program.viewBox[1],
      width: this.program.viewBox[2], height: this.program.viewBox[3]
    });
    var maskGroup = el('g', {
      fill: 'none', stroke: '#fff', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    mask.appendChild(maskGroup);
    defs.appendChild(mask);

    // Beam glow + spark + smoke gradients.
    function radial(id, stops) {
      var g = el('radialGradient', { id: id });
      stops.forEach(function (s) {
        g.appendChild(el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }));
      });
      defs.appendChild(g);
    }
    radial(u + '-bloom', [['0', '#ffc071', '0.78'], ['0.3', '#ff8320', '0.30'],
                          ['0.65', '#c33a02', '0.09'], ['1', '#000', '0']]);
    radial(u + '-core', [['0', '#ffffff', '1'], ['0.28', '#fff3c4', '0.98'],
                         ['0.55', '#ffb347', '0.55'], ['1', '#ff7a10', '0']]);
    radial(u + '-smoke', [['0', '#b9b2ab', '0.55'], ['0.5', '#8d8781', '0.22'], ['1', '#6b6663', '0']]);

    var heatLayer = el('rect', {
      x: this.program.viewBox[0], y: this.program.viewBox[1],
      width: this.program.viewBox[2], height: this.program.viewBox[3],
      fill: 'url(#' + u + '-heat)', mask: 'url(#' + u + '-cut)'
    });
    glowSvg.appendChild(heatLayer);
    this.heatLayer = heatLayer;

    var smokeLayer = el('g', { 'class': 'laser-fx__smoke' });
    glowSvg.appendChild(smokeLayer);

    // The head: soft bloom, tight glow, a small cross flare, white core.
    var head = el('g', { 'class': 'laser-fx__head', opacity: '0' });
    this.headBloom = el('circle', { r: 34, fill: 'url(#' + u + '-bloom)' });
    this.headFlare = el('g', { opacity: '0.55' });
    this.headFlare.appendChild(el('ellipse', { rx: 31, ry: 0.9, fill: 'url(#' + u + '-core)' }));
    this.headFlare.appendChild(el('ellipse', { rx: 0.9, ry: 19, fill: 'url(#' + u + '-core)' }));
    this.headCore = el('circle', { r: 8.2, fill: 'url(#' + u + '-core)' });
    this.headHot = el('circle', { r: 2.4, fill: '#fffdf6' });
    head.appendChild(this.headBloom);
    head.appendChild(this.headFlare);
    head.appendChild(this.headCore);
    head.appendChild(this.headHot);
    glowSvg.appendChild(head);
    this.head = head;

    var sparkLayer = el('g', { 'class': 'laser-fx__sparks', fill: 'none' });
    glowSvg.appendChild(sparkLayer);

    this.stage.appendChild(kerfSvg);
    this.stage.appendChild(glowSvg);
    this.kerfSvg = kerfSvg;
    this.glowSvg = glowSvg;

    // ---- Build the programme: cut segments interleaved with travel moves. ----
    this.steps = [];
    var cursor = this.program.leadIn.slice();
    var self = this;

    this.program.segments.forEach(function (seg, i) {
      var kerfPath = el('path', { d: seg.d, 'class': 'laser-fx__kerf-line' });
      kerfGroup.appendChild(kerfPath);
      var maskPath = el('path', { d: seg.d });
      maskGroup.appendChild(maskPath);

      var baked = bakePath(maskPath, true);
      // Hide both paths until the beam reaches them.
      [kerfPath, maskPath].forEach(function (p) {
        p.setAttribute('stroke-dasharray', baked.total + ' ' + (baked.total + 1));
        p.setAttribute('stroke-dashoffset', baked.total);
      });
      maskPath.setAttribute('stroke-width', (4.6 * seg.scale).toFixed(2));
      kerfPath.setAttribute('stroke-width', (2.6 * seg.scale).toFixed(2));

      var start = [baked.xs[0], baked.ys[0]];
      var travel = bakeTravel(cursor, start);
      self.steps.push({
        type: 'travel', baked: travel, duration: travel.duration * 1000, scale: seg.scale
      });
      self.steps.push({ type: 'pierce', duration: CONFIG.pierceDwell, at: start, scale: seg.scale, index: i });
      self.steps.push({
        type: 'cut', baked: baked, duration: baked.duration * 1000,
        scale: seg.scale, kerfPath: kerfPath, maskPath: maskPath, index: i
      });
      cursor = start;                 // a closed loop finishes where it started
    });

    this.totalDuration = this.steps.reduce(function (a, s) { return a + s.duration; }, 0);

    var sparkOpts = mobile ? CONFIG.sparksMobile : CONFIG.sparks;
    this.sparks = new SparkPool(sparkLayer, sparkOpts);
    this.smoke = new Smoke(smokeLayer, u + '-smoke', mobile ? CONFIG.smokePuffsMobile : CONFIG.smokePuffs);

    this.root.setAttribute('data-laser-state', 'idle');
  };

  // --- scroll / visibility -----------------------------------------------------

  LaserCuttingAnimation.prototype.observe = function () {
    var self = this;
    this.ratio = 0;

    if (!('IntersectionObserver' in global)) { this.ratio = 1; this.sync(); return; }

    var steps = [];
    for (var i = 0; i <= 20; i++) steps.push(i / 20);

    this.io = new IntersectionObserver(function (entries) {
      self.ratio = entries[entries.length - 1].intersectionRatio;
      self.sync();
    }, { threshold: steps });
    this.io.observe(this.root);
  };

  /**
   * Map how much of the hero is on screen onto a playback rate.
   *   >= 0.72 visible  -> full speed
   *   0.22 .. 0.72     -> ramps down, so scrolling away eases the head to a stop
   *   <  0.22          -> stopped, rAF cancelled, no particles generated
   */
  LaserCuttingAnimation.prototype.sync = function () {
    if (this.reduced || this.pageHidden) { this.targetRate = 0; this.stop(); return; }

    if (this.state === 'done') {
      this.targetRate = 0;
      // The run is over, but the cut may still be cooling. Let that finish if the
      // hero is on screen; otherwise park it and pick it up on the way back.
      if (this.tailT < CONFIG.coolOutMs / 1000 + 0.6 && this.ratio >= 0.2) this.schedule();
      else this.stop();
      return;
    }

    this.targetRate = clamp((this.ratio - 0.22) / 0.5, 0, 1);

    if (this.ratio < 0.2) {
      // Fully out of the way: kill the loop and the particle systems outright.
      this.rate = 0;
      this.stop();
      this.sparks.clear();
      this.smoke.clear();
      this.head.setAttribute('opacity', '0');
      return;
    }
    if (this.targetRate > 0 || this.rate > 0.001) this.start();
  };

  LaserCuttingAnimation.prototype.schedule = function () {
    if (this.raf || this.pageHidden) return;
    var self = this;
    this.lastT = 0;
    this.raf = requestAnimationFrame(function (t) { self.frame(t); });
  };

  LaserCuttingAnimation.prototype.start = function () {
    if (this.raf || this.state === 'done' || this.reduced) return;
    if (this.state === 'idle') {
      this.state = 'running';
      this.root.setAttribute('data-laser-state', 'running');
      this.elapsed = -CONFIG.startDelay;      // the beat before the first pierce
    }
    this.schedule();
  };

  LaserCuttingAnimation.prototype.stop = function () {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.lastT = 0;
  };

  // --- the loop ----------------------------------------------------------------

  LaserCuttingAnimation.prototype.frame = function (t) {
    var self = this;
    this.raf = 0;

    var dt = this.lastT ? (t - this.lastT) / 1000 : 0;
    this.lastT = t;
    dt = Math.min(dt, 0.05);                  // survive a dropped frame / tab switch

    // Ease the rate rather than snapping it, so slowing down reads as intentional.
    var k = 1 - Math.exp(-dt * 6.5);
    this.rate += (this.targetRate - this.rate) * k;
    if (this.rate < 0.002 && this.targetRate === 0) this.rate = 0;

    var scaled = dt * this.rate;

    if (this.state === 'running') {
      this.elapsed += scaled * 1000;
      if (this.elapsed >= this.totalDuration) {
        this.elapsed = this.totalDuration;
        this.finish();
      }
      this.render(scaled);
    } else if (this.state === 'done') {
      this.tailT += dt;
      this.renderTail(dt);
    }

    // Keep spinning only while there is something left to move: the head still
    // being fed, or particles cooling after it has stopped. targetRate has to be
    // part of this -- the very first frame has dt 0, so rate is still 0 then.
    var busy = this.state === 'running'
      ? (this.targetRate > 0.002 || this.rate > 0.002 ||
         this.sparks.active > 0 || this.smoke.active > 0)
      : this.tailT < CONFIG.coolOutMs / 1000 + 0.6;

    if (busy && !this.pageHidden) {
      this.raf = requestAnimationFrame(function (n) { self.frame(n); });
    } else {
      this.lastT = 0;
    }
  };

  /** Locate the step and the point on it for the current programme time. */
  LaserCuttingAnimation.prototype.locate = function () {
    var acc = 0;
    for (var i = 0; i < this.steps.length; i++) {
      var s = this.steps[i];
      if (this.elapsed < acc + s.duration || i === this.steps.length - 1) {
        return { step: s, local: clamp((this.elapsed - acc) / (s.duration || 1), 0, 1) };
      }
      acc += s.duration;
    }
    return null;
  };

  LaserCuttingAnimation.prototype.render = function (dt) {
    if (this.elapsed < 0) { this.head.setAttribute('opacity', '0'); return; }

    var found = this.locate();
    if (!found) return;
    var step = found.step, local = found.local;
    var x, y, dirX = 1, dirY = 0, cutting = false, intensity = 0;

    if (step.type === 'travel') {
      var b = step.baked;
      var f = easeInOut(local) * (b.count - 1);
      var i0 = Math.min(b.count - 1, f | 0), i1 = Math.min(b.count - 1, i0 + 1);
      var u = f - i0;
      x = lerp(b.xs[i0], b.xs[i1], u);
      y = lerp(b.ys[i0], b.ys[i1], u);
      dirX = b.xs[i1] - b.xs[i0]; dirY = b.ys[i1] - b.ys[i0];
      intensity = 0;
    } else if (step.type === 'pierce') {
      x = step.at[0]; y = step.at[1];
      // Power ramps in, then the pierce blows a small burst of material out.
      intensity = Math.pow(local, 1.6);
      cutting = local > 0.45;
      if (this.rate > 0.05 && !step.burst && local > 0.55) {
        step.burst = true;
        this.sparks.emit(x, y, 0, 1, step.scale, 5);
      }
      if (local < 0.5) step.burst = false;
    } else {
      var bk = step.baked;
      var time = local * bk.duration;
      // times[] is monotonic; walk it with a cached cursor -> O(1) per frame.
      var idx = step.cursor || 0;
      if (time < bk.times[idx]) idx = 0;
      while (idx < bk.count - 1 && bk.times[idx + 1] < time) idx++;
      step.cursor = idx;
      var j = Math.min(bk.count - 1, idx + 1);
      var span = bk.times[j] - bk.times[idx];
      var uu = span > 0 ? (time - bk.times[idx]) / span : 0;
      x = lerp(bk.xs[idx], bk.xs[j], uu);
      y = lerp(bk.ys[idx], bk.ys[j], uu);
      dirX = bk.xs[j] - bk.xs[idx]; dirY = bk.ys[j] - bk.ys[idx];
      cutting = true;
      intensity = 1;

      // Reveal exactly as much of the kerf as the beam has travelled.
      var drawn = (idx + uu) * bk.step;
      var off = Math.max(0, bk.total - drawn);
      step.kerfPath.setAttribute('stroke-dashoffset', off.toFixed(1));
      step.maskPath.setAttribute('stroke-dashoffset', off.toFixed(1));
    }

    var len = Math.hypot(dirX, dirY) || 1;
    dirX /= len; dirY /= len;

    this.placeHead(x, y, step.scale, step.type === 'travel' ? 0.12 : 0.35 + 0.65 * intensity,
                   step.type === 'travel');

    // Heat follows the beam; everything already cut cools by distance from it.
    this.heatGrad.setAttribute('cx', x.toFixed(1));
    this.heatGrad.setAttribute('cy', y.toFixed(1));
    this.heatGrad.setAttribute('r', (CONFIG.heatRadius * step.scale).toFixed(1));

    if (cutting && this.rate > 0.02) {
      this.sparks.emitOver(dt, x, y, dirX, dirY, step.scale, intensity * this.rate);
      this.smoke.emitOver(dt, x, y, step.scale, intensity * this.rate);
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
  };

  LaserCuttingAnimation.prototype.placeHead = function (x, y, scale, opacity, lifted) {
    this.head.setAttribute('transform',
      'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + scale.toFixed(3) + ')');
    this.head.setAttribute('opacity', opacity.toFixed(3));
    // Off the material the beam reads as a dim pilot dot, not a cutting point.
    this.headFlare.setAttribute('opacity', lifted ? '0' : '0.62');
    this.headCore.setAttribute('r', (lifted ? 3.4 : 8.2).toFixed(2));
    this.headBloom.setAttribute('r', (lifted ? 13 : 34).toFixed(1));
  };

  LaserCuttingAnimation.prototype.finish = function () {
    this.state = 'done';
    this.tailT = 0;
    this.root.setAttribute('data-laser-state', 'done');
    // The observer stays connected through the cool-out so scrolling away still
    // parks it; renderTail() drops it once there is nothing left to draw.
  };

  /** After the last letter: the beam shuts off and the kerf cools away. */
  LaserCuttingAnimation.prototype.renderTail = function (dt) {
    var t = clamp(this.tailT / (CONFIG.coolOutMs / 1000), 0, 1);
    var fade = 1 - easeInOut(t);
    this.head.setAttribute('opacity', (fade * 0.5).toFixed(3));
    this.heatLayer.setAttribute('opacity', fade.toFixed(3));
    this.kerfSvg.style.opacity = (CONFIG.residualCut + (1 - CONFIG.residualCut) * fade).toFixed(3);
    this.sparks.update(dt);
    this.smoke.update(dt);
    if (t >= 1) {
      this.sparks.clear();
      this.smoke.clear();
      this.head.setAttribute('opacity', '0');
      // Nothing can move again: release the observer and let the loop die.
      if (this.io) { this.io.disconnect(); this.io = null; }
    }
  };

  // --- reduced motion ----------------------------------------------------------

  LaserCuttingAnimation.prototype.applyReducedMotion = function (on) {
    this.reduced = on;
    if (!on) {
      // The setting can be turned off mid-session; put the overlays back.
      this.kerfSvg.style.display = '';
      this.glowSvg.style.display = '';
      this.root.setAttribute('data-laser-state', this.state);
      this.sync();
      return;
    }
    this.stop();
    this.sparks.clear();
    this.smoke.clear();
    this.kerfSvg.style.display = 'none';
    this.glowSvg.style.display = 'none';
    this.root.setAttribute('data-laser-state', 'reduced');
  };

  LaserCuttingAnimation.prototype.destroy = function () {
    this.stop();
    if (this.io) this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.reduceQuery.removeEventListener) {
      this.reduceQuery.removeEventListener('change', this.onMotionChange);
    } else if (this.reduceQuery.removeListener) {
      this.reduceQuery.removeListener(this.onMotionChange);
    }
    if (this.kerfSvg.parentNode) this.kerfSvg.parentNode.removeChild(this.kerfSvg);
    if (this.glowSvg.parentNode) this.glowSvg.parentNode.removeChild(this.glowSvg);
  };

  var API = {
    config: CONFIG,
    create: function (root, program) {
      program = program || global.LASER_CUT_PROGRAM;
      if (!root || !program) return null;
      return new LaserCuttingAnimation(root, program);
    }
  };

  global.LaserCuttingAnimation = API;

  function autoInit() {
    var hosts = document.querySelectorAll('[data-laser-hero]');
    for (var i = 0; i < hosts.length; i++) API.create(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
