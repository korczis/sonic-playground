// The visualiser's 2D modes: ten original pictures on p5, each an homage to one Winamp-era
// visualisation (data/visualizer.json names them, credits the original and lists the live
// parameters). static/js/visualizer.js loads this file with p5, creates the p5 instance (HSB,
// pixel density, frame rate) and calls window.SonicViz2D[mode](p, a, s) once per frame:
//   a  the frame's analysis of the sound (SonicVizAnalysis, types/sonic.d.ts): bands, wave,
//      kick/snare/hat envelopes, beat, flux, centroid, energy, phase. In clock mode the host
//      synthesises it; a mode only ever consumes it.
//   s  the mode's own scratch, fresh at every mode change and resize: s.t is the mode's age in
//      seconds, s.params every parameter at its current value (read live, every frame).
// Audio influence scales with params.react (0: calm motion only); params.hue turns the palette.
// The heavy loops draw on the canvas context directly, batched into a few paths per frame, with
// no allocations per element: the budget is about 4 ms a frame on a mid phone at 390x844.
// Every picture is composed around min(width, height), so a phone held upright frames it too.
(function () {
  'use strict';
  var TAU = Math.PI * 2;
  var SX = 0, SY = 0; // the point a shape function returns, without allocating one

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smooth(x) { return x * x * (3 - 2 * x); }
  /** A CSS colour from hue (degrees, any range), saturation and lightness (%), alpha. */
  function hsla(h, sat, light, alpha) {
    return 'hsla(' + ((h % 360 + 360) % 360).toFixed(1) + ',' + sat + '%,' + light + '%,'
      + clamp(alpha, 0, 1).toFixed(3) + ')';
  }
  /** The spectrum at a fraction f (0 bass .. 1 treble), interpolated between bands. */
  function bandAt(a, f) {
    var n = a.bands.length;
    var x = clamp(f, 0, 1) * (n - 1);
    var i = Math.floor(x);
    var j = Math.min(n - 1, i + 1);
    return a.bands[i] + (a.bands[j] - a.bands[i]) * (x - i);
  }
  function fade(g, w, h, alpha) {
    g.fillStyle = 'rgba(0,0,0,' + alpha + ')';
    g.fillRect(0, 0, w, h);
  }
  function bg(g, w, h, css) {
    g.fillStyle = css;
    g.fillRect(0, 0, w, h);
  }
  // MilkDrop's feedback: the last frame, copied aside, drawn back zoomed and turned over black,
  // at `keep` opacity. A copy (not the canvas onto itself) keeps the trails clean.
  function feedback(p, g, s, zoom, turn, keep) {
    var c = p.canvas;
    if (!s.buf || s.buf.width !== c.width || s.buf.height !== c.height) {
      s.buf = document.createElement('canvas');
      s.buf.width = c.width;
      s.buf.height = c.height;
      s.bufg = s.buf.getContext('2d');
    }
    s.bufg.globalCompositeOperation = 'copy';
    s.bufg.drawImage(c, 0, 0);
    var w = p.width, h = p.height;
    bg(g, w, h, '#000');
    g.save();
    g.globalAlpha = keep;
    g.translate(w / 2, h / 2);
    g.rotate(turn);
    g.scale(zoom, zoom);
    g.drawImage(s.buf, -w / 2, -h / 2, w, h);
    g.restore();
  }
  // Every mode draws inside save/restore, so no composite, shadow or alpha leaks to the next.
  function mode(fn) {
    return function (p, a, s) {
      var g = p.drawingContext;
      g.save();
      try { fn(p, g, a, s, s.params); } finally { g.restore(); }
    };
  }

  // The shapes the flux ribbons morph between, as functions of u (0..1) around the loop.
  var SHAPES = 5;
  function shape(k, u, t) {
    var ang = u * TAU;
    if (k === 0) { SX = Math.cos(ang); SY = Math.sin(ang); return; }
    if (k === 1) { SX = Math.sin(3 * ang + t * 0.3); SY = Math.sin(2 * ang); return; }
    if (k === 2) {
      var r = 0.62 + 0.38 * Math.cos(5 * ang);
      SX = r * Math.cos(ang); SY = r * Math.sin(ang); return;
    }
    if (k === 3) { SX = Math.sin(ang); SY = Math.sin(2 * ang) * 0.7; return; }
    SX = (Math.sin(ang) + 2 * Math.sin(2 * ang)) / 3;
    SY = (Math.cos(ang) - 2 * Math.cos(2 * ang)) / 3;
  }

  window.SonicViz2D = {
    // Flux (after G-Force): ribbons of the waveform that morph from shape to shape, in a
    // zooming, turning feedback; trails is how long the past stays, warp how hard it turns.
    flux: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react, t = s.t;
      if (!s.dir) s.dir = 1;
      if (a.beat && R > 0 && (s.beats = (s.beats || 0) + 1) % 8 === 0) s.dir = -s.dir;
      feedback(p, g, s, 1 + q.warp * (0.01 + a.bass * 0.03 * R),
        s.dir * q.warp * (0.004 + a.mid * 0.012 * R), 0.4 + q.trails * 0.45);
      var k = t / 7;
      var i0 = Math.floor(k) % SHAPES, i1 = (i0 + 1) % SHAPES;
      var mix = smooth(clamp((k - Math.floor(k) - 0.55) / 0.45, 0, 1));
      var unit = Math.max(1, m / 520);
      g.globalCompositeOperation = 'lighter';
      g.lineJoin = 'round';
      g.translate(w / 2, h / 2);
      var N = 160;
      for (var r = 0; r < 3; r++) {
        var size = m * (0.2 + r * 0.06) * (1 + a.level * 0.25 * R);
        var turn = t * 0.25 * (r % 2 ? -1 : 1) + r;
        var ct = Math.cos(turn), st = Math.sin(turn);
        g.beginPath();
        for (var j = 0; j <= N; j++) {
          var u = j / N;
          shape(i0, u, t); var x0 = SX, y0 = SY;
          shape(i1, u, t);
          var x = x0 + (SX - x0) * mix, y = y0 + (SY - y0) * mix;
          var d = 1 + a.wave[(j * 3 + r * 40) % a.wave.length] * 0.32 * R;
          var px = x * size * d, py = y * size * d;
          var rx = px * ct - py * st, ry = px * st + py * ct;
          if (j === 0) g.moveTo(rx, ry); else g.lineTo(rx, ry);
        }
        var col = hsla(q.hue + 195 + r * 55 + t * 14 + a.centroid * 90 * R, 92, 58, 0.62);
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 8 * unit;
        g.lineWidth = (1.2 + a.kick * 3 * R) * unit;
        g.stroke();
      }
    }),

    // Signal tower (after Winamp's own analyser): the green-yellow-red bars with falling peak
    // caps, now with a glow, a reflection on a dark floor and an oscilloscope above them.
    tower: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, R = q.react, glow = q.glow;
      var n = Math.round(clamp(24 + (q.detail - 0.25) / 1.75 * 72, 24, 96));
      if (!s.peaks || s.peaks.length !== n) {
        s.peaks = new Float32Array(n); s.vals = new Float32Array(n); s.hold = new Float32Array(n);
      }
      var portrait = h > w;
      var floor = h * (portrait ? 0.66 : 0.72);
      var top = h * (portrait ? 0.38 : 0.54);
      var pad = Math.max(10, w * 0.05);
      if (!s.grad) {
        s.back = g.createLinearGradient(0, 0, 0, h);
        s.back.addColorStop(0, '#04050c');
        s.back.addColorStop(1, '#0a1022');
        s.grad = g.createLinearGradient(0, floor, 0, floor - top);
        s.grad.addColorStop(0, '#16d35f');
        s.grad.addColorStop(0.55, '#facc15');
        s.grad.addColorStop(1, '#f43f5e');
        s.mirror = g.createLinearGradient(0, floor, 0, floor + top * 0.4);
        s.mirror.addColorStop(0, 'rgba(34,197,94,0.32)');
        s.mirror.addColorStop(1, 'rgba(34,197,94,0)');
      }
      bg(g, w, h, s.back);
      var gap = Math.max(1, (w - pad * 2) / n * 0.24);
      var bw = (w - pad * 2 - gap * (n - 1)) / n;
      var calm = 1 - Math.min(1, R);
      var dt = a.dt || 1 / 60;
      for (var i = 0; i < n; i++) {
        var f = i / (n - 1);
        var idle = 0.12 + 0.08 * Math.sin(s.t * 1.4 + i * 0.35);
        var v = clamp(bandAt(a, f) * R * (0.85 + 0.35 * f) + calm * idle, 0, 1);
        s.vals[i] = v > s.vals[i] ? v : s.vals[i] * 0.86 + v * 0.14;
        if (s.vals[i] >= s.peaks[i]) { s.peaks[i] = s.vals[i]; s.hold[i] = 0.35; }
        else if (s.hold[i] > 0) s.hold[i] -= dt;
        else s.peaks[i] = Math.max(0, s.peaks[i] - dt * 0.45);
      }
      // The bars, one path: the glow is computed once for all of them.
      g.beginPath();
      for (var b = 0; b < n; b++) {
        var bh = Math.max(2, s.vals[b] * top);
        g.rect(pad + b * (bw + gap), floor - bh, bw, bh);
      }
      g.fillStyle = s.grad;
      g.shadowColor = 'rgba(74,222,128,0.6)';
      g.shadowBlur = 14 * glow;
      g.fill();
      g.shadowBlur = 0;
      // The segments of an LED column, cut across the bars.
      g.fillStyle = 'rgba(4,5,12,0.5)';
      var step = Math.max(3, top / 40);
      for (var y = floor - step; y > floor - top; y -= step) g.fillRect(pad, y, w - pad * 2, 1);
      // The reflection.
      g.beginPath();
      for (var c = 0; c < n; c++) {
        g.rect(pad + c * (bw + gap), floor + 4, bw, s.vals[c] * top * 0.4);
      }
      g.fillStyle = s.mirror;
      g.fill();
      // The peak caps.
      g.beginPath();
      for (var k = 0; k < n; k++) g.rect(pad + k * (bw + gap), floor - s.peaks[k] * top - 4, bw, 2);
      g.fillStyle = '#f1f5f9';
      g.shadowColor = 'rgba(241,245,249,0.8)';
      g.shadowBlur = 8 * glow;
      g.fill();
      // The floor and the oscilloscope.
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(148,163,184,0.25)';
      g.fillRect(pad, floor + 1, w - pad * 2, 1);
      var y0 = h * (portrait ? 0.16 : 0.12), amp = h * 0.07 * (0.35 + 0.65 * Math.min(R, 1.5));
      g.beginPath();
      var len = a.wave.length;
      for (var j = 0; j < len; j++) {
        var x = pad + (w - pad * 2) * j / (len - 1);
        var yy = y0 + a.wave[j] * amp;
        if (j === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.strokeStyle = 'rgba(103,232,249,0.9)';
      g.shadowColor = 'rgba(103,232,249,0.8)';
      g.shadowBlur = 10 * glow;
      g.lineWidth = 1.5;
      g.stroke();
    }),

    // Pocket (after Tiny Fullscreen): a dot-matrix of LEDs, the spectrum lit column by column,
    // with a peak dot on each and a thin scope under them. Detail is the number of columns.
    pocket: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, R = q.react;
      var cols = Math.round(clamp(10 + q.detail * 18, 14, 46));
      var rows = h > w ? 18 : 14;
      if (!s.vals || s.vals.length !== cols) {
        s.vals = new Float32Array(cols);
        s.peaks = new Float32Array(cols);
      }
      bg(g, w, h, '#020206');
      var pitch = Math.min(w * 0.88 / cols, h * 0.52 / rows);
      var r = pitch * 0.34;
      var x0 = (w - pitch * (cols - 1)) / 2, y0 = (h + pitch * (rows - 1)) / 2 - h * 0.04;
      var calm = 1 - Math.min(1, R);
      for (var c = 0; c < cols; c++) {
        var v = clamp(bandAt(a, c / (cols - 1)) * R * 1.1
          + calm * (0.2 + 0.12 * Math.sin(s.t * 1.1 + c * 0.5)), 0, 1);
        s.vals[c] = v > s.vals[c] ? v : s.vals[c] * 0.82 + v * 0.18;
        s.peaks[c] = Math.max(s.vals[c], s.peaks[c] - (a.dt || 1 / 60) * 0.35);
      }
      // Unlit dots, one path.
      g.beginPath();
      for (var cc = 0; cc < cols; cc++) {
        var lit = Math.round(s.vals[cc] * rows);
        for (var rr = lit; rr < rows; rr++) {
          var ux = x0 + cc * pitch, uy = y0 - rr * pitch;
          g.moveTo(ux + r, uy); g.arc(ux, uy, r, 0, TAU);
        }
      }
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fill();
      // Lit dots, one path per row (one colour each).
      g.shadowBlur = pitch * 0.6;
      for (var row = 0; row < rows; row++) {
        g.beginPath();
        var any = false;
        for (var c2 = 0; c2 < cols; c2++) {
          if (Math.round(s.vals[c2] * rows) <= row) continue;
          var lx = x0 + c2 * pitch, ly = y0 - row * pitch;
          g.moveTo(lx + r, ly); g.arc(lx, ly, r, 0, TAU);
          any = true;
        }
        if (!any) continue;
        var col = hsla(q.hue + 168 + row / rows * 130, 90, 58 + row / rows * 10, 0.95);
        g.fillStyle = col;
        g.shadowColor = col;
        g.fill();
      }
      g.beginPath();
      for (var c3 = 0; c3 < cols; c3++) {
        var py = y0 - Math.min(rows - 1, Math.round(s.peaks[c3] * rows)) * pitch;
        var px = x0 + c3 * pitch;
        g.moveTo(px + r * 0.7, py); g.arc(px, py, r * 0.7, 0, TAU);
      }
      g.fillStyle = 'rgba(248,250,252,0.85)';
      g.shadowColor = 'rgba(248,250,252,0.6)';
      g.fill();
      g.shadowBlur = 0;
      // The scope.
      var sy = y0 + pitch * 2.2, sw = pitch * (cols - 1), len = a.wave.length;
      g.beginPath();
      for (var j = 0; j < len; j++) {
        var x = x0 + sw * j / (len - 1);
        var y = sy + a.wave[j] * pitch * 1.4 * (0.4 + 0.6 * Math.min(R, 1.5));
        if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = hsla(q.hue + 190, 80, 70, 0.7);
      g.lineWidth = 1;
      g.stroke();
    }),

    // Kaleido (after Tuggummi): a flower of the spectrum mirrored into `symmetry` sectors,
    // turning slowly, its heart breathing with the kick.
    kaleido: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react;
      var sym = Math.round(clamp(q.symmetry, 2, 12));
      var B = a.bands.length;
      fade(g, w, h, 0.2);
      g.translate(w / 2, h / 2);
      g.rotate(s.t * 0.12 * q.speed);
      g.globalCompositeOperation = 'lighter';
      var base = m * 0.07 * (1 + a.kick * 0.35 * R);
      var reach = m * 0.42;
      var sector = TAU / sym;
      var unit = Math.max(1, m / 600);
      var calm = 1 - Math.min(1, R);
      // The heart.
      var heart = g.createRadialGradient(0, 0, 0, 0, 0, base * 2.2);
      heart.addColorStop(0, hsla(q.hue + 300 + s.t * 20, 95, 70, 0.25 + a.kick * 0.5 * R));
      heart.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = heart;
      g.fillRect(-base * 2.2, -base * 2.2, base * 4.4, base * 4.4);
      // The rays, one stroke per band across every sector.
      for (var i = 0; i < B; i += 2) {
        var v = clamp(a.bands[i] * R + calm * (0.25 + 0.2 * Math.sin(s.t * 0.9 + i * 0.3)), 0, 1);
        var off = (i / B) * sector / 2;
        var r1 = base + v * reach;
        g.beginPath();
        for (var k = 0; k < sym; k++) {
          var c = k * sector;
          g.moveTo(Math.cos(c + off) * base, Math.sin(c + off) * base);
          g.lineTo(Math.cos(c + off) * r1, Math.sin(c + off) * r1);
          g.moveTo(Math.cos(c - off) * base, Math.sin(c - off) * base);
          g.lineTo(Math.cos(c - off) * r1, Math.sin(c - off) * r1);
        }
        g.strokeStyle = hsla(q.hue + 280 + i * 3 + s.t * 20, 92, 56, 0.16 + v * 0.4);
        g.lineWidth = (1 + v * 2.5) * unit;
        g.stroke();
      }
      // The petals' outline, through the tips.
      g.beginPath();
      for (var k2 = 0; k2 < sym; k2++) {
        var c2 = k2 * sector;
        for (var j = 0; j < B; j += 2) {
          var vv = clamp(a.bands[j] * R + calm * 0.3, 0, 1);
          var rr = base + vv * reach * 1.08, o = (j / B) * sector / 2;
          var x = Math.cos(c2 + o) * rr, y = Math.sin(c2 + o) * rr;
          if (k2 === 0 && j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        for (var j2 = B - 2; j2 >= 0; j2 -= 2) {
          var v2 = clamp(a.bands[j2] * R + calm * 0.3, 0, 1);
          var r2 = base + v2 * reach * 1.08, o2 = (j2 / B) * sector / 2;
          g.lineTo(Math.cos(c2 + sector - o2) * r2, Math.sin(c2 + sector - o2) * r2);
        }
      }
      g.closePath();
      g.strokeStyle = hsla(q.hue + 190 + s.t * 15, 90, 70, 0.45);
      g.lineWidth = unit;
      g.stroke();
    }),

    // Starlane (after the AVS presets Winamp 5 shipped with): a starfield rushing past, faster
    // with the level, streaking on the kicks. Density sets the number of stars.
    starlane: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, R = q.react;
      var count = Math.round(clamp(w * h / 900 * q.density, 120, 2400));
      if (!s.stars || s.count !== count) {
        s.count = count;
        s.stars = new Float32Array(count * 3);
        for (var i = 0; i < count; i++) {
          s.stars[i * 3] = Math.random() * 2 - 1;
          s.stars[i * 3 + 1] = Math.random() * 2 - 1;
          s.stars[i * 3 + 2] = Math.random();
        }
      }
      fade(g, w, h, 0.38);
      var cx = w / 2, cy = h / 2, f = Math.max(w, h) * 0.5;
      var dt = a.dt || 1 / 60;
      var spd = (0.18 + a.level * 0.9 * R + a.kick * 1.1 * R) * q.speed * dt;
      var streak = spd * (1.5 + a.kick * 6 * R);
      // A glow at the vanishing point, pulsing with the kick.
      var glow = g.createRadialGradient(cx, cy, 0, cx, cy, f * 0.5);
      glow.addColorStop(0, hsla(q.hue + 220 + a.centroid * 80, 90, 60, 0.12 + a.kick * 0.25 * R));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      // Three depths by four colours: twelve strokes a frame, whatever the count.
      for (var layer = 0; layer < 12; layer++) {
        var depth = layer % 3, tint = (layer / 3) | 0;
        g.beginPath();
        for (var k = 0; k < count; k++) {
          if (k % 4 !== tint) continue;
          var o = k * 3;
          var z = s.stars[o + 2];
          if ((z < 0.33 ? 2 : z < 0.66 ? 1 : 0) !== depth) continue;
          var nz = z - spd;
          if (nz <= 0.02) {
            s.stars[o] = Math.random() * 2 - 1;
            s.stars[o + 1] = Math.random() * 2 - 1;
            s.stars[o + 2] = 1;
            continue;
          }
          s.stars[o + 2] = nz;
          var x1 = cx + s.stars[o] / nz * f, y1 = cy + s.stars[o + 1] / nz * f;
          if (x1 < -20 || x1 > w + 20 || y1 < -20 || y1 > h + 20) { s.stars[o + 2] = 1; continue; }
          var z0 = nz + streak;
          g.moveTo(cx + s.stars[o] / z0 * f, cy + s.stars[o + 1] / z0 * f);
          g.lineTo(x1, y1);
        }
        g.strokeStyle = hsla(q.hue + 190 + tint * 35 + bandAt(a, tint / 3) * 60 * R, 85, 72,
          0.35 + depth * 0.3);
        g.lineWidth = 0.6 + depth * 1.1;
        g.stroke();
      }
    }),

    // Rave (after Unchained): nested polygons of `symmetry` sides turning against each other in
    // a feedback that zooms with the kick; every eighth beat turns them all the other way.
    rave: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react;
      var sides = Math.max(3, Math.round(q.symmetry));
      var dt = a.dt || 1 / 60;
      if (!s.dir) { s.dir = 1; s.ang = 0; s.beats = 0; }
      if (a.beat && R > 0 && ++s.beats % 8 === 0) s.dir = -s.dir;
      s.ang += dt * (0.35 + a.mid * 0.9 * R) * s.dir;
      feedback(p, g, s, 1.012 + a.kick * 0.03 * R, s.dir * 0.006, 0.45 + q.trails * 0.4);
      g.translate(w / 2, h / 2);
      g.globalCompositeOperation = 'lighter';
      g.lineJoin = 'round';
      var unit = Math.max(1, m / 560);
      for (var k = 0; k < 7; k++) {
        var rad = m * (0.05 + k * 0.055) * (1 + bandAt(a, k / 6) * 0.55 * R);
        var turn = s.ang * (k % 2 ? 1 : -1) * (1 + k * 0.15);
        g.beginPath();
        for (var i = 0; i <= sides; i++) {
          var an = turn + i / sides * TAU;
          var x = Math.cos(an) * rad, y = Math.sin(an) * rad;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        var col = hsla(q.hue + k * 30 + s.t * 25 + a.flux * 70 * R, 95, 60, 0.85);
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 8 * unit;
        g.lineWidth = (1.3 + a.kick * 3 * R) * unit;
        g.stroke();
        if (k === 0) {
          g.fillStyle = hsla(q.hue + s.t * 25, 95, 60, 0.12 + a.kick * 0.3 * R);
          g.fill();
        }
      }
    }),

    // Ripple (after Zylot): rings sent out from the centre by every kick (wide) and snare
    // (thin), bent by the waveform as they spread; in silence they come on a slow pulse.
    ripple: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react;
      var P = 48, dt = a.dt || 1 / 60;
      if (!s.r) {
        s.r = new Float32Array(P); s.al = new Float32Array(P); s.hu = new Float32Array(P);
        s.wd = new Float32Array(P); s.slot = 0; s.quiet = 0; s.sn = 0;
      }
      function emit(width, alpha, hue) {
        var i = s.slot = (s.slot + 1) % P;
        s.r[i] = m * 0.02; s.al[i] = alpha; s.wd[i] = width; s.hu[i] = hue;
        s.quiet = 0;
      }
      if (R > 0 && a.beat) emit(3.2, 0.9, q.hue + 190 + a.centroid * 100);
      if (R > 0 && a.snare > 0.85 && s.sn <= 0.85) emit(1.2, 0.75, q.hue + 300 + a.centroid * 60);
      s.sn = a.snare;
      s.quiet += dt;
      if (s.quiet > 1.4 / q.speed) emit(1.8, 0.5, q.hue + 220 + s.t * 10);
      fade(g, w, h, 0.22);
      g.translate(w / 2, h / 2);
      g.globalCompositeOperation = 'lighter';
      var maxR = Math.hypot(w, h) * 0.55;
      var seg = Math.round(40 + q.detail * 48);
      var grow = m * (0.2 + a.level * 0.35 * R) * q.speed * dt;
      var unit = Math.max(1, m / 600);
      for (var i = 0; i < P; i++) {
        if (s.al[i] <= 0) continue;
        s.r[i] += grow * (1 + s.r[i] / maxR);
        s.al[i] -= dt * 0.32;
        if (s.r[i] > maxR) s.al[i] = 0;
        if (s.al[i] <= 0) continue;
        var bend = m * 0.035 * R * (1 - s.r[i] / maxR);
        g.beginPath();
        var wl = a.wave.length - 1;
        for (var j = 0; j < seg; j++) {
          var an = j / seg * TAU;
          // A symmetric index into the waveform: the ring closes without a seam.
          var wi = Math.floor((0.5 - 0.5 * Math.cos(an * 2 + i)) * wl);
          var rad = s.r[i] + a.wave[wi] * bend;
          var x = Math.cos(an) * rad, y = Math.sin(an) * rad;
          if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        g.strokeStyle = hsla(s.hu[i], 90, 64, s.al[i]);
        g.lineWidth = s.wd[i] * unit;
        g.stroke();
      }
      var core = m * (0.015 + a.kick * 0.03 * R + a.level * 0.01);
      g.beginPath();
      g.arc(0, 0, core, 0, TAU);
      g.fillStyle = hsla(q.hue + 200, 90, 75, 0.6);
      g.fill();
    }),

    // Veil (after Aderrasi): curtains of aurora that the spectrum lifts, each a glowing ribbon
    // with light falling from it. Gentle by design: it is also the calm picture behind pages.
    veil: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react, t = s.t * q.speed;
      bg(g, w, h, 'rgba(2,4,12,0.2)');
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      var N = 36, unit = Math.max(1, m / 600);
      if (!s.ys) s.ys = new Float32Array(N + 1);
      for (var r = 0; r < 5; r++) {
        var hue = q.hue + 140 + r * 34 + t * 5 + a.centroid * 40 * R;
        for (var i = 0; i <= N; i++) {
          var f = i / N;
          s.ys[i] = h * (0.34 + r * 0.065)
            + Math.sin(f * 6.5 + t * (0.35 + r * 0.11) + r) * h * 0.055
            + Math.sin(f * 2.3 - t * 0.21 + r * 2) * h * 0.04
            - bandAt(a, f) * h * 0.18 * R;
        }
        // The ribbon as a smooth curve through the midpoints.
        g.beginPath();
        g.moveTo(0, s.ys[0]);
        for (var j = 1; j < N; j++) {
          var x0 = j / N * w, x1 = (j + 1) / N * w;
          g.quadraticCurveTo(x0, s.ys[j], (x0 + x1) / 2, (s.ys[j] + s.ys[j + 1]) / 2);
        }
        g.lineTo(w, s.ys[N]);
        // Light falling from it, a curtain.
        g.save();
        g.lineTo(w, s.ys[N] + h * 0.28);
        g.lineTo(0, s.ys[0] + h * 0.28);
        g.closePath();
        var top = h * (0.25 + r * 0.065);
        var curtain = g.createLinearGradient(0, top, 0, top + h * 0.4);
        curtain.addColorStop(0, hsla(hue, 85, 55, 0.07 * q.glow + a.kick * 0.04 * R));
        curtain.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = curtain;
        g.fill();
        g.restore();
        g.beginPath();
        g.moveTo(0, s.ys[0]);
        for (var k = 1; k < N; k++) {
          var xa = k / N * w, xb = (k + 1) / N * w;
          g.quadraticCurveTo(xa, s.ys[k], (xa + xb) / 2, (s.ys[k] + s.ys[k + 1]) / 2);
        }
        g.lineTo(w, s.ys[N]);
        g.strokeStyle = hsla(hue, 90, 60, 0.06 * q.glow);
        g.lineWidth = 26 * unit * (0.5 + q.glow * 0.5);
        g.stroke();
        g.strokeStyle = hsla(hue, 90, 62, 0.14 * q.glow + 0.04);
        g.lineWidth = 9 * unit;
        g.stroke();
        g.strokeStyle = hsla(hue, 90, 75, 0.45 + a.level * 0.3 * R);
        g.lineWidth = 1.4 * unit;
        g.stroke();
      }
    }),

    // Swarm (after Eo.S. and Phat): motes drifting on a flow field, faster and brighter with the
    // music, added as light. Density is the number of motes. Also a calm background picture.
    swarm: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, R = q.react, t = s.t;
      var count = Math.round(clamp(w * h / 700 * q.density, 150, 2600));
      if (!s.xy || s.count !== count) {
        s.count = count;
        s.xy = new Float32Array(count * 2);
        for (var i = 0; i < count; i++) {
          s.xy[i * 2] = Math.random() * w;
          s.xy[i * 2 + 1] = Math.random() * h;
        }
      }
      fade(g, w, h, 0.12);
      g.globalCompositeOperation = 'lighter';
      var dt = a.dt || 1 / 60;
      var speed = (0.5 + a.level * 2.6 * R + a.kick * 2.2 * R) * q.speed * dt * 60;
      var ts = t * q.speed;
      for (var grp = 0; grp < 8; grp++) {
        var b = bandAt(a, grp / 7);
        var size = 1.2 + b * 2.6 * R;
        g.beginPath();
        for (var k = grp; k < count; k += 8) {
          var o = k * 2, x = s.xy[o], y = s.xy[o + 1];
          var ang = (Math.sin(x * 0.0035 + ts * 0.21) + Math.cos(y * 0.004 - ts * 0.17)
            + Math.sin((x + y) * 0.0021 + ts * 0.11)) * Math.PI;
          x += Math.cos(ang) * speed;
          y += Math.sin(ang) * speed;
          if (x < 0 || x > w || y < 0 || y > h) { x = Math.random() * w; y = Math.random() * h; }
          s.xy[o] = x; s.xy[o + 1] = y;
          g.rect(x, y, size, size);
        }
        g.fillStyle = hsla(q.hue + 200 + grp * 20 + t * 8 + a.centroid * 60 * R, 90, 66,
          0.4 + b * 0.5 * Math.min(R, 1.5));
        g.fill();
      }
    }),

    // Moire (after Telek): grids of lines turning past each other a little out of step, so the
    // interference makes shapes no grid holds; the kick nudges them. Detail is the density.
    moire: mode(function (p, g, a, s, q) {
      var w = p.width, h = p.height, m = Math.min(w, h), R = q.react, t = s.t * q.speed;
      bg(g, w, h, '#030308');
      g.translate(w / 2, h / 2);
      g.globalCompositeOperation = 'lighter';
      var D = Math.hypot(w, h) * 0.55;
      var sp = m / (10 + q.detail * 18);
      if (!s.nudge) s.nudge = 0;
      s.nudge = s.nudge * 0.92 + a.kick * 0.03 * R;
      var th = t * 0.05;
      function lines(theta, spacing, css, width) {
        var c = Math.cos(theta), sn = Math.sin(theta);
        g.beginPath();
        for (var d = -D; d <= D; d += spacing) {
          g.moveTo(c * d - sn * -D, sn * d + c * -D);
          g.lineTo(c * d - sn * D, sn * d + c * D);
        }
        g.strokeStyle = css;
        g.lineWidth = width;
        g.stroke();
      }
      lines(th, sp, hsla(q.hue + 190, 85, 62, 0.42), sp * 0.2);
      lines(th + 0.05 + 0.035 * Math.sin(t * 0.2) + s.nudge, sp * (1 + a.bass * 0.06 * R),
        hsla(q.hue + 300, 85, 62, 0.42), sp * 0.2);
      // Concentric squares turning the other way, breathing with the mids.
      g.rotate(-th * 1.6 + s.nudge);
      var q2 = sp * (1.15 + a.mid * 0.15 * R);
      g.beginPath();
      for (var r = q2; r < D; r += q2) g.rect(-r, -r, r * 2, r * 2);
      g.strokeStyle = 'rgba(248,250,252,' + (0.16 + a.hat * 0.2 * R).toFixed(3) + ')';
      g.lineWidth = q2 * 0.14;
      g.stroke();
      // A vignette: the interference glows in the middle and sinks into the dark at the edges.
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      var cw = p.canvas.width, ch = p.canvas.height;
      if (!s.vig || s.vw !== cw) {
        s.vw = cw;
        s.vig = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.15,
          cw / 2, ch / 2, Math.hypot(cw, ch) * 0.55);
        s.vig.addColorStop(0, 'rgba(3,3,8,0)');
        s.vig.addColorStop(1, 'rgba(3,3,8,0.92)');
      }
      g.fillStyle = s.vig;
      g.fillRect(0, 0, cw, ch);
    }),
  };
})();
