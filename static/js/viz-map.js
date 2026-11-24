// The music-to-picture grammar every mode shares (static/js/viz-2d.js and static/js/viz-gl.js
// read it): one mapper per picture turns the frame's analysis (static/js/viz-audio.js) and the
// mode's live controls into the signals a mode draws with, so that every mode speaks the same
// visual language and none re-derives it.
//
// Its rules, in short (the research and its sources: the mapping grammar of 2026-11-23):
//   relative levels  every scalar is compared with its own last seconds, as MilkDrop does (1 is
//                    normal, below 0.7 quiet, above 1.3 loud), so a ballad and a brickwalled
//                    master both swing; `react` scales the swing only, never the resting picture.
//   envelopes        each feature has its attack and release (fast up, slower down), in seconds,
//                    independent of the frame rate.
//   colour           the palette's hue is the key on the circle of fifths (keys a fifth apart
//                    are neighbours), smoothed over seconds along the shorter arc, plus the hue
//                    control; its saturation is how clearly one key sounds, less for noise; the
//                    lightness follows the timbre's brightness; the leading note is the accent.
//   time             beat and bar give phase-locked shapes (a pulse after the beat, an
//                    anticipation before it); big events are latched for a quarter beat.
//   form             a new section of the song draws a new variant of the scene, crossfaded.
//   safety           brightness rides the slow loudness; impulses move, scale and colour, and
//                    their brightness share is cut to 0.3 once two flashes fell within a second
//                    (WCAG 2.3.1 allows three); reduced motion caps motion and turns impulses
//                    into colour.
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  /** One pole towards target, attack tauA and release tauR in seconds. */
  function follow(y, target, dt, tauA, tauR) {
    var tau = target > y ? tauA : tauR;
    return target + (y - target) * Math.exp(-dt / Math.max(1e-3, tau));
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  /** The hue (0..1) of a pitch class on the circle of fifths: C 0, G 1/12, D 2/12 ... */
  function fifths(pc) { return ((pc * 7) % 12) / 12; }
  /** a + the shorter turn towards b, by k (hues are circular). */
  function towards(a, b, k) {
    var d = ((b - a) % 1 + 1.5) % 1 - 0.5;
    return ((a + d * k) % 1 + 1) % 1;
  }
  /** A stable pseudo-random 0..1 from an integer (the variant of a section). */
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // The relative levels: [signal, attack, release, the analysis field it reads] of the fast
  // follower; the long average forgets over 4 s. The energy is the level followed slowly (the
  // analysis's own energy is already a slow average, and its average against itself read 1).
  var REL = [['bass', 0.02, 0.18, 'bass'], ['mid', 0.03, 0.25, 'mid'], ['high', 0.01, 0.12, 'high'],
    ['level', 0.05, 0.4, 'level'], ['flux', 0.03, 0.25, 'flux'], ['energy', 1, 3, 'level']];

  function create() {
    var st = {
      fast: /** @type {Record<string, number>} */ ({}), long: /** @type {Record<string, number>} */ ({}),
      hue: -1, accent: 0, sat: 0.5, light: 0.5, exposure: 0.4, flat: 0, roll: 0.5, width: 0, pan: 0,
      dyn: 0, punch: 0, latched: -10, section: -1, variant: 0, prevVariant: 0, flashes: /** @type {number[]} */ ([]),
      flashGain: 1, lastPunch: 0, heard: 0, silent: 0, peak: 0,
    };
    REL.forEach(function (r) { st.fast[r[0]] = 0; st.long[r[0]] = 0; });
    /** @type {SonicVizMap} */
    var M = {
      bass: 1, mid: 1, high: 1, level: 1, flux: 1, energy: 1,
      drive: { bass: 0, mid: 0, high: 0, level: 0, flux: 0, energy: 0 },
      hue: 0, sat: 0.5, light: 0.5, accent: 0, exposure: 0.4,
      rough: 0, halo: 0.5, pan: 0, spread: 0, contrast: 0,
      rate: 1, pulse: 0, pre: 0, barPulse: 0, punch: 0,
      variant: 0, prevVariant: 0, morph: 1, flashGain: 1, motion: 1, reduced: false,
    };

    /**
     * The frame's signals for one picture.
     * @param {SonicVizAnalysis} a @param {Record<string, number>} p the live controls
     * @returns {SonicVizMap}
     */
    function frame(a, p) {
      var dt = a.dt || 1 / 60;
      var react = p.react === undefined ? 1 : p.react;
      var calm = !!(reduced && reduced.matches);
      if (calm) react = Math.min(react, 0.5);
      var longK = 1 - Math.exp(-dt / 4);
      // The first 4 s of sound (again after 2 s of silence) warm the long averages up: they never
      // sit below the fast ones there. Seeded from the first frame, a quiet opening read 2-3 times
      // its normal for 10-20 s, so the picture drove hardest while the music was quietest
      // (measured on recordings, 2026-11-24).
      if ((a.level || 0) < 0.02) { st.silent += dt; if (st.silent > 2) st.heard = 0; }
      else { st.silent = 0; st.heard += dt; }
      var warm = st.heard < 4;
      REL.forEach(function (r) {
        var k = r[0];
        var x = /** @type {number} */ (a[/** @type {'bass'} */ (r[3])]) || 0;
        st.fast[k] = follow(st.fast[k], x, dt, r[1], r[2]);
        st.long[k] = st.long[k] > 0 ? st.long[k] + (x - st.long[k]) * longK : x;
        if (warm) st.long[k] = Math.max(st.long[k], st.fast[k]);
        var rel = st.fast[k] / Math.max(0.02, st.long[k]);
        M[/** @type {'bass'} */ (k)] = clamp(rel, 0, 3);
        M.drive[/** @type {'bass'} */ (k)] = clamp((rel - 1) * react, -1, 2);
      });

      // Colour: the key's root on the circle of fifths gives the hue (the analysis holds a key for
      // seconds; the chroma's own vector wandered 1-4 turns a minute), the chroma's vector how
      // clearly one key sounds; without a key (the clock, silence, drums) the hue rests.
      var cx = 0, cy = 0, sum = 0;
      var chroma = a.chroma || [];
      for (var i = 0; i < chroma.length; i++) {
        var w = chroma[i] * chroma[i];
        var ang = fifths(i) * Math.PI * 2;
        cx += w * Math.cos(ang); cy += w * Math.sin(ang); sum += w;
      }
      var clarity = sum > 1e-3 ? Math.sqrt(cx * cx + cy * cy) / sum : 0;
      var keyHue = a.keyStrength > 0.3 ? fifths(a.key || 0) : -1;
      if (st.hue < 0) st.hue = keyHue >= 0 ? keyHue : 0;
      else if (keyHue >= 0) st.hue = towards(st.hue, keyHue, 1 - Math.exp(-dt / 3));
      if (chroma.length && a.keyStrength > 0.2) st.accent = towards(st.accent, fifths(a.pitch || 0), 1 - Math.exp(-dt / 0.6));
      // Minor keys and noise are less saturated; a clear key in tune is fully so.
      var satTarget = clamp(0.45 + 0.55 * clarity - (a.minor ? 0.12 : 0) - 0.35 * Math.sqrt(a.flatness || 0), 0.15, 1);
      st.sat = follow(st.sat, satTarget, dt, 0.4, 1.2);
      st.light = follow(st.light, clamp(a.centroid || 0, 0, 1), dt, 0.1, 0.5);
      // Brightness rides the slow loudness only (impulses never flash the whole screen), read
      // against the song's own recent peak: at the peak 1, 18 dB under it 0.4 (a brickwalled
      // master's 8 dB break moved an absolute exposure from 1.00 to 0.90 only). The peak falls
      // 0.4 dB a second, so a quieter song comes up to its own full light within a minute.
      var loud = clamp((a.loudness === undefined ? a.level : a.loudness) || 0, 0, 1);
      st.peak = Math.max(loud, st.peak - dt * 0.4 / 54);
      var expo = clamp(1 - (st.peak - loud) / (18 / 54), 0.4, 1) * clamp(loud / 0.08, 0, 1);
      st.exposure = follow(st.exposure, expo, dt, 0.05, 0.4);
      st.flat = follow(st.flat, Math.sqrt(clamp(a.flatness || 0, 0, 1)), dt, 0.15, 0.6);
      st.roll = follow(st.roll, clamp(a.rolloff === undefined ? a.centroid : a.rolloff, 0, 1), dt, 0.1, 0.5);
      st.width = follow(st.width, clamp(a.width || 0, 0, 1), dt, 0.2, 0.8);
      st.pan = follow(st.pan, clamp(a.balance || 0, -1, 1) * 0.25, dt, 0.1, 0.4);
      st.dyn = follow(st.dyn, clamp(a.dynamics || 0, 0, 1), dt, 0.5, 2);
      var hueParam = (p.hue || 0) / 360;
      // A new section turns the palette by up to 30 degrees, crossfaded with the scene.
      var turn = ((st.prevVariant - 0.5) + (st.variant - st.prevVariant) * (1 - clamp(a.change || 0, 0, 1))) * 2 / 12;
      M.hue = ((st.hue + hueParam + turn) % 1 + 1) % 1;
      M.accent = ((st.accent + hueParam) % 1 + 1) % 1;
      M.sat = st.sat;
      M.light = st.light;
      M.exposure = st.exposure;
      M.rough = st.flat;
      M.halo = st.roll;
      M.spread = st.width;
      M.pan = calm ? 0 : st.pan;
      M.contrast = st.dyn;

      // Time: the tempo sets the pace (120 bpm is 1); beat and bar give phase-locked shapes.
      M.rate = clamp((a.bpm || 120) / 120, 0.6, 1.6);
      var phase = a.phase || 0;
      M.pulse = Math.exp(-6 * phase);
      M.pre = smoothstep(0.85, 1, phase);
      M.barPulse = Math.exp(-4 * (a.bar || 0));
      // A big event fires on the kick or the beat, whichever comes first, latched for a quarter
      // beat; louder for punchy (dynamic) music than for a compressed master.
      var beatLen = 60 / (a.bpm || 120);
      if ((a.beat || a.kick > 0.95) && a.t - st.latched > beatLen / 4) {
        st.latched = a.t;
        st.punch = 0.6 + 0.4 * st.dyn;
        st.flashes.push(a.t);
      }
      st.punch *= Math.exp(-dt / 0.15);
      M.punch = st.punch * (calm ? 0.35 : 1);
      // The flashes of the last second, the window just under it: beats exactly half a second apart
      // (two a second) put three onsets at 0, 0.5 and 1.0 s, which is not three within a second.
      while (st.flashes.length && a.t - st.flashes[0] > 0.98) st.flashes.shift();
      // At most three flashes a second: past two, an impulse's brightness share drops to 0.3 at
      // once (50 ms) and comes back slowly (0.6 s). follow() takes the rise's time first: here
      // that is the recovery.
      st.flashGain = follow(st.flashGain, st.flashes.length > 2 ? 0.3 : 1, dt, 0.6, 0.05);
      M.flashGain = calm ? Math.min(0.2, st.flashGain) : st.flashGain;

      // Form: a new section draws a new variant, crossfaded by the change envelope.
      var section = a.section || 0;
      if (section !== st.section) {
        st.prevVariant = st.section < 0 ? hash(section) : st.variant;
        st.variant = hash(section);
        st.section = section;
      }
      M.variant = st.variant;
      M.prevVariant = st.prevVariant;
      M.morph = 1 - clamp(a.change || 0, 0, 1);
      M.motion = calm ? 0.35 : 1;
      M.reduced = calm;
      return M;
    }
    return { frame: frame, map: M };
  }

  window.SonicVizMap = { create: create, fifths: fifths };
})();
