/**
 * LaserCuttingAnimation
 * ---------------------
 * A cinematic laser-cutting intro for the hero.
 *
 * The hero is composited from two photographs of the same scene: a clean plate
 * with no machine in it, and the laser assembly cut out of the matching render
 * as an RGBA sprite. The sprite is the thing that travels, so the device really
 * does follow the cut rather than a glow sliding under a fixed head. Because the
 * clean plate carries no baked-in beam light, every bit of heat on the material
 * can travel with the beam.
 *
 * The letters are CREATED by the beam, not traced over. A second derived plate
 * -- the same photograph with the lettering painted out, so it reads as blank
 * stock -- is laid over the hero and erased along the cut path. Ahead of the
 * beam there is only uncut material; behind it the kerf opens; and when a
 * contour closes, that piece is freed and the letter appears. Nothing is ever
 * written back to the photograph: by the end the stock is fully erased, so the
 * hero settles into the untouched original.
 *
 * Five overlays share the plate's own coordinate system (viewBox 0 0 1983 793),
 * so everything stays registered to the letters at any viewport size:
 *
 *   1  stock (normal)  uncut material, masked away as the beam passes
 *   2  kerf  (normal)  the dark cooled cut left behind
 *   3  heat  (screen)  the cooling gradient, masked to what has been cut
 *   4  rig   (normal)  the laser assembly -- an object, so it occludes the plate
 *   5  beam  (screen)  beam, contact flare, light pool, sparks, smoke
 *
 * Screen blending on 3 and 5 is what keeps the light sitting *inside* the
 * photograph: it can only add light, never flatten the image. The rig sits
 * between them because the machine is in front of the material but behind the
 * sparks that fly off it.
 *
 * Usage:  LaserCuttingAnimation.create(document.querySelector('.hero'))
 * Auto-inits on DOMContentLoaded for any [data-laser-hero] element.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var CONFIG = {
    startDelay: 420,        // ms before the head leaves its rest position
    feed: 1750,             // nominal cutting speed, viewBox units / s
    rapid: 3300,            // travel speed between letters
    pierceDwell: 110,       // ms the beam rests on the spot before moving off
    endDwell: 200,          // beat after the last piece is free, before parking
    parkFeed: 500,          // the park move home is slower than a rapid on purpose
    cornerSlowdown: 5.2,    // how hard corners brake the feed
    minFeedRatio: 0.30,     // a corner never brings the head fully to a stop
    sampleStep: 2.2,        // arc-length resolution of the pre-baked path
    heatRadius: 205,        // reach of the cooling gradient behind the head
    coolOutMs: 1500,        // fade of the finished cut, once the run completes
    releaseMs: 150,         // how long a freed piece takes to settle into view
    kerfReveal: 5.2,        // width of material the beam opens, in image units

    standoff: 19,           // gap from nozzle to material, in image units
    travelLift: 15,         // how far the head rises on a travel move
    bobAmp: 0.9,            // machine vibration while cutting
    bobHz: 5.5,
    perspective: 0.8,       // how much of the plate's depth scaling the head takes

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

  // A travel move: an arc the head takes with the beam off, eased in and out so
  // the assembly never teleports between letters.
  function bakeTravel(from, to, speed) {
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
    return { xs: xs, ys: ys, count: count,
             duration: dist / (speed || CONFIG.rapid) + 0.14 };
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
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];
      this.vy[i] += 700 * dt;                    // gravity
      var drag = Math.exp(-3.1 * dt);            // air drag
      this.vx[i] *= drag; this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;

      // Hot white -> amber -> dull red as the particle loses heat.
      var g = Math.round(lerp(238, 96, Math.pow(t, 0.7)));
      var b = Math.round(lerp(196, 26, Math.pow(t, 0.45)));
      n.setAttribute('x1', this.px[i].toFixed(1));
      n.setAttribute('y1', this.py[i].toFixed(1));
      n.setAttribute('x2', this.x[i].toFixed(1));
      n.setAttribute('y2', this.y[i].toFixed(1));
      n.setAttribute('stroke', 'rgb(255,' + g + ',' + b + ')');
      n.setAttribute('stroke-width', (this.size[i] * (1 - t * 0.45)).toFixed(2));
      n.setAttribute('stroke-opacity', ((1 - t) * (1 - t) * 0.95).toFixed(3));
    }
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
    for (var i = 0; i < this.n; i++) {
      if (!this.live[i]) continue;
      this.age[i] += dt;
      var t = this.age[i] / this.life[i];
      var n = this.nodes[i];
      if (t >= 1) { this.live[i] = 0; this.active--; n.setAttribute('opacity', '0'); continue; }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      n.setAttribute('cx', this.x[i].toFixed(1));
      n.setAttribute('cy', this.y[i].toFixed(1));
      n.setAttribute('r', (this.r0[i] * (1 + t * 1.9)).toFixed(1));
      // Rise, spread, and thin out; never dense enough to veil the lettering.
      n.setAttribute('opacity', (Math.sin(Math.min(1, t * 1.6) * Math.PI) * 0.16).toFixed(3));
    }
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
    this.clock = 0;            // seconds of animated time, for the vibration
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

  LaserCuttingAnimation.prototype.layer = function (cls) {
    var svg = el('svg', {
      'class': 'laser-fx ' + cls, viewBox: this.program.viewBox.join(' '),
      preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false'
    });
    this.stage.appendChild(svg);
    return svg;
  };

  LaserCuttingAnimation.prototype.build = function () {
    var u = this.uid;
    var vb = this.program.viewBox;
    var head = this.program.head;
    var mobile = this.mobileQuery.matches;
    var self = this;

    // ---- 1. stock: the material the beam has not reached yet ---------------
    // Everything inside the mask starts white (stock shown). The beam paints
    // black into it, which erases the stock and lets the photograph through.
    // One masked sheet of uncut stock. Splitting it per letter was tried and is
    // markedly worse: fourteen masked <image> layers cost more to composite than
    // the single one costs to re-rasterise.
    this.stock = this.program.stock;
    if (this.stock) {
      this.stockSvg = this.layer('laser-fx--stock');
      var sDefs = el('defs');
      this.stockSvg.appendChild(sDefs);
      var uncut = el('mask', { id: u + '-uncut', maskUnits: 'userSpaceOnUse',
        x: this.stock.box[0], y: this.stock.box[1],
        width: this.stock.box[2], height: this.stock.box[3] });
      uncut.appendChild(el('rect', {
        x: this.stock.box[0], y: this.stock.box[1],
        width: this.stock.box[2], height: this.stock.box[3], fill: '#fff' }));
      this.uncutGroup = el('g', {
        fill: 'none', stroke: '#000', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      uncut.appendChild(this.uncutGroup);
      sDefs.appendChild(uncut);
      var stockImg = el('image', {
        x: this.stock.box[0], y: this.stock.box[1],
        width: this.stock.box[2], height: this.stock.box[3],
        href: this.stock.src, preserveAspectRatio: 'none', mask: 'url(#' + u + '-uncut)' });
      stockImg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', this.stock.src);
      this.stockSvg.appendChild(stockImg);
    }

    // ---- 2. kerf: a cut is a dark line, so it blends normally ---------------
    this.kerfSvg = this.layer('laser-fx--kerf');
    var kerfGroup = el('g', { 'class': 'laser-fx__kerf' });
    this.kerfSvg.appendChild(kerfGroup);

    // ---- 3. heat: masked to what has been cut, coloured by distance from the
    //        beam, so the kerf reads white-hot -> amber -> cooled ------------
    this.heatSvg = this.layer('laser-fx--heat');
    var defs = el('defs');
    this.heatSvg.appendChild(defs);

    var heat = el('radialGradient', {
      id: u + '-heat', gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: CONFIG.heatRadius
    });
    [['0', '#fff7e6', '1'], ['0.03', '#ffd58c', '0.88'], ['0.08', '#ff9527', '0.60'],
     ['0.20', '#e2490c', '0.26'], ['0.45', '#8e2703', '0.09'], ['1', '#2a0700', '0']
    ].forEach(function (s) {
      heat.appendChild(el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }));
    });
    defs.appendChild(heat);
    this.heatGrad = heat;

    // No explicit mask region: it then defaults to the masked rect's own box
    // (+20%), which tracks the beam, instead of being pinned to the whole plate
    // and rasterising 1983x793 of mask every frame.
    var mask = el('mask', { id: u + '-cut' });
    var maskGroup = el('g', {
      fill: 'none', stroke: '#fff', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    mask.appendChild(maskGroup);
    defs.appendChild(mask);

    // Sized to the gradient's reach each frame rather than to the whole plate:
    // a masked, gradient-filled rect is re-rasterised on every change, and at
    // full-frame size that alone costs about a third of the frame budget.
    this.heatLayer = el('rect', {
      x: 0, y: 0, width: 0, height: 0,
      fill: 'url(#' + u + '-heat)', mask: 'url(#' + u + '-cut)'
    });
    this.heatSvg.appendChild(this.heatLayer);

    // ---- 4. rig: the assembly itself, cut from the matching photograph ------
    this.rigSvg = this.layer('laser-fx--rig');
    this.rig = el('g', { 'class': 'laser-fx__rig' });
    this.rigSvg.appendChild(this.rig);
    // A soft shadow under the nozzle so the head is not floating on the plate.
    var rigDefs = el('defs');
    this.rigSvg.appendChild(rigDefs);
    rigDefs.appendChild(radialGrad(u + '-shadow', [
      ['0', '#000', '0.5'], ['0.55', '#000', '0.22'], ['1', '#000', '0']
    ]));
    this.shadow = el('ellipse', { rx: 44, ry: 13, fill: 'url(#' + u + '-shadow)', opacity: '0' });
    this.rigSvg.insertBefore(this.shadow, this.rig);
    this.headImage = el('image', {
      x: 0, y: 0, width: head.box[2], height: head.box[3],
      href: head.src, preserveAspectRatio: 'none'
    });
    // Older WebKit still wants the namespaced form.
    this.headImage.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', head.src);
    this.rig.appendChild(this.headImage);

    // ---- 5. beam and everything hot, in front of the rig --------------------
    this.beamSvg = this.layer('laser-fx--beam');
    var bDefs = el('defs');
    this.beamSvg.appendChild(bDefs);

    function radialGrad(id, stops) {
      var g = el('radialGradient', { id: id });
      stops.forEach(function (s) {
        g.appendChild(el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }));
      });
      return g;
    }
    bDefs.appendChild(radialGrad(u + '-pool', [
      ['0', '#ffdfb2', '0.80'], ['0.22', '#ffa245', '0.44'],
      ['0.55', '#d85a09', '0.17'], ['1', '#000', '0']
    ]));
    bDefs.appendChild(radialGrad(u + '-bloom', [
      ['0', '#ffc071', '0.78'], ['0.3', '#ff8320', '0.30'],
      ['0.65', '#c33a02', '0.09'], ['1', '#000', '0']
    ]));
    bDefs.appendChild(radialGrad(u + '-core', [
      ['0', '#ffffff', '1'], ['0.28', '#fff3c4', '0.98'],
      ['0.55', '#ffb347', '0.55'], ['1', '#ff7a10', '0']
    ]));
    bDefs.appendChild(radialGrad(u + '-smoke', [
      ['0', '#b9b2ab', '0.55'], ['0.5', '#8d8781', '0.22'], ['1', '#6b6663', '0']
    ]));

    var beamGrad = el('linearGradient', { id: u + '-beam', x1: 0, y1: 0, x2: 0, y2: 1 });
    [['0', '#ffb765', '0.05'], ['0.45', '#ffd89a', '0.40'], ['1', '#fffdf4', '0.92']
    ].forEach(function (s) {
      beamGrad.appendChild(el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }));
    });
    bDefs.appendChild(beamGrad);

    // The pool of light the beam throws onto the material, flattened by the
    // plate's perspective. This is what travels with the cut.
    this.pool = el('ellipse', { rx: 62, ry: 21, fill: 'url(#' + u + '-pool)', opacity: '0' });
    this.beamSvg.appendChild(this.pool);

    this.beam = el('g', { opacity: '0' });
    this.beamShaft = el('path', { fill: 'url(#' + u + '-beam)' });
    this.beamHalo = el('path', { fill: 'url(#' + u + '-beam)', opacity: '0.35' });
    this.beam.appendChild(this.beamHalo);
    this.beam.appendChild(this.beamShaft);
    this.beamSvg.appendChild(this.beam);

    var smokeLayer = el('g', { 'class': 'laser-fx__smoke' });
    this.beamSvg.appendChild(smokeLayer);

    this.contact = el('g', { opacity: '0' });
    this.contactBloom = el('circle', { r: 34, fill: 'url(#' + u + '-bloom)' });
    this.contactFlare = el('g', { opacity: '0.62' });
    this.contactFlare.appendChild(el('ellipse', { rx: 31, ry: 0.9, fill: 'url(#' + u + '-core)' }));
    this.contactFlare.appendChild(el('ellipse', { rx: 0.9, ry: 19, fill: 'url(#' + u + '-core)' }));
    this.contactCore = el('circle', { r: 8.2, fill: 'url(#' + u + '-core)' });
    this.contactHot = el('circle', { r: 2.4, fill: '#fffdf6' });
    this.contact.appendChild(this.contactBloom);
    this.contact.appendChild(this.contactFlare);
    this.contact.appendChild(this.contactCore);
    this.contact.appendChild(this.contactHot);
    this.beamSvg.appendChild(this.contact);

    var sparkLayer = el('g', { 'class': 'laser-fx__sparks', fill: 'none' });
    this.beamSvg.appendChild(sparkLayer);

    // ---- the programme: home -> every letter -> home ------------------------
    this.steps = [];
    this.pendingReleases = [];
    var cursor = head.home.slice();
    var homeScale = this.program.homeScale || 1;
    var prevScale = homeScale;

    this.reveals = [];
    var uncutGroup = this.uncutGroup;

    this.program.segments.forEach(function (seg, i) {
      var kerfPath = el('path', { d: seg.d, 'class': 'laser-fx__kerf-line' });
      kerfGroup.appendChild(kerfPath);
      var maskPath = el('path', { d: seg.d });
      maskGroup.appendChild(maskPath);

      // The beam opens this much material as it goes. Erasing the stock here is
      // what makes the kerf appear behind the head instead of the whole letter
      // sitting there from the start.
      var cutPath = null, freePath = null;
      if (uncutGroup) {
        cutPath = el('path', { d: seg.d, stroke: '#000',
          'stroke-width': (CONFIG.kerfReveal * seg.scale).toFixed(2) });
        uncutGroup.appendChild(cutPath);
        if (seg.kind === 'outer') {
          // Closing an outer contour frees the piece: the letter arrives whole.
          freePath = el('path', { d: seg.d, fill: '#000', stroke: 'none', opacity: '0' });
          uncutGroup.appendChild(freePath);
        }
      }

      var baked = bakePath(maskPath, true);
      [kerfPath, maskPath, cutPath].forEach(function (p) {
        if (!p) return;
        p.setAttribute('stroke-dasharray', baked.total + ' ' + (baked.total + 1));
        p.setAttribute('stroke-dashoffset', baked.total);
      });
      maskPath.setAttribute('stroke-width', (4.6 * seg.scale).toFixed(2));
      kerfPath.setAttribute('stroke-width', (2.6 * seg.scale).toFixed(2));

      var start = [baked.xs[0], baked.ys[0]];
      var travel = bakeTravel(cursor, start);
      self.steps.push({
        type: 'travel', baked: travel, duration: travel.duration * 1000,
        fromScale: prevScale, toScale: seg.scale
      });
      prevScale = seg.scale;
      self.steps.push({ type: 'pierce', duration: CONFIG.pierceDwell, at: start, scale: seg.scale });
      var cutStep = {
        type: 'cut', baked: baked, duration: baked.duration * 1000,
        scale: seg.scale, kerfPath: kerfPath, maskPath: maskPath, cutPath: cutPath
      };
      self.steps.push(cutStep);
      if (freePath) self.pendingReleases.push({ node: freePath, step: cutStep, last: -1 });
      cursor = start;                 // a closed loop finishes where it started
    });

    // A beat once the last piece is free: the cut wants a moment to land before
    // the machine moves again. Beam off, head still -- this holds, it does not cut.
    this.steps.push({
      type: 'hold', duration: CONFIG.endDwell, at: cursor.slice(), scale: prevScale
    });

    // Park the head back where the photograph had it, so the hero settles
    // exactly into the still image it started from. Deliberately slower than the
    // rapids between letters: this one is the move the eye is meant to follow,
    // and like every travel step it runs with the beam off, so it reads as
    // repositioning rather than another pass.
    var back = bakeTravel(cursor, head.home, CONFIG.parkFeed);
    this.steps.push({
      type: 'travel', baked: back, duration: back.duration * 1000,
      fromScale: prevScale, toScale: homeScale, parking: true
    });

    var at = 0;
    this.steps.forEach(function (st) { at += st.duration; st.endTime = at; });
    this.totalDuration = at;
    this.releases = this.pendingReleases.map(function (r) {
      return { node: r.node, at: r.step.endTime, last: -1 };
    });
    delete this.pendingReleases;

    var sparkOpts = mobile ? CONFIG.sparksMobile : CONFIG.sparks;
    this.sparks = new SparkPool(sparkLayer, sparkOpts);
    this.smoke = new Smoke(smokeLayer, u + '-smoke', mobile ? CONFIG.smokePuffsMobile : CONFIG.smokePuffs);

    // Rest state: the assembly sits where the photograph had it, beam off.
    this.rest();
    this.root.setAttribute('data-laser-state', 'idle');
  };

  /** Put the assembly back exactly where the photograph had it, beam off. */
  LaserCuttingAnimation.prototype.rest = function () {
    var head = this.program.head;
    this.placeRig(head.home[0], head.home[1], 0, 0, this.program.homeScale || 1);
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
      this.elapsed = -CONFIG.startDelay;      // the beat before the head sets off
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
    this.clock += scaled;

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
    if (this.elapsed < 0) { this.rest(); return; }

    var found = this.locate();
    if (!found) return;
    var step = found.step, local = found.local;
    var x, y, dirX = 1, dirY = 0, cutting = false, intensity = 0, lift = 0;

    if (step.type === 'travel') {
      var b = step.baked;
      var f = easeInOut(local) * (b.count - 1);
      var i0 = Math.min(b.count - 1, f | 0), i1 = Math.min(b.count - 1, i0 + 1);
      var u = f - i0;
      x = lerp(b.xs[i0], b.xs[i1], u);
      y = lerp(b.ys[i0], b.ys[i1], u);
      dirX = b.xs[i1] - b.xs[i0]; dirY = b.ys[i1] - b.ys[i0];
      // The head rises off the material and settles back onto it, growing or
      // shrinking on the way so it matches the depth of where it lands.
      lift = Math.sin(local * Math.PI) * CONFIG.travelLift;
      step.scale = lerp(step.fromScale, step.toScale, easeInOut(local));
    } else if (step.type === 'hold') {
      x = step.at[0]; y = step.at[1];       // cutting, intensity and lift stay 0
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

      // Open exactly as much material as the beam has travelled: the kerf, the
      // heat that follows it, and the stock it removes all share one offset.
      var drawn = (idx + uu) * bk.step;
      var off = Math.max(0, bk.total - drawn);
      step.kerfPath.setAttribute('stroke-dashoffset', off.toFixed(1));
      step.maskPath.setAttribute('stroke-dashoffset', off.toFixed(1));
      if (step.cutPath) step.cutPath.setAttribute('stroke-dashoffset', off.toFixed(1));
    }

    this.releaseFinished();

    var len = Math.hypot(dirX, dirY) || 1;
    dirX /= len; dirY /= len;

    this.placeRig(x, y, lift, intensity, step.scale);

    // Heat follows the beam; everything already cut cools by distance from it.
    var R = CONFIG.heatRadius * step.scale;
    this.heatGrad.setAttribute('cx', x.toFixed(1));
    this.heatGrad.setAttribute('cy', y.toFixed(1));
    this.heatGrad.setAttribute('r', R.toFixed(1));
    // Past r the gradient is fully transparent, so nothing outside this box can
    // paint and there is no reason to rasterise it.
    this.heatLayer.setAttribute('x', (x - R).toFixed(1));
    this.heatLayer.setAttribute('y', (y - R).toFixed(1));
    this.heatLayer.setAttribute('width', (R * 2).toFixed(1));
    this.heatLayer.setAttribute('height', (R * 2).toFixed(1));

    if (cutting && this.rate > 0.02) {
      this.sparks.emitOver(dt, x, y, dirX, dirY, step.scale, intensity * this.rate);
      this.smoke.emitOver(dt, x, y, step.scale, intensity * this.rate);
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
  };

  /**
   * A closed contour means the piece is free, so the letter it outlines stops
   * being uncut stock and becomes part of the photograph. Ramped rather than
   * snapped, so the piece settles into the light instead of blinking on.
   */
  LaserCuttingAnimation.prototype.releaseFinished = function () {
    var r = this.releases;
    if (!r) return;
    for (var i = 0; i < r.length; i++) {
      var t = clamp((this.elapsed - r[i].at) / CONFIG.releaseMs, 0, 1);
      if (t === r[i].last) continue;
      r[i].last = t;
      r[i].node.setAttribute('opacity', t.toFixed(3));
    }
  };

  /**
   * Put the assembly on the plate with its beam exit at (x, y).
   *
   * `lift` raises it off the material on travel moves; `power` (0..1) drives the
   * beam, the light pool and the contact flare, all of which stay at (x, y) --
   * the point being cut -- rather than following the body of the machine.
   */
  LaserCuttingAnimation.prototype.placeRig = function (x, y, lift, power, scale) {
    scale = scale || 1;
    var head = this.program.head;
    var tx = head.tip[0], ty = head.tip[1];

    // The machine stands on the same receding plate as the letters, so it reads
    // smaller up by the L and bigger down at the I. Scaling about the beam exit
    // keeps the nozzle on the cut point whatever the size.
    var rel = scale / (this.program.homeScale || 1);
    var rigScale = 1 + (rel - 1) * CONFIG.perspective;

    // A touch of machine vibration while the beam is actually burning.
    var bob = power > 0.05
      ? Math.sin(this.clock * CONFIG.bobHz * 6.283) * CONFIG.bobAmp * power
      : 0;
    var ry = y - lift + bob;

    this.rig.setAttribute('transform',
      'translate(' + x.toFixed(2) + ' ' + ry.toFixed(2) + ') ' +
      'scale(' + rigScale.toFixed(4) + ') ' +
      'translate(' + (-tx) + ' ' + (-ty) + ')');

    // Shadow sits on the material, so it tracks x/y but not the lift; it only
    // spreads and softens as the head rises.
    var spread = 1 + lift / CONFIG.travelLift * 0.35;
    this.shadow.setAttribute('cx', x.toFixed(1));
    this.shadow.setAttribute('cy', (y + 6 * scale).toFixed(1));
    this.shadow.setAttribute('rx', (44 * scale * spread).toFixed(1));
    this.shadow.setAttribute('ry', (13 * scale * spread).toFixed(1));
    this.shadow.setAttribute('opacity', (0.5 / spread).toFixed(3));

    if (power <= 0.005) {
      this.beam.setAttribute('opacity', '0');
      this.pool.setAttribute('opacity', '0');
      this.contact.setAttribute('opacity', '0');
      return;
    }

    // Beam: a narrow taper from the nozzle down to where it meets the material.
    var gap = (CONFIG.standoff + lift) * scale;
    var top = y - gap;
    var wTop = 1.9 * scale, wBot = 0.75 * scale;
    this.beamShaft.setAttribute('d',
      'M' + (x - wTop) + ' ' + top + 'L' + (x + wTop) + ' ' + top +
      'L' + (x + wBot) + ' ' + y + 'L' + (x - wBot) + ' ' + y + 'Z');
    this.beamHalo.setAttribute('d',
      'M' + (x - wTop * 3.2) + ' ' + top + 'L' + (x + wTop * 3.2) + ' ' + top +
      'L' + (x + wBot * 3) + ' ' + y + 'L' + (x - wBot * 3) + ' ' + y + 'Z');
    this.beam.setAttribute('opacity', power.toFixed(3));

    this.pool.setAttribute('cx', x.toFixed(1));
    this.pool.setAttribute('cy', y.toFixed(1));
    this.pool.setAttribute('rx', (62 * scale).toFixed(1));
    this.pool.setAttribute('ry', (21 * scale).toFixed(1));
    this.pool.setAttribute('opacity', (power * 0.9).toFixed(3));

    this.contact.setAttribute('transform',
      'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + scale.toFixed(3) + ')');
    this.contact.setAttribute('opacity', (0.35 + 0.65 * power).toFixed(3));
  };

  LaserCuttingAnimation.prototype.finish = function () {
    this.state = 'done';
    this.tailT = 0;
    this.root.setAttribute('data-laser-state', 'done');
    // The observer stays connected through the cool-out so scrolling away still
    // parks it; renderTail() drops it once there is nothing left to draw.
  };

  /** After the last letter: the head is home, the beam is off, the kerf cools. */
  LaserCuttingAnimation.prototype.renderTail = function (dt) {
    var t = clamp(this.tailT / (CONFIG.coolOutMs / 1000), 0, 1);
    var fade = 1 - easeInOut(t);
    this.rest();
    this.releaseFinished();
    this.heatLayer.setAttribute('opacity', fade.toFixed(3));
    this.kerfSvg.style.opacity = fade.toFixed(3);
    // Every letter is cut by now, so the stock has nothing left to hide; retiring
    // it also clears the feathered seam around the painted-out lettering, which
    // is what makes the final frame identical to the photograph.
    if (this.stockSvg) this.stockSvg.style.opacity = fade.toFixed(3);
    this.sparks.update(dt);
    this.smoke.update(dt);
    if (t >= 1) {
      this.sparks.clear();
      this.smoke.clear();
      // Nothing can move again: release the observer and let the loop die.
      if (this.io) { this.io.disconnect(); this.io = null; }
    }
  };

  // --- reduced motion ----------------------------------------------------------

  /**
   * With reduced motion the hero is the still photograph: plate plus the
   * assembly at rest. Only the moving layers go away -- pulling the rig too
   * would leave a laser bed with no laser in it.
   */
  LaserCuttingAnimation.prototype.applyReducedMotion = function (on) {
    this.reduced = on;
    if (!on) {
      this.kerfSvg.style.display = '';
      this.heatSvg.style.display = '';
      this.beamSvg.style.display = '';
      if (this.stockSvg) this.stockSvg.style.display = '';
      this.root.setAttribute('data-laser-state', this.state);
      this.sync();
      return;
    }
    this.stop();
    this.sparks.clear();
    this.smoke.clear();
    this.rest();
    this.kerfSvg.style.display = 'none';
    this.heatSvg.style.display = 'none';
    this.beamSvg.style.display = 'none';
    if (this.stockSvg) this.stockSvg.style.display = 'none';
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
    [this.stockSvg, this.kerfSvg, this.heatSvg, this.rigSvg, this.beamSvg].forEach(function (s) {
      if (s && s.parentNode) s.parentNode.removeChild(s);
    });
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
