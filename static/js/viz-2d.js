// The visualiser's 2D modes: ten original pictures on p5, each an homage to one Winamp-era
// visualisation (data/visualizer.json names them, credits the original and lists the live
// parameters). static/js/visualizer.js loads this file with p5, creates the p5 instance (HSB,
// pixel density, frame rate) and calls window.SonicViz2D[mode](p, a, s) once per frame:
//   a  the frame's analysis of the sound (SonicVizAnalysis, types/sonic.d.ts): bands, wave,
//      chroma, kick/snare/hat envelopes, beat and bar, timbre, stereo, sections. In clock mode
//      the host synthesises it; a mode only ever consumes it.
//   s  the mode's own scratch, fresh at every mode change and resize: s.t is the mode's age in
//      seconds, s.params every parameter at its current value (read live, every frame), and s.m
//      the frame's shared signals (static/js/viz-map.js, the grammar every mode speaks).
// Every mode follows the grammar the same way (look() below reads it once per frame):
//   colour      the palette is the key's hue (m.hue, the hue control included) with fixed offsets
//               per mode, its saturation and lightness, and the leading note as the accent;
//   brightness  rides m.exposure, the slow loudness; an impulse brightens only by its share
//               times m.flashGain (at most three flashes a second);
//   time        travel is paced by the tempo, shapes lock to the beat (m.pulse, m.pre) and the
//               bar (m.barPulse), big events are m.punch;
//   form        a new section of the song draws a new variant of the scene (m.variant), morphed;
//   calm        react 0 is a calm, music-free picture; reduced motion (m.motion, m.reduced) caps
//               motion and turns impulses into colour.
// The heavy loops draw on the canvas context directly, batched into a few paths per frame, with
// no allocations per element: the budget is about 4 ms a frame on a mid phone at 390x844.
// Every picture is composed around min(width, height), so a phone held upright frames it too.
(function () {
  'use strict';
  var TAU = Math.PI * 2;
  var SX = 0, SY = 0; // the point a shape function returns, without allocating one

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smooth(x) { return x * x * (3 - 2 * x); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  /** A CSS colour from hue (degrees, any range), saturation and lightness (%), alpha. */
  function hsla(h, sat, light, alpha) {
    return 'hsla(' + ((h % 360 + 360) % 360).toFixed(1) + ',' + clamp(sat, 0, 100).toFixed(1) + '%,'
      + clamp(light, 0, 100).toFixed(1) + '%,' + clamp(alpha, 0, 1).toFixed(3) + ')';
  }
  // The luminance of each hue at full saturation and half lightness (linear sRGB, one per degree):
  // yellow is 0.93, blue 0.07. A palette that turns with the key went ten times darker as the key
  // moved it from yellow to violet, whatever the music did (analysis pass 3: pocket fell from a
  // luminance of 0.054 to 0.020 at a key change and stayed there through the loudest part).
  var HUE_Y = new Float32Array(360);
  for (var hd = 0; hd < 360; hd++) {
    var lin3 = [0, 120, 240].map(function (o) {
      var c = clamp(2 - Math.abs(((hd - o + 540) % 360) - 180) / 60, 0, 1);
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    HUE_Y[hd] = 0.2126 * lin3[0] + 0.7152 * lin3[1] + 0.0722 * lin3[2];
  }
  /** hsla with the lightness a dark hue (blue, violet, red) needs to read as bright as the rest. */
  function hsle(h, sat, light, alpha) {
    var y = HUE_Y[((Math.round(h) % 360) + 360) % 360];
    return hsla(h, sat, light + 16 * Math.max(0, 0.42 - y) / 0.42, alpha);
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
    g.fillStyle = 'rgba(0,0,0,' + alpha.toFixed(3) + ')';
    g.fillRect(0, 0, w, h);
  }
  function bg(g, w, h, css) {
    g.fillStyle = css;
    g.fillRect(0, 0, w, h);
  }
  // MilkDrop's feedback: the last frame, copied aside, drawn back zoomed and turned over black,
  // at `keep` opacity. A copy (not the canvas onto itself) keeps the trails clean.
  function feedback(p, g, s, zoom, turn, keep, dx) {
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
    g.translate(w / 2 + dx, h / 2);
    g.rotate(turn);
    g.scale(zoom, zoom);
    g.drawImage(s.buf, -w / 2 - dx, -h / 2, w, h);
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

  /** The scene variant (0..n-1) of this section and of the last one (grammar R3). */
  function vary(m, n) { return Math.min(n - 1, Math.floor(m.variant * n)); }
  function varied(m, n) { return Math.min(n - 1, Math.floor(m.prevVariant * n)); }

  /**
   * The grammar's frame for one mode (static/js/viz-map.js), read once: the palette in degrees
   * and percent, the brightness, the beat-locked shapes and impulses scaled by react (react 0
   * is the calm picture), the tempo-paced clock in beats, and the waveform's auto-gain. `off`
   * is the mode's fixed turn of the palette (its character in any key).
   */
  function look(s, q, a, off) {
    var G = s.g || (s.g = {});
    var m = s.m;
    var R = Math.max(0, q.react === undefined ? 1 : q.react);
    var k = Math.min(1, R);
    var dt = a.dt || 1 / 60;
    G.m = m; G.R = R; G.k = k; G.dt = dt; G.mo = m.motion;
    G.off = off;
    G.H = m.hue * 360 + off;
    G.A = m.accent * 360 + off;
    G.S = 38 + 56 * m.sat;
    G.L = 50 + 16 * m.light;
    // Brightness rides the slow loudness only; at react 0 it rests at a fixed level. G.ek is that
    // exposure itself (0..1), for the sparse modes that also widen their light with it.
    G.ek = k * m.exposure + (1 - k) * 0.55;
    G.ex = 0.62 + 0.38 * G.ek;
    // How loud the passage is, for motion: 0 at half the song's peak exposure or below, 1 at the
    // peak (the bands are auto-gained, so without it a quiet break moved as much as the drop).
    G.lk = k * smooth(clamp((m.exposure - 0.5) / 0.5, 0, 1)) + (1 - k) * 0.5;
    G.punch = Math.min(1.5, m.punch * R);
    // The beat's shapes only while the beat moves (a paused clock holds its phase at 0) and
    // something is heard (the tempo's flywheel runs on through a silence).
    if (a.phase !== s.phase) { s.phase = a.phase; s.phaseT = a.t; }
    var heard = a.t - (s.phaseT || -9) < 0.5 ? Math.min(1, m.level * 1.5) : 0;
    s.beatOn = lerp(heard, s.beatOn || 0, Math.exp(-dt / 0.3));
    G.pulse = m.pulse * k * s.beatOn;
    G.pre = m.pre * k * s.beatOn;
    G.bar = m.barPulse * k * s.beatOn;
    G.flash = m.flashGain;
    G.pan = m.pan * k;
    G.spread = m.spread * k;
    G.mix = smooth(clamp(m.morph, 0, 1));
    // The ambient pace: full while sound is heard (or at react 0), settling to 0.3 in silence.
    G.amb = 0.3 + 0.7 * ((1 - k) + k * Math.min(1.2, m.level));
    // Under reduced motion, travel and feedback slow to a crawl (grammar R5).
    G.cap = m.reduced ? 0.04 : 1;
    // The clock, in beats: the tempo sets the pace, speed multiplies it, reduced motion slows it.
    s.beats = (s.beats || 0) + dt * 2 * m.rate * (q.speed || 1) * m.motion;
    G.beats = s.beats;
    // The bars counted, from the position in the bar wrapping round.
    if ((a.bar || 0) < (s.lastBar || 0) - 0.5) s.bars = (s.bars || 0) + 1;
    s.lastBar = a.bar || 0;
    G.bars = s.bars || 0;
    // The waveform's auto-gain: its peak over the last second or so.
    var pk = 0;
    for (var i = 0; i < a.wave.length; i += 4) pk = Math.max(pk, Math.abs(a.wave[i]));
    s.wpk = Math.max(pk, (s.wpk || 0) * Math.exp(-dt / 1.2));
    G.wg = Math.min(6, 0.9 / Math.max(0.12, s.wpk));
    return G;
  }

  /** True on the frame an envelope crosses up through thr, latched for a quarter beat (R2). */
  function onset(s, key, v, thr, a) {
    var was = s[key] || 0;
    s[key] = v;
    var fired = v > thr && was <= thr && a.t - (s[key + 'T'] || -9) > 15 / (a.bpm || 120);
    if (fired) s[key + 'T'] = a.t;
    return fired;
  }

  // Each band against its own last seconds (the towers' "own relative term"): s.blong is the
  // long average (4 s), the result the react-scaled deviation per band, -1..2.
  function bandDrive(s, a, R, dt) {
    var n = a.bands.length;
    if (!s.blong || s.blong.length !== n) { s.blong = new Float32Array(n); s.bdrv = new Float32Array(n); }
    var kk = 1 - Math.exp(-dt / 4);
    for (var i = 0; i < n; i++) {
      var x = a.bands[i];
      s.blong[i] = s.blong[i] > 0 ? s.blong[i] + (x - s.blong[i]) * kk : x;
      s.bdrv[i] = clamp((x / Math.max(0.05, s.blong[i]) - 1) * R, -1, 2);
    }
    return s.bdrv;
  }

  // A bar's height with a soft knee: linear up to 0.6, then easing towards 1 without reaching it,
  // so a loud, dense passage still moves the tops (a clamp at 1 held them still: on techno the bar
  // modes moved less the louder it got, analysis pass 2).
  function knee(v) { return v < 0.6 ? Math.max(0, v) : 0.6 + 0.4 * (1 - Math.exp((0.6 - v) / 0.4)); }
  // A bank's headroom: its tallest raw bar of the last seconds (up at once, down over 1.5 s), at
  // least 1. Bars drawn against it spread over the height when a passage drives them all past it.
  function headroom(s, top, dt) {
    s.head = Math.max(1, top, (s.head || 1) * Math.exp(-dt / 1.5));
    return s.head;
  }

  // How hard the kick and the beat pump a bank of bars this frame: 1 at rest, more on a kick as
  // the passage is loud (the level against its last seconds), never under reduced motion.
  function pumpOf(G, a) {
    var lv = Math.min(1.5, G.m.level);
    return 1 + (0.5 * a.kick * G.k + 0.3 * G.pulse) * lv * G.mo;
  }

  // The pitch class nearest each band's centre (48 bands, 40 Hz to 16 kHz), for tonal tints;
  // -1 outside the chroma's range (80 Hz to 5 kHz).
  var PCS = [];
  for (var b0 = 0; b0 < 48; b0++) {
    var hz = 40 * Math.pow(400, b0 / 47);
    PCS.push(hz < 80 || hz > 5000 ? -1 : ((Math.round(12 * Math.log2(hz / 261.63)) % 12) + 12) % 12);
  }
  /** How strongly the note under band i sounds, 0..1 (sharpened: power 2). */
  function tonal(a, i) {
    var pc = PCS[Math.min(47, Math.round(i * 47 / Math.max(1, a.bands.length - 1)))];
    var c = pc < 0 || !a.chroma ? 0 : a.chroma[pc] || 0;
    return c * c;
  }

  // The column layouts of the analysers, a fraction of the width to a fraction of the spectrum:
  // bass to the left; bass in the middle, mirrored; bass at both edges.
  function layout(kind, f) {
    if (kind === 1) return Math.abs(2 * f - 1);
    if (kind === 2) return 1 - Math.abs(2 * f - 1);
    return f;
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
  /** The flux shape at u for a section's variant, morphing every four bars: into SX, SY. */
  function fluxShape(v, beats, u, t) {
    var k = beats / 16 + v * SHAPES;
    var i0 = Math.floor(k) % SHAPES, i1 = (i0 + 1) % SHAPES;
    var mix = smooth(clamp((k - Math.floor(k) - 0.55) / 0.45, 0, 1));
    shape(i0, u, t);
    var x0 = SX, y0 = SY;
    shape(i1, u, t);
    SX = x0 + (SX - x0) * mix;
    SY = y0 + (SY - y0) * mix;
  }

  window.SonicViz2D = {
    // Flux (after G-Force): ribbons of the waveform that morph from shape to shape, in a
    // zooming, turning feedback. The bass on the beat pushes the zoom, the bar swings the turn,
    // a snare jolts it towards the side the sound leans; the ribbons are the key's colours, the
    // last one the leading note's, and each section of the song starts from another shape.
    flux: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 0), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), t = s.t;
      if (onset(s, 'sn', a.snare, 0.8, a)) s.jolt = (m.pan >= 0 ? 1 : -1) * G.k;
      s.jolt = (s.jolt || 0) * Math.exp(-G.dt / 0.3);
      var zoom = 1 + (q.warp * 0.008 + q.zoom * 0.004 + 0.05 * Math.max(0, m.drive.bass) * G.pulse * G.mo
        + 0.025 * G.punch * G.mo) * G.cap;
      var turn = (q.warp * (0.003 + 0.006 * Math.sin((G.bars + (a.bar || 0)) * TAU / 2) * G.k)
        + 0.03 * s.jolt * G.mo) * G.cap;
      var base = 0.62 + 0.33 * q.trails, keep = Math.pow(base, G.dt * 60);
      // The trail fades by the clock, so a slow frame fades more: it lays down as much more light,
      // and the picture is as bright at 6 fps as at 60 (a slow device read it at a third, CI).
      var lay = Math.min(12, (1 - keep) / (1 - base));
      feedback(p, g, s, zoom, turn, keep, G.pan * w * 0.3);
      var unit = Math.max(1, M / 520);
      g.globalCompositeOperation = 'lighter';
      g.lineJoin = 'round';
      g.translate(w / 2 + G.pan * w, h / 2);
      var N = 160, wl = a.wave.length;
      var wg = G.wg * 0.3 * G.k * (0.5 + 0.5 * Math.min(1.5, m.level));
      for (var r = 0; r < 3; r++) {
        var size = M * (0.19 + r * 0.065) * (1 + (0.22 * m.drive.level + 0.12 * G.punch) * G.mo);
        var spin = G.beats * 0.11 * (r % 2 ? -1 : 1) + r;
        var ct = Math.cos(spin), st = Math.sin(spin);
        var off = (r - 1) * G.spread * M * 0.09;
        g.beginPath();
        for (var j = 0; j <= N; j++) {
          var u = j / N;
          fluxShape(m.prevVariant, G.beats, u, t);
          var xa = SX, ya = SY;
          fluxShape(m.variant, G.beats, u, t);
          var x = lerp(xa, SX, G.mix), y = lerp(ya, SY, G.mix);
          // A symmetric index into the waveform closes the loop without a seam.
          var wi = Math.floor((0.5 - 0.5 * Math.cos(u * TAU * 2 + r)) * (wl - 5)) + 2;
          var d = 1 + (a.wave[wi - 2] + a.wave[wi - 1] + a.wave[wi] + a.wave[wi + 1] + a.wave[wi + 2]) * 0.2 * wg + (Math.random() - 0.5) * m.rough * 0.05 * G.k;
          var px = x * size * d, py = y * size * d;
          var rx = px * ct - py * st + off, ry = px * st + py * ct;
          if (j === 0) g.moveTo(rx, ry); else g.lineTo(rx, ry);
        }
        var hue = r === 2 ? lerp(G.H + 30, G.A, 0.5) : G.H - 28 + r * 28;
        // As wide, bright and haloed as the passage is exposed: thin ribbons on black were near
        // black on techno (79 % of the frames, analysis pass 3), whose steady drop has no deviation
        // of the level to widen them.
        var col = hsle(hue + G.punch * 18, G.S, G.L + 4, Math.min(1, (0.42 + 0.3 * G.ek + 0.12 * G.punch * G.flash) * G.ex * lay));
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = (5 + 9 * m.halo) * unit * (0.7 + 0.5 * G.ek);
        g.lineWidth = (1.1 + 1.6 * Math.max(0, m.drive.level) + 1.4 * G.pulse) * unit * (0.8 + 0.8 * G.ek);
        g.stroke();
      }
    }),

    // Signal tower (after Winamp's own analyser): bars with falling peak caps, a glow, a
    // reflection on a dark floor and an oscilloscope above them. Each bar is its band against
    // that band's own last seconds; bars where a sounding note lies take the leading note's
    // colour; the floor glows on the downbeat; the scope leans and doubles with the stereo; a
    // section rearranges the bank (bass left, bass in the middle, bass at the edges).
    tower: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 20), m = G.m, w = p.width, h = p.height, glow = q.glow, k = G.k;
      var n = Math.round(clamp(24 + (q.detail - 0.25) / 1.75 * 72, 24, 96));
      if (!s.peaks || s.peaks.length !== n) {
        s.peaks = new Float32Array(n); s.vals = new Float32Array(n); s.hold = new Float32Array(n);
        s.tone = new Float32Array(n);
      }
      var drv = bandDrive(s, a, G.R, G.dt), B = a.bands.length;
      var portrait = h > w;
      var floor = h * (portrait ? 0.66 : 0.72);
      var top = h * (portrait ? 0.38 : 0.54);
      var pad = Math.max(10, w * 0.05);
      var unit = Math.max(1, Math.min(w, h) / 600);
      var back = g.createLinearGradient(0, 0, 0, h);
      back.addColorStop(0, hsla(G.H + 210, 45, 3, 1));
      back.addColorStop(1, hsla(G.H + 220, 50, 6 + 4 * G.ex, 1));
      bg(g, w, h, back);
      var gap = Math.max(1, (w - pad * 2) / n * 0.24);
      var bw = (w - pad * 2 - gap * (n - 1)) / n;
      var calm = 1 - k;
      var dt = G.dt, rel = Math.exp(-dt / 0.12);
      var lay = vary(m, 3), was = varied(m, 3);
      // Each bar against the bank's headroom, through the soft knee, pumped by the kick and the
      // beat as hard as the passage is loud: the bars show the spectrum against its own loudest
      // band, so a steady drop drew a still bank and a filtered break a busy one.
      var head = s.head || 1, tall = 0, pump = pumpOf(G, a);
      for (var i = 0; i < n; i++) {
        var f = i / (n - 1);
        var fb = lerp(layout(was, f), layout(lay, f), G.mix);
        var bi = Math.round(fb * (B - 1));
        var idle = 0.12 + 0.08 * Math.sin(G.beats * 0.7 + i * 0.35);
        var raw = calm * idle + k * Math.pow(bandAt(a, fb), 1.2) * (1 + 0.5 * drv[bi]) * (0.85 + 0.35 * fb);
        tall = Math.max(tall, raw);
        var v = knee(raw / head * pump);
        s.vals[i] = v > s.vals[i] ? v : s.vals[i] * rel + v * (1 - rel);
        s.tone[i] = tonal(a, bi) * k;
        if (s.vals[i] >= s.peaks[i]) { s.peaks[i] = s.vals[i]; s.hold[i] = 0.35; }
        else if (s.hold[i] > 0) s.hold[i] -= dt;
        else s.peaks[i] = Math.max(0, s.peaks[i] - dt / 0.6);
      }
      headroom(s, tall, dt);
      // The bars, two paths: the glow is computed once for each. Where a sounding note lies,
      // the bar takes the leading note's colour.
      for (var pass = 0; pass < 2; pass++) {
        g.beginPath();
        for (var b = 0; b < n; b++) {
          if ((s.tone[b] > 0.5 ? 1 : 0) !== pass) continue;
          var bh = Math.max(2, s.vals[b] * top);
          g.rect(pad + b * (bw + gap), floor - bh, bw, bh);
        }
        // From the key's colour turned a third of the wheel at the foot to the far side at the top:
        // in C major, Winamp's own green, yellow and red.
        var grad = g.createLinearGradient(0, floor, 0, floor - top);
        grad.addColorStop(0, hsla(G.H + 60, G.S, G.L - 10, G.ex));
        grad.addColorStop(0.55, hsla(pass ? lerp(G.H, G.A, 0.5) : G.H, G.S, G.L, G.ex));
        grad.addColorStop(1, hsla(pass ? G.A : G.H - 45, G.S, G.L + 8, G.ex));
        g.fillStyle = grad;
        g.shadowColor = hsla(G.H, G.S, 58, 0.55 * G.ex);
        g.shadowBlur = (10 + 14 * Math.max(0, m.drive.high)) * glow * unit;
        g.fill();
      }
      g.shadowBlur = 0;
      // The segments of an LED column, cut across the bars.
      g.fillStyle = 'rgba(4,5,12,0.5)';
      var step = Math.max(3, top / 40);
      for (var y = floor - step; y > floor - top; y -= step) g.fillRect(pad, y, w - pad * 2, 1);
      // The reflection.
      g.beginPath();
      for (var c = 0; c < n; c++) g.rect(pad + c * (bw + gap), floor + 4, bw, s.vals[c] * top * 0.4);
      var mirror = g.createLinearGradient(0, floor, 0, floor + top * 0.4);
      mirror.addColorStop(0, hsla(G.H, G.S, 50, 0.3 * G.ex));
      mirror.addColorStop(1, hsla(G.H, G.S, 50, 0));
      g.fillStyle = mirror;
      g.fill();
      // The peak caps, a little lifted by a big event, glinting before the beat.
      g.beginPath();
      var lift = 4 + G.punch * G.mo * top * 0.03;
      for (var c2 = 0; c2 < n; c2++) g.rect(pad + c2 * (bw + gap), floor - s.peaks[c2] * top - lift, bw, 2 * unit);
      g.fillStyle = hsla(G.A, 30, 92, 0.95);
      g.shadowColor = hsla(G.A, 60, 85, 0.8);
      g.shadowBlur = (6 + 10 * G.pre) * glow * unit;
      g.fill();
      // The floor, glowing on the downbeat.
      g.shadowBlur = 0;
      g.fillStyle = hsla(G.H, 30, 75, 0.22 + 0.35 * G.bar * G.flash);
      g.fillRect(pad, floor + 1, w - pad * 2, unit);
      // The oscilloscope: placed by the balance, doubled by the width, as tall as the passage is
      // exposed (auto-gained alone, a quiet break's sparse trace moved more than a loud drop's).
      var y0 = h * (portrait ? 0.16 : 0.12), amp = h * 0.05 * (0.4 + 0.6 * k) * G.wg * (0.25 + 0.75 * G.ek);
      var len = a.wave.length, sx = G.pan * w * 0.5;
      for (var tr = 0; tr < 2; tr++) {
        var dy = (tr ? 1 : -1) * G.spread * h * 0.025;
        g.beginPath();
        for (var j = 0; j < len; j++) {
          var x = pad + sx + (w - pad * 2) * j / (len - 1);
          var yy = y0 + dy + a.wave[j] * amp;
          if (j === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.strokeStyle = hsla(G.H + 40, G.S, 72, (tr ? 0.25 + 0.6 * G.spread : 0.9) * G.ex);
        g.shadowColor = hsla(G.H + 40, G.S, 70, 0.8);
        g.shadowBlur = 10 * glow * unit;
        g.lineWidth = (1.3 + 1.6 * G.pulse) * unit;
        g.stroke();
      }
    }),

    // Pocket (after Tiny Fullscreen): a dot-matrix of LEDs, the spectrum lit column by column,
    // each column its band against its own last seconds, with a peak dot on each, a thin scope
    // under them and a row of the twelve notes (in fifths) showing which sound. The rows climb
    // through the key's colours; a section rearranges the columns. Detail is their number.
    pocket: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 95), m = G.m, w = p.width, h = p.height, k = G.k;
      var cols = Math.round(clamp(10 + q.detail * 18, 14, 46));
      var rows = h > w ? 18 : 14;
      if (!s.vals || s.vals.length !== cols) {
        s.vals = new Float32Array(cols);
        s.peaks = new Float32Array(cols);
        s.notes = new Float32Array(12);
      }
      var drv = bandDrive(s, a, G.R, G.dt), B = a.bands.length;
      bg(g, w, h, hsla(G.H + 220, 40, 2, 1));
      var pitch = Math.min(w * 0.88 / cols, h * 0.5 / rows);
      // Unlit LEDs stay small; lit ones grow with the exposure (a mostly black ground: 73 % of
      // the frames near black on techno, analysis pass 3).
      var r = pitch * 0.3, rl = pitch * (0.3 + 0.15 * G.ek);
      var x0 = (w - pitch * (cols - 1)) / 2, y0 = (h + pitch * (rows - 1)) / 2 - h * 0.06;
      var calm = 1 - k, rel = Math.exp(-G.dt / 0.1);
      var lay = vary(m, 3), was = varied(m, 3);
      // As the tower's: each column against the bank's headroom, through the soft knee, pumped.
      var head = s.head || 1, tall = 0, pump = pumpOf(G, a);
      for (var c = 0; c < cols; c++) {
        var fb = lerp(layout(was, c / (cols - 1)), layout(lay, c / (cols - 1)), G.mix);
        var raw = k * Math.pow(bandAt(a, fb), 1.1) * (1.05 + 0.5 * drv[Math.round(fb * (B - 1))])
          + calm * (0.2 + 0.12 * Math.sin(G.beats * 0.55 + c * 0.5));
        tall = Math.max(tall, raw);
        // As tall as the passage is loud: the auto-gained bands filled the matrix as much in a
        // quiet break as in the drop, and the bars moved against the music (r -0.45 on techno).
        var v = knee(raw / head * pump) * (calm + k * (0.45 + 0.55 * G.lk));
        s.vals[c] = v > s.vals[c] ? v : s.vals[c] * rel + v * (1 - rel);
        s.peaks[c] = Math.max(s.vals[c], s.peaks[c] - G.dt / 0.9);
      }
      headroom(s, tall, G.dt);
      // Unlit dots, one path.
      g.beginPath();
      for (var cc = 0; cc < cols; cc++) {
        var lit = Math.round(s.vals[cc] * rows);
        for (var rr = lit; rr < rows; rr++) {
          var ux = x0 + cc * pitch, uy = y0 - rr * pitch;
          g.moveTo(ux + r, uy); g.arc(ux, uy, r, 0, TAU);
        }
      }
      g.fillStyle = hsla(G.H, 20, 70, 0.05);
      g.fill();
      // Lit dots, one path per row (one colour each), climbing from the key's deep colour to
      // the leading note's; a big event lights them up by its (governed) share.
      g.shadowBlur = pitch * (0.3 + 0.6 * m.halo) * (0.6 + 0.8 * G.ek);
      for (var row = 0; row < rows; row++) {
        g.beginPath();
        var any = false;
        for (var c2 = 0; c2 < cols; c2++) {
          if (Math.round(s.vals[c2] * rows) <= row) continue;
          var lx = x0 + c2 * pitch, ly = y0 - row * pitch;
          g.moveTo(lx + rl, ly); g.arc(lx, ly, rl, 0, TAU);
          any = true;
        }
        if (!any) continue;
        var f = row / (rows - 1);
        var hue = f > 0.8 ? lerp(G.H + 30, G.A, (f - 0.8) * 5) : G.H - 35 + f * 65;
        var col = hsle(hue, G.S, G.L - 10 + f * 12 + 6 * G.ek + 10 * G.punch * G.flash, G.ex);
        g.fillStyle = col;
        g.shadowColor = col;
        g.fill();
      }
      g.beginPath();
      var pr = r * 0.7 * (1 + 0.3 * G.pulse * G.mo);
      for (var c3 = 0; c3 < cols; c3++) {
        var py = y0 - Math.min(rows - 1, Math.round(s.peaks[c3] * rows)) * pitch;
        var px = x0 + c3 * pitch;
        g.moveTo(px + pr, py); g.arc(px, py, pr, 0, TAU);
      }
      g.fillStyle = hsla(G.A, 25, 95, 0.85);
      g.shadowColor = hsla(G.A, 60, 85, 0.6);
      g.fill();
      g.shadowBlur = 0;
      // The scope, placed by the balance, a ghost trace for the width, as tall as the tower's.
      var sy = y0 + pitch * 2.2, sw = pitch * (cols - 1), len = a.wave.length;
      var amp = pitch * 1.1 * (0.4 + 0.6 * k) * G.wg * (0.25 + 0.75 * G.ek), sx = G.pan * w * 0.4;
      for (var tr = 0; tr < 2; tr++) {
        g.beginPath();
        for (var j = 0; j < len; j++) {
          var x = x0 + sx + sw * j / (len - 1) + (tr ? G.spread * pitch : 0);
          var y = sy + a.wave[j] * amp * (tr ? -1 : 1);
          if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.strokeStyle = hsla(G.H + 20, G.S, 70, (tr ? 0.15 + 0.5 * G.spread : 0.7) * G.ex);
        g.lineWidth = Math.max(1, pitch * 0.06);
        g.stroke();
      }
      // The notes, in fifths (C G D A E B F# ...): a sounding key lights a cluster.
      var nr = Math.min(r * 1.2, sw / 30), ny = sy + pitch * 1.8;
      for (var nt = 0; nt < 12; nt++) {
        var pc = (nt * 7) % 12;
        var cv = a.chroma ? a.chroma[pc] || 0 : 0;
        s.notes[nt] = Math.max(cv * cv * k, s.notes[nt] * Math.exp(-G.dt / 0.4));
        g.beginPath();
        g.arc(x0 + sw * (nt + 0.5) / 12, ny, nr, 0, TAU);
        g.fillStyle = hsla(nt * 30 + (q.hue || 0) + G.off, G.S, 35 + 35 * s.notes[nt], 0.15 + 0.8 * s.notes[nt] * G.ex);
        g.fill();
      }
    }),

    // Kaleido (after Tuggummi): a flower of the spectrum mirrored into `symmetry` sectors,
    // turning with the tempo. A snare steps the whole flower by half a sector; a section
    // doubles or halves the folds; its heart breathes with the bass on the beat and a ring of
    // the twelve notes blooms where the harmony sounds. The rays run through the key's colours.
    kaleido: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 200), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), k = G.k;
      var sym = Math.round(clamp(q.symmetry, 2, 12));
      var MULT = [1, 2, 1.5];
      var folds = Math.max(2, Math.round(sym * MULT[G.mix > 0.5 ? vary(m, 3) : varied(m, 3)]));
      var dip = 0.45 + 0.55 * Math.abs(G.mix * 2 - 1);
      var B = a.bands.length;
      // The step is as large as the passage is loud (a full half sector at its usual level): a
      // snare in a quiet break turned it as far as one in the drop, so it moved against the music.
      // A snare roll (a build-up, where the kick drops out) fired a step on every quarter beat and
      // span the flower fastest in the quietest part (r -0.33 on techno, analysis pass 3): the
      // snares of the last beat share the step (s.rolls, decaying over a beat), and it is as large
      // as the passage is loud.
      s.rolls = (s.rolls || 0) * Math.exp(-G.dt * (a.bpm || 120) / 60);
      if (onset(s, 'sn', a.snare, 0.8, a)) {
        s.rolls += 1;
        s.stepTo = (s.stepTo || 0) + (m.reduced ? 0 : TAU / (2 * folds)) * Math.ceil(k) * Math.min(1, m.level)
          * (0.25 + 0.75 * G.lk) / (s.rolls * s.rolls);
      }
      s.theta = lerp(s.stepTo || 0, s.theta || 0, Math.exp(-G.dt / 0.12));
      fade(g, w, h, 0.2 + 0.25 * G.cap * (1 - q.trails));
      g.translate(w / 2 + G.pan * w * 0.5, h / 2);
      g.rotate(s.theta + G.beats * 0.035 + 0.05 * Math.sin(((a.bar || 0) + G.bars) * TAU / 4) * k);
      g.globalCompositeOperation = 'lighter';
      var base = M * 0.07 * (1 + (0.4 * Math.max(0, m.drive.bass) * G.pulse + 0.2 * G.punch) * G.mo);
      // The flower opens as wide as the passage is loud (its auto-gained rays reached as far in a
      // quiet break as in the drop).
      var reach = M * 0.42 * (1 + 0.15 * G.spread) * (0.85 + 0.15 * pumpOf(G, a)) * (0.6 + 0.4 * G.lk);
      var sector = TAU / folds;
      var unit = Math.max(1, M / 600);
      var calm = 1 - k;
      // The heart, the leading note's colour, brighter by an event's governed share.
      var heart = g.createRadialGradient(0, 0, 0, 0, 0, base * 2.4);
      // (Drawn as light over trails that keep about four fifths a frame: a small share adds up.)
      heart.addColorStop(0, hsla(G.A, G.S, G.L + 8, (0.06 + 0.12 * G.punch * G.flash) * G.ex));
      heart.addColorStop(0.4, hsla(G.A, G.S, G.L, (0.025 + 0.05 * G.punch * G.flash) * G.ex));
      heart.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = heart;
      g.fillRect(-base * 2.4, -base * 2.4, base * 4.8, base * 4.8);
      // The rays, one stroke per band across every sector, warm at the bass, cool at the treble.
      for (var i = 0; i < B; i += 2) {
        var v = knee(k * Math.pow(a.bands[i], 1.1) * (1 + 0.4 * Math.max(0, m.drive.mid))
          + (calm + 0.4) * (0.2 + 0.15 * Math.sin(G.beats * 0.45 + i * 0.3)));
        var off = (i / B) * sector / 2;
        var r1 = base + v * reach;
        g.beginPath();
        for (var kk = 0; kk < folds; kk++) {
          var c = kk * sector;
          g.moveTo(Math.cos(c + off) * base, Math.sin(c + off) * base);
          g.lineTo(Math.cos(c + off) * r1, Math.sin(c + off) * r1);
          g.moveTo(Math.cos(c - off) * base, Math.sin(c - off) * base);
          g.lineTo(Math.cos(c - off) * r1, Math.sin(c - off) * r1);
        }
        g.strokeStyle = hsla(G.H - 30 + (i / B) * 60 + tonal(a, i) * 20 * k, G.S, G.L - 6, (0.07 + v * 0.26) * G.ex * dip);
        g.lineWidth = (1 + v * 2.5 + m.rough * 1.5 * k) * unit;
        g.stroke();
      }
      // The petals' outline, through the tips.
      g.beginPath();
      for (var k2 = 0; k2 < folds; k2++) {
        var c2 = k2 * sector;
        for (var j = 0; j < B; j += 2) {
          var vv = clamp(k * a.bands[j] + calm * 0.3, 0, 1);
          var rr = base + vv * reach * 1.08, o = (j / B) * sector / 2;
          var x = Math.cos(c2 + o) * rr, y = Math.sin(c2 + o) * rr;
          if (k2 === 0 && j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        for (var j2 = B - 2; j2 >= 0; j2 -= 2) {
          var v2 = clamp(k * a.bands[j2] + calm * 0.3, 0, 1);
          var r2 = base + v2 * reach * 1.08, o2 = (j2 / B) * sector / 2;
          g.lineTo(Math.cos(c2 + sector - o2) * r2, Math.sin(c2 + sector - o2) * r2);
        }
      }
      g.closePath();
      g.strokeStyle = hsla(G.H + 35, G.S, G.L + 12, 0.45 * G.ex * dip);
      g.lineWidth = unit;
      g.stroke();
      // The ring of notes: twelve blooms (in fifths) in every sector, as large as each sounds.
      if (!s.notes) s.notes = new Float32Array(12);
      var ring = base * 1.9;
      for (var nt = 0; nt < 12; nt++) {
        var cv = a.chroma ? a.chroma[(nt * 7) % 12] || 0 : 0;
        s.notes[nt] = Math.max(cv * cv * k, s.notes[nt] * Math.exp(-G.dt / 0.5));
        if (s.notes[nt] < 0.04) continue;
        g.beginPath();
        for (var k3 = 0; k3 < folds; k3++) {
          var an = k3 * sector + (nt / 12) * sector;
          var bx = Math.cos(an) * ring, by = Math.sin(an) * ring, br = unit * (1.5 + 5 * s.notes[nt]);
          g.moveTo(bx + br, by); g.arc(bx, by, br, 0, TAU);
        }
        g.fillStyle = hsla(G.H + (nt - 1.5) * 6, G.S, G.L + 10, 0.5 * s.notes[nt] * G.ex * dip);
        g.fill();
      }
    }),

    // Starlane (after the AVS presets Winamp 5 shipped with): a starfield rushing past at the
    // tempo's pace, surging on the beat and streaking on a big event. The vanishing point leans
    // with the balance and drifts on a path each section draws anew; the width widens the
    // field. Low stars are large and warm, high ones small and pale; the hats make them twinkle.
    // Density sets the number of stars.
    starlane: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 170), m = G.m, w = p.width, h = p.height, k = G.k, M = Math.min(w, h);
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
      var path = G.beats / 16;
      var dv = lerp(m.prevVariant, m.variant, G.mix) * TAU;
      var cx = w / 2 + G.pan * w + Math.sin(path + dv) * M * 0.06 * G.mo;
      var cy = h / 2 + Math.sin(path * 1.3 + dv * 2) * M * 0.04 * G.mo;
      var f = Math.max(w, h) * 0.5, fx = f * (1 + 0.5 * G.spread);
      var dt = G.dt;
      var surge = 1 + (0.3 * Math.max(0, m.drive.energy) + 0.45 * Math.max(0, m.drive.level)
        + 0.9 * G.pulse - 0.25 * G.pre) * G.mo;
      var spd = (0.16 * q.speed * m.rate * surge + 1.1 * G.punch * G.mo) * dt * G.cap;
      var streak = spd * (1.5 + 3 * G.ek + 5 * G.punch * G.mo);
      // A glow at the vanishing point, the leading note's colour, as wide and bright as the passage
      // is exposed (the field stayed near black in 63-68 % of the frames, analysis pass 3).
      var glow = g.createRadialGradient(cx, cy, 0, cx, cy, f * (0.4 + 0.35 * G.ek));
      glow.addColorStop(0, hsle(G.A, G.S, G.L, (0.06 + 0.1 * G.ek + 0.2 * G.punch * G.flash) * G.ex));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      // Three depths by four pitches: twelve strokes a frame, whatever the count.
      for (var layer = 0; layer < 12; layer++) {
        var depth = layer % 3, tint = (layer / 3) | 0, ff = tint / 3;
        g.beginPath();
        for (var kk = 0; kk < count; kk++) {
          if (kk % 4 !== tint) continue;
          var o = kk * 3;
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
          var x1 = cx + s.stars[o] / nz * fx, y1 = cy + s.stars[o + 1] / nz * f;
          if (x1 < -20 || x1 > w + 20 || y1 < -20 || y1 > h + 20) { s.stars[o + 2] = 1; continue; }
          var z0 = nz + streak;
          g.moveTo(cx + s.stars[o] / z0 * fx, cy + s.stars[o + 1] / z0 * f);
          g.lineTo(x1, y1);
        }
        var band = bandAt(a, ff * 0.9 + 0.05);
        var twinkle = tint === 3 ? 0.35 * a.hat * k : 0;
        // Thin strokes on black were nearly black (a median luminance of 0.003 on real music):
        // the stars widen and brighten with the exposure, the ground stays black.
        g.strokeStyle = hsle(G.H - 25 + tint * 20, G.S * (1 - ff * 0.45), G.L + 8 + ff * 16,
          (0.55 + depth * 0.25 + twinkle) * G.ex);
        g.lineWidth = (0.7 + depth * 0.9) * (1.6 - ff * 0.8) * (1 + 1.2 * Math.pow(band, 1.5) * k)
          * (1 + 2 * G.ek) * (1 + 0.5 * G.pulse * G.mo);
        g.stroke();
      }
    }),

    // Rave (after Unchained): nested polygons of `symmetry` sides turning against each other in
    // a feedback that zooms with the bass on the beat; every two bars they all turn the other
    // way; a section draws them as stars instead. Each ring breathes with its part of the
    // spectrum, in the key's colours, the leading note's at the core.
    rave: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 290), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), k = G.k;
      var sides = Math.max(3, Math.round(q.symmetry));
      var dt = G.dt;
      var dir = k > 0 && Math.floor(G.bars / 2) % 2 ? -1 : 1;
      s.dir = lerp(dir, s.dir === undefined ? 1 : s.dir, Math.exp(-dt / 0.35));
      s.ang = (s.ang || 0) + dt * (0.15 * m.rate * G.amb + 0.8 * Math.max(0, m.drive.mid) + 1.1 * G.pulse) * s.dir * G.mo;
      // As flux: the light laid down follows the trail's clock-based fade, whatever the frame rate.
      var base = 0.55 + 0.38 * q.trails, keep = Math.pow(base, dt * 60), lay = Math.min(12, (1 - keep) / (1 - base));
      feedback(p, g, s, 1 + (0.008 * G.amb + (0.035 * Math.max(0, m.drive.bass) * G.pulse + 0.02 * G.punch) * G.mo) * G.cap,
        s.dir * 0.005 * G.cap, keep, 0);
      g.translate(w / 2 + G.pan * w * 0.6, h / 2);
      g.globalCompositeOperation = 'lighter';
      g.lineJoin = 'round';
      var unit = Math.max(1, M / 560);
      var star = sides >= 5 ? (G.mix > 0.5 ? vary(m, 2) : varied(m, 2)) + 1 : 1;
      var dip = 0.5 + 0.5 * Math.abs(G.mix * 2 - 1);
      for (var kk = 0; kk < 7; kk++) {
        var drive = kk < 2 ? m.drive.bass : kk < 5 ? m.drive.mid : m.drive.high;
        var rad = M * (0.05 + kk * 0.055) * (1 + (0.18 * Math.max(0, drive) + 0.35 * bandAt(a, kk / 6) * k) * G.mo);
        var turn = s.ang * (kk % 2 ? 1 : -1) * (1 + kk * 0.15);
        g.beginPath();
        for (var i = 0; i <= sides; i++) {
          var an = turn + (i * star % sides) / sides * TAU;
          var x = Math.cos(an) * rad, y = Math.sin(an) * rad * (1 - 0.15 * G.spread * (kk % 2));
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        var col = hsla(kk % 3 === 2 ? G.A : G.H - 27 + kk * 9, G.S, G.L, Math.min(1, 0.82 * G.ex * dip * lay));
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = (5 + 7 * m.halo) * unit;
        g.lineWidth = (1.2 + 2.6 * G.pulse + 0.8 * m.rough * k) * unit;
        g.stroke();
        if (kk === 0) {
          g.fillStyle = hsla(G.A, G.S, G.L, (0.1 + 0.3 * G.punch * G.flash) * G.ex);
          g.fill();
        }
      }
    }),

    // Ripple (after Zylot): rings sent out by every kick (wide, the key's colour) and snare
    // (thin, the leading note's), bent by the waveform as they spread at the tempo's pace,
    // rough when the sound is noisy; wide stereo sends the snares out left and right of a centre
    // placed by the balance; a section reshapes them (circles, hexagons, flowers). In silence
    // they come on a slow pulse.
    ripple: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 25), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), k = G.k;
      var P = 48, dt = G.dt;
      if (!s.r) {
        s.r = new Float32Array(P); s.al = new Float32Array(P); s.hu = new Float32Array(P);
        s.wd = new Float32Array(P); s.ox = new Float32Array(P); s.slot = 0; s.quiet = 1e9; s.side = 1;
      }
      function emit(width, alpha, hue, ox) {
        var i = s.slot = (s.slot + 1) % P;
        s.r[i] = M * 0.02; s.al[i] = alpha; s.wd[i] = width; s.hu[i] = hue; s.ox[i] = ox;
        s.quiet = 0;
      }
      if (k > 0 && a.beat) emit(2.6 + 2 * G.punch, 0.9, 0, 0);
      if (k > 0 && onset(s, 'sn', a.snare, 0.85, a)) emit(1.2, 0.75, 1, (s.side = -s.side) * G.spread * M * 0.35);
      s.quiet += dt;
      if (s.quiet > 1 / q.speed) emit(2.8, 0.8, 2, 0);
      fade(g, w, h, 0.22);
      g.translate(w / 2 + G.pan * w, h / 2);
      g.globalCompositeOperation = 'lighter';
      var maxR = Math.hypot(w, h) * 0.55;
      var seg = Math.round(40 + q.detail * 48);
      var quiet = 1 - Math.min(1, m.level);
      // The rings surge outwards on the beat, the kick and a big event, then coast (the beat barely
      // showed: they spread at one speed whatever the beat did).
      var grow = M * (0.2 + 0.3 * Math.max(0, m.drive.level) - 0.1 * quiet * k) * q.speed * m.rate * dt * (G.cap < 1 ? 0.35 : 1)
        * (0.7 + (1.6 * G.pulse + 1.2 * a.kick * k + 0.6 * G.punch) * G.mo);
      // The rings are as wide as the passage is exposed; the beat thickens them.
      var unit = Math.max(1, M / 600) * (0.8 + 1.3 * G.ek) * (1 + 0.6 * G.pulse * G.mo);
      var SH = [0, 6, 5], amp0 = [0, 0.05, 0.1];
      var lobes = lerp(SH[varied(m, 3)], SH[vary(m, 3)], G.mix > 0.5 ? 1 : 0);
      var lobeAmp = lerp(amp0[varied(m, 3)], amp0[vary(m, 3)], G.mix);
      var wl = a.wave.length - 1;
      for (var i = 0; i < P; i++) {
        if (s.al[i] <= 0) continue;
        s.r[i] += grow * (1 + s.r[i] / maxR);
        s.al[i] -= dt * (0.32 + 0.4 * quiet * k) * (G.cap < 1 ? 0.4 : 1);
        if (s.r[i] > maxR) s.al[i] = 0;
        if (s.al[i] <= 0) continue;
        var bend = M * 0.03 * k * G.wg * (1 - s.r[i] / maxR);
        g.beginPath();
        for (var j = 0; j < seg; j++) {
          var an = j / seg * TAU;
          // A symmetric index into the waveform: the ring closes without a seam.
          var wi = Math.floor((0.5 - 0.5 * Math.cos(an * 2 + i)) * wl);
          var rad = s.r[i] * (1 + lobeAmp * Math.cos(an * lobes + i)) + a.wave[wi] * bend
            + (j % 2 ? 1 : -1) * m.rough * k * unit * 2.5;
          var x = s.ox[i] + Math.cos(an) * rad, y = Math.sin(an) * rad;
          if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        var hue = s.hu[i] === 0 ? G.H : s.hu[i] === 1 ? G.A : G.H + 30;
        // A soft halo as wide as the treble reaches and as bright as the passage is exposed (the
        // rings on black were near black in 58 % of the frames on techno, analysis pass 3), then
        // the ring itself.
        g.strokeStyle = hsle(hue, G.S, G.L, (0.1 + 0.14 * G.ek) * s.al[i] * G.ex);
        g.lineWidth = s.wd[i] * unit * (3 + 4 * m.halo);
        g.stroke();
        g.strokeStyle = hsle(hue, G.S, G.L + 14, s.al[i] * G.ex);
        g.lineWidth = s.wd[i] * unit;
        g.stroke();
      }
      var core = M * (0.015 + (0.05 * G.pulse + 0.012 * Math.max(0, m.drive.bass)) * G.mo);
      // The pool of light the rings rise from (added each frame over trails, so a small share).
      var pr = M * (0.14 + 0.14 * G.ek);
      var pool = g.createRadialGradient(0, 0, 0, 0, 0, pr);
      pool.addColorStop(0, hsle(G.H, G.S, G.L, (0.07 + 0.07 * G.ek + 0.05 * G.punch * G.flash) * G.ex));
      pool.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = pool;
      g.fillRect(-pr, -pr, pr * 2, pr * 2);
      g.beginPath();
      g.arc(0, 0, core, 0, TAU);
      g.fillStyle = hsla(G.H + 15, G.S, G.L + 6, (0.4 + 0.3 * G.punch * G.flash) * G.ex);
      g.fill();
    }),

    // Veil (after Aderrasi): curtains of aurora that the spectrum lifts, each a glowing ribbon
    // with light falling from it, in a fan of the key's colours; the beat lifts them gently, the
    // balance tilts them, a section changes their waves. Gentle by design: it is also the calm
    // picture behind pages.
    veil: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 120), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), k = G.k;
      s.drift = (s.drift || 0) + G.dt * 0.6 * m.rate * (q.speed || 1) * G.mo * G.amb;
      var t = s.drift;
      bg(g, w, h, 'rgba(2,4,12,0.2)');
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      var N = 36, unit = Math.max(1, M / 600);
      if (!s.ys) { s.ys = new Float32Array(N + 1); s.lift = new Float32Array(N + 1); }
      // The lift, each point its part of the spectrum and how far that band rises above its own
      // last seconds, followed (fast up, slower down).
      var drv = bandDrive(s, a, G.R, G.dt), B = a.bands.length;
      for (var i0 = 0; i0 <= N; i0++) {
        var target = bandAt(a, i0 / N) * k * (1 + 0.7 * Math.max(0, drv[Math.round(i0 / N * (B - 1))]));
        s.lift[i0] = lerp(target, s.lift[i0], Math.exp(-G.dt / (target > s.lift[i0] ? 0.06 : 0.35)));
      }
      var freq = lerp(5 + m.prevVariant * 4, 5 + m.variant * 4, G.mix);
      var rise = h * (0.03 * G.pulse + 0.012 * G.punch) * G.mo;
      for (var r = 0; r < 5; r++) {
        var hue = G.H + r * 14;
        for (var i = 0; i <= N; i++) {
          var f = i / N;
          s.ys[i] = h * (0.34 + r * 0.065)
            + Math.sin(f * freq + t * (0.35 + r * 0.11) + r) * h * 0.05
            + Math.sin(f * 2.3 - t * 0.21 + r * 2) * h * 0.035
            + (f - 0.5) * G.pan * h * 0.4
            - s.lift[i] * h * 0.18 - rise;
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
        curtain.addColorStop(0, hsla(hue, G.S, 55, (0.07 * q.glow + 0.03 * G.punch * G.flash) * G.ex));
        curtain.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = curtain;
        g.fill();
        g.restore();
        g.beginPath();
        g.moveTo(0, s.ys[0]);
        for (var kk = 1; kk < N; kk++) {
          var xa = kk / N * w, xb = (kk + 1) / N * w;
          g.quadraticCurveTo(xa, s.ys[kk], (xa + xb) / 2, (s.ys[kk] + s.ys[kk + 1]) / 2);
        }
        g.lineTo(w, s.ys[N]);
        g.strokeStyle = hsla(hue, G.S, 60, 0.06 * q.glow * G.ex);
        g.lineWidth = 26 * unit * (0.5 + q.glow * 0.5) * (0.8 + 0.4 * m.halo);
        g.stroke();
        g.strokeStyle = hsla(hue, G.S, 62, (0.14 * q.glow + 0.04) * G.ex);
        g.lineWidth = 9 * unit;
        g.stroke();
        g.strokeStyle = hsla(r === 4 ? G.A : hue, G.S, G.L + 12, (0.5 + 0.2 * Math.max(0, m.drive.level)) * G.ex);
        g.lineWidth = 1.4 * unit;
        g.stroke();
      }
    }),

    // Swarm (after Eo.S. and Phat): motes drifting on a flow field, faster with the music and
    // pushed out by a big event, turbulent when the sound changes, each group a part of the
    // spectrum (low motes large and warm, high ones small and pale), added as light; a section
    // draws a new field. Density is the number of motes. Also a calm background picture.
    swarm: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 0), m = G.m, w = p.width, h = p.height, k = G.k, M = Math.min(w, h);
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
      // The beat (and the kick heard on it) throws the motes out from the centre and the next one
      // draws them back in; a big event throws them further (the beat barely showed when it only
      // sped the drift).
      var speed = (0.5 * m.rate + 1.3 * Math.max(0, m.drive.level) + 2.2 * G.pulse) * G.mo
        * (q.speed || 1) * G.dt * 60;
      var push = (2.2 * G.punch + 5 * G.pulse + 4 * a.kick * k - 2.5 * G.pre) * G.mo * G.dt * 60;
      var ts = G.beats * 0.5;
      var fq = lerp(1 + m.prevVariant, 1 + m.variant, G.mix);
      var turb = 0.6 * Math.max(0, m.drive.flux);
      var cx = w / 2 + G.pan * w, cy = h / 2;
      for (var grp = 0; grp < 8; grp++) {
        var ff = grp / 7, b = bandAt(a, ff);
        // Motes a pixel or two wide were nearly black (0.01 on real music): they grow with the
        // exposure and swell on the beat, over the same dark ground.
        var size = (2 - ff * 0.8) * (1 + 1.4 * Math.pow(b, 1.5) * k) * (1 + 1.3 * G.ek)
          * (1 + (0.7 * G.pulse + 0.5 * a.kick * k) * G.mo);
        g.beginPath();
        for (var kk = grp; kk < count; kk += 8) {
          var o = kk * 2, x = s.xy[o], y = s.xy[o + 1];
          var ang = (Math.sin(x * 0.0035 * fq + ts * 0.21) + Math.cos(y * 0.004 / fq - ts * 0.17)
            + Math.sin((x + y) * 0.0021 + ts * 0.11)) * Math.PI + (Math.random() - 0.5) * turb;
          var dx = x - cx, dy = y - cy, dd = Math.max(1, Math.hypot(dx, dy)) / M;
          x += Math.cos(ang) * speed + dx / dd * push / M * 0.5;
          y += Math.sin(ang) * speed + dy / dd * push / M * 0.5;
          if (x < 0 || x > w || y < 0 || y > h) { x = Math.random() * w; y = Math.random() * h; }
          s.xy[o] = x; s.xy[o + 1] = y;
          g.rect(x, y, size, size);
        }
        var twinkle = grp > 5 ? 0.3 * a.hat * k : 0;
        g.fillStyle = hsla(G.H - 30 + grp * 8.5, G.S * (1 - ff * 0.4), G.L + ff * 14,
          (0.48 + 0.4 * b * k + twinkle) * G.ex);
        g.fill();
      }
    }),

    // Moire (after Telek): grids of lines turning past each other a little out of step, so the
    // interference makes shapes no grid holds. They rest almost still; the music turns them: a
    // nudge on every big event, a swing over the bar, a breath of the bass in their spacing.
    // The grids are the key's colours either side of it, the figure turning the other way the
    // leading note's; a section changes the figure (squares, circles, hexagons). Detail is the
    // density.
    moire: mode(function (p, g, a, s, q) {
      var G = look(s, q, a, 150), m = G.m, w = p.width, h = p.height, M = Math.min(w, h), k = G.k;
      bg(g, w, h, hsla(G.H + 220, 35, 2.5, 1));
      g.translate(w / 2 + G.pan * w * 0.5, h / 2);
      g.globalCompositeOperation = 'lighter';
      var D = Math.hypot(w, h) * 0.55;
      var sp = M / (10 + q.detail * 18);
      s.nudge = (s.nudge || 0) * Math.exp(-G.dt / 0.4) + G.punch * 0.02 * G.dt * 60 * G.mo;
      s.swing = (s.swing || 0) + G.dt * 0.25 * Math.max(0, m.drive.mid) * G.mo;
      // The grids turn as fast as the passage is loud, with a lurch on every beat: driven only by
      // the deviations (zero in a steady drop), they moved less the louder the music got. The
      // level is against its last seconds, so the exposure (G.lk) slows them in a quiet passage.
      s.turn = (s.turn || 0) + G.dt * 2 * m.rate * (q.speed || 1) * G.mo
        * (0.003 + 0.003 * (1 - k) + (0.006 * Math.min(1.5, m.level) * k + 0.03 * G.pulse) * (0.3 + 0.7 * G.lk));
      var th = s.turn + s.swing * 0.3;
      var bar = 0.02 * Math.sin(((a.bar || 0) + G.bars) * TAU / 2) * k * G.mo;
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
      // The lines as bold and bright as the passage is exposed (a loud drop sank into the dark).
      // A quiet passage still draws them visibly (52 % of the frames near black on rock, analysis
      // pass 3), and a dark hue (the violets) as bright as the rest.
      var ink = (0.42 + 0.2 * G.ek) * G.ex, lw = sp * (0.16 + 0.12 * G.ek);
      lines(th, sp, hsle(G.H - 25, G.S, G.L + 4, ink), lw);
      lines(th + 0.05 + bar + s.nudge, sp * (1 + 0.06 * Math.max(0, m.drive.bass) * G.mo),
        hsle(G.H + 25, G.S, G.L + 4, ink), lw);
      // The figure turning the other way, breathing with the mids.
      g.rotate(-th * 1.6 - s.nudge);
      var q2 = sp * (1.15 + 0.12 * Math.max(0, m.drive.mid) * G.mo);
      // Squares, circles (as 48-gons) or hexagons, one path.
      var fig = G.mix > 0.5 ? vary(m, 3) : varied(m, 3);
      var n = [4, 48, 6][fig], rot = n === 4 ? TAU / 8 : 0, rs = n === 4 ? Math.SQRT2 : 1;
      g.beginPath();
      for (var r = q2; r < D; r += q2) {
        g.moveTo(Math.cos(rot) * r * rs, Math.sin(rot) * r * rs);
        for (var e = 1; e <= n; e++) g.lineTo(Math.cos(rot + e * TAU / n) * r * rs, Math.sin(rot + e * TAU / n) * r * rs);
      }
      g.strokeStyle = hsla(G.A, G.S * 0.5, 85, (0.24 + 0.2 * a.hat * k) * G.ex * (0.5 + 0.5 * Math.abs(G.mix * 2 - 1)));
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
        s.vig.addColorStop(1, 'rgba(3,3,8,0.84)');
      }
      g.fillStyle = s.vig;
      g.fillRect(0, 0, cw, ch);
    }),
  };
})();
