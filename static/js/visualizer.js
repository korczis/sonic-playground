// The visualiser: 25 pictures of what is playing, each an original homage to one Winamp-era
// visualisation, as one component that mounts in any element marked [data-visualizer] (the
// landing hero), behind every page while music plays, and full screen on request.
//
// The modes are one list, data/visualizer.json (embedded by templates/partials/visualizer.html as
// #viz-conf): each has an engine, p5 (static/js/viz-2d.js) or gl (three.js, static/js/viz-gl.js),
// a p5 fallback for a browser without WebGL 2, and the live controls (parameters) it offers. Both
// engines and their libraries load on demand, only when a mode of theirs is shown.
//
// Where the sound comes from. The player is a YouTube iframe on another origin, so the page
// cannot read its audio. There are three sources, and the controls always say which one is
// active:
//   tab   the reader shares this tab with its audio (getDisplayMedia); the picture follows the
//         music exactly. Chrome and Edge on a computer, and only after the reader agrees.
//   mic   the microphone (getUserMedia); the picture follows the sound in the room. Phones too.
//   clock no audio: the picture follows the player's state and time only (moving at 120 bpm
//         while it plays, resting while it is paused), and says so.
// Nothing asks for a permission by itself: the reader presses "Follow the music" (the tab on a
// computer that can share one, the microphone elsewhere) or chooses a source in the settings.
//
// The sound is analysed once per frame into features every mode reads (SonicVizAnalysis in
// types/sonic.d.ts): 48 log-spaced bands with automatic gain, the waveform, level and the three
// ranges, onsets of the kick, snare and hi-hat ranges (spectral flux over an adaptive threshold)
// as decaying envelopes, the overall flux and spectral centroid, a tempo from the kicks'
// intervals with the position in the beat, and the loudness of the last seconds. That is the
// "colour music": every mode is a function of these features and of its parameters.
//
// Fullscreen: SonicVisualizer.open() lays the picture over the page below the player (z 35,
// under the queue and panels at 40 and the bar at 50), with no chrome; it closes the queue and
// makes the page under it inert. Moving the pointer or pressing a key shows a small cluster for a
// few seconds; the modes, the live controls and the sources wait behind settings, a sheet whose
// height is bounded by the video and the bar, so it never covers the playing video. Cinema moves
// the video to fill the screen above the bar, the picture around it and its colour glowing at the
// video's edge, never over it (YouTube's terms forbid covering the player). Escape closes the
// topmost layer; the arrow keys change the mode; C toggles cinema; F asks the browser for real
// fullscreen; focus returns to the opener. Reduced motion: a calm mode, slowed, that never
// changes by itself.
//
// The URL is the state (everything shareable): ?viz=<mode>, viz.<param>=<value> for every live
// control away from its default, viz.video=cinema; the player adds play=<track>&t=<seconds>
// (static/js/player.js). "Copy link" copies exactly that.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var body = document.body;
  var html = document.documentElement;
  var CONF = readConf();
  var MODES = CONF.modes.map(function (m) { return m.id; });
  /** @type {Record<string, {id: string, engine: string, group: string, params: string[], fallback?: string, defaults?: Record<string, number>}>} */
  var BY = {};
  CONF.modes.forEach(function (m) { BY[m.id] = m; });
  var PARAMS = CONF.params;
  var CALM = CONF.calm;
  var STORE = 'sonic.visualizer';
  var BANDS = 48;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!MODES.length) return;

  function readConf() {
    var node = document.getElementById('viz-conf');
    try {
      return JSON.parse(node ? node.textContent || '' : '');
    } catch (e) {
      return { modes: [], params: {}, aliases: {}, calm: '', background: [] }; // untested: every built page embeds a valid #viz-conf (test_visualizer.py)
    }
  }
  /** A mode's id, an old id (?viz=tunnel) mapped to its successor, or null. */
  function resolve(id) {
    if (!id) return null;
    var m = CONF.aliases[id] || id;
    return BY[m] ? m : null;
  }

  /** @returns {{mode: string, cycle: boolean, bg: boolean, cinema: boolean, params: Record<string, Record<string, number>>}} */
  function prefs() {
    try {
      var p = JSON.parse(localStorage.getItem(STORE) || '{}');
      return { mode: resolve(p.mode) || MODES[0], cycle: p.cycle !== false, bg: p.bg !== false,
        cinema: p.cinema === true, params: p.params && typeof p.params === 'object' ? p.params : {} };
    } catch (e) {
      return { mode: MODES[0], cycle: true, bg: true, cinema: false, params: {} };
    }
  }
  function savePrefs(p) {
    try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (e) { /* private window */ }
  }

  /** Every parameter at the mode's default. */
  function defaults(mode) {
    var own = (BY[mode] && BY[mode].defaults) || {};
    /** @type {Record<string, number>} */
    var out = {};
    Object.keys(PARAMS).forEach(function (k) { out[k] = k in own ? own[k] : PARAMS[k].default; });
    return out;
  }
  function clampParam(k, v) {
    var d = PARAMS[k];
    if (!d || typeof v !== 'number' || !isFinite(v)) return null;
    return Math.min(d.max, Math.max(d.min, v));
  }
  /**
   * The mode's defaults, then the reader's saved values, then any overrides. A shared link passes
   * shared: its picture is the sender's (the defaults and the link's own controls), never mixed
   * with the reader's saved values (an independent review, 2026-11-22).
   */
  function paramsFor(mode, overrides, shared) {
    var out = defaults(mode);
    var saved = shared ? {} : prefs().params[mode] || {};
    [saved, overrides || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) {
        var v = clampParam(k, Number(src[k]));
        if (v !== null && BY[mode].params.indexOf(k) >= 0) out[k] = v;
      });
    });
    return out;
  }

  // ---- The sound: one analysis per frame, shared by every sketch. -----------------------------

  /** @type {SonicVizAnalysis} */
  var A = {
    bands: new Float32Array(BANDS), wave: new Float32Array(256),
    level: 0, bass: 0, mid: 0, high: 0, kick: 0, snare: 0, hat: 0, beat: false,
    flux: 0, centroid: 0, bpm: 0, phase: 0, energy: 0, t: 0, dt: 1 / 60, source: 'clock',
  };
  var audio = { ctx: null, analyser: null, stream: null, freq: null, time: null, kind: 'clock' };
  // An onset detector per range: the positive spectral flux of its bands over an adaptive
  // threshold (running mean plus 1.5 standard deviations), at most one onset per `gap` seconds;
  // its envelope decays with `tau`.
  function detector(lo, hi, gap, tau) {
    return { lo: lo, hi: hi, gap: gap, tau: tau, mean: 0, vari: 0.0004, last: -10 };
  }
  var dsp = {
    raw: new Float32Array(BANDS), prev: new Float32Array(BANDS), peak: 0.25,
    kick: detector(0, 6, 0.22, 0.16), snare: detector(8, 22, 0.14, 0.12),
    hat: detector(28, 48, 0.08, 0.06),
    kicks: /** @type {number[]} */ ([]), period: 0.5, lastKick: -10,
    clock: { playing: false, base: 0, at: 0, beat: -1, half: -1 },
  };

  function playing() { return html.getAttribute('data-player-state') === 'playing'; }

  // The player saves its time every few seconds; between saves the clock runs on its own.
  function syncClock() {
    var now = performance.now() / 1000;
    var on = playing();
    var t = 0;
    try { t = window.SonicPlayer ? window.SonicPlayer.state().time || 0 : 0; } catch (e) { t = 0; }
    var c = dsp.clock;
    if (on !== c.playing || Math.abs(t - clockTime()) > 6) {
      dsp.clock = { playing: on, base: on ? t : clockTime(), at: now, beat: c.beat, half: c.half };
    }
  }
  function clockTime() {
    var c = dsp.clock;
    return c.playing ? c.base + (performance.now() / 1000 - c.at) : c.base;
  }

  /** Stop listening and return to the clock. */
  function stopAudio() {
    if (audio.stream) audio.stream.getTracks().forEach(function (tr) { tr.stop(); });
    audio.stream = null;
    audio.analyser = null;
    audio.kind = 'clock';
    dsp.kicks = [];
    A.bpm = 0;
    announce();
  }

  /** @param {'tab' | 'mic'} kind */
  function listen(kind) {
    var md = navigator.mediaDevices;
    if (!md) return Promise.reject(new Error('unsupported'));
    var ask = kind === 'tab'
      ? (md.getDisplayMedia ? md.getDisplayMedia(/** @type {any} */ ({ video: true, audio: true, preferCurrentTab: true }))
        : Promise.reject(new Error('unsupported')))
      : md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    return ask.then(function (stream) {
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(function (tr) { tr.stop(); });
        throw new Error('no-audio');
      }
      // Only the sound is wanted; the shared picture is dropped at once.
      stream.getVideoTracks().forEach(function (tr) { tr.stop(); });
      if (audio.stream) audio.stream.getTracks().forEach(function (tr) { tr.stop(); });
      var AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      audio.ctx = audio.ctx || new AC();
      if (audio.ctx.state === 'suspended') audio.ctx.resume();
      var an = audio.ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.6;
      an.minDecibels = -90;
      an.maxDecibels = -20;
      audio.ctx.createMediaStreamSource(stream).connect(an);
      audio.analyser = an;
      audio.freq = new Uint8Array(an.frequencyBinCount);
      audio.time = new Uint8Array(an.fftSize);
      audio.stream = stream;
      audio.kind = kind;
      dsp.peak = 0.25;
      stream.getAudioTracks()[0].addEventListener('ended', stopAudio);
      announce();
    });
  }
  /** The source "Follow the music" asks for: the tab where a computer can share one, else the mic. */
  function bestSource() {
    var md = navigator.mediaDevices;
    var phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // Only Chromium shares a tab's audio; Firefox and Safari would ask for a silent screen.
    var brands = /** @type {any} */ (navigator).userAgentData ? /** @type {any} */ (navigator).userAgentData.brands || [] : [];
    var chromium = brands.some(function (b) { return /Chromium/.test(b.brand); });
    return md && md.getDisplayMedia && !phone && chromium ? 'tab' : 'mic';
  }

  var analysedAt = -1;
  /** @returns {SonicVizAnalysis} */
  function analyse() {
    var now = performance.now();
    if (analysedAt >= 0 && now - analysedAt < 4) return A; // the sketches of one frame share it
    var dt = analysedAt < 0 ? 1 / 60 : Math.min(0.1, (now - analysedAt) / 1000);
    analysedAt = now;
    A.t = now / 1000;
    A.dt = dt;
    A.source = audio.analyser ? /** @type {'tab' | 'mic'} */ (audio.kind) : 'clock';
    A.beat = false;
    if (audio.analyser) fromAudio(dt); else fromClock();
    features(dt, now / 1000, !audio.analyser);
    return A;
  }

  function fromAudio(dt) {
    var an = audio.analyser;
    an.getByteFrequencyData(audio.freq);
    an.getByteTimeDomainData(audio.time);
    var n = audio.freq.length;
    var nyquist = audio.ctx.sampleRate / 2;
    var top = 0;
    // Log-spaced bands from 40 Hz to 16 kHz, so the bass is not one bar among a thousand.
    for (var i = 0; i < BANDS; i++) {
      var lo = 40 * Math.pow(400, i / BANDS);
      var hi = 40 * Math.pow(400, (i + 1) / BANDS);
      var a = Math.max(1, Math.floor(lo / nyquist * n));
      var z = Math.max(a + 1, Math.ceil(hi / nyquist * n));
      var peak = 0;
      for (var k = a; k < z && k < n; k++) peak = Math.max(peak, audio.freq[k]);
      var v = Math.pow(peak / 255, 1.6);
      dsp.raw[i] = v;
      if (v > top) top = v;
    }
    // Automatic gain: the loudest band of the last seconds reaches about 0.9, so a quiet room
    // (the microphone) moves the picture as much as a loud tab. The peak falls with a 3 s half-life.
    dsp.peak = Math.max(top, dsp.peak * Math.pow(0.5, dt / 3), 0.08);
    var gain = 0.9 / dsp.peak;
    for (var j = 0; j < BANDS; j++) {
      var target = Math.min(1, dsp.raw[j] * gain);
      var b = A.bands[j];
      A.bands[j] = b + (target - b) * (target > b ? 0.65 : 0.22);
    }
    var step = audio.time.length / A.wave.length;
    var rms = 0;
    for (var w = 0; w < A.wave.length; w++) {
      var s = (audio.time[Math.floor(w * step)] - 128) / 128;
      A.wave[w] = s;
      rms += s * s;
    }
    // The waveform is gained like the bands, so a quiet source still draws a shape.
    var wg = Math.min(6, 0.5 / Math.max(0.02, Math.sqrt(rms / A.wave.length)));
    for (var x = 0; x < A.wave.length; x++) A.wave[x] = Math.max(-1, Math.min(1, A.wave[x] * wg));
  }

  // No sound to read: a calm, honest motion driven by the player's time at 120 bpm while it
  // plays (a kick on every beat, a snare on two and four, hats on the eighths), settling to a slow
  // drift when it is paused or stopped. The onsets are scheduled, not detected.
  function fromClock() {
    syncClock();
    var c = dsp.clock;
    var on = c.playing;
    var t = clockTime();
    var drift = performance.now() / 1000;
    var beat = Math.floor(t * 2);
    var half = Math.floor(t * 4);
    if (on && beat !== c.beat) { c.beat = beat; onset('kick', A.t); if (beat % 2) onset('snare', A.t); }
    if (on && half !== c.half) { c.half = half; onset('hat', A.t); }
    var gain = on ? 0.6 : 0.3;
    for (var i = 0; i < BANDS; i++) {
      var f = i / BANDS;
      var shape = (1 - f) * 0.75 + 0.25;
      var wobble = 0.5 + 0.5 * Math.sin(drift * (0.6 + f * 2.3) + i * 0.7)
        * Math.cos(drift * 0.37 + i * 1.3);
      var hit = i < 8 ? A.kick * 0.5 : i < 28 ? A.snare * 0.25 : A.hat * 0.3;
      var v = gain * shape * (0.35 + 0.65 * wobble) + (on ? hit : 0);
      A.bands[i] = A.bands[i] * 0.7 + Math.min(1, v) * 0.3;
    }
    for (var j = 0; j < A.wave.length; j++) {
      var x = j / A.wave.length;
      A.wave[j] = gain * (Math.sin(x * 12 + drift * 3) * 0.6 + Math.sin(x * 31 - drift * 5) * 0.25)
        * (0.6 + A.kick * 0.8);
    }
    A.phase = on ? (t * 2) % 1 : 0;
  }

  /** @param {'kick' | 'snare' | 'hat'} name @param {number} t */
  function onset(name, t) {
    dsp[name].last = t;
    A[name] = reduced ? 0.35 : 1;
    if (name === 'kick') {
      A.beat = !reduced;
      if (audio.analyser) tempo(t);
    }
  }

  // The tempo: the median interval between the last kicks, folded into 75-180 bpm.
  function tempo(t) {
    var ks = dsp.kicks;
    ks.push(t);
    while (ks.length && t - ks[0] > 8) ks.shift();
    dsp.lastKick = t;
    if (ks.length < 4) return;
    var iv = [];
    for (var i = 1; i < ks.length; i++) {
      var d = ks[i] - ks[i - 1];
      while (d < 0.333) d *= 2;
      while (d > 0.8) d /= 2;
      iv.push(d);
    }
    iv.sort(function (a, b) { return a - b; });
    dsp.period = dsp.period * 0.7 + iv[iv.length >> 1] * 0.3;
    A.bpm = Math.round(60 / dsp.period);
  }

  /** @param {number} dt @param {number} t @param {boolean} clock */
  function features(dt, t, clock) {
    var b = A.bands;
    var sum = 0, bass = 0, mid = 0, high = 0, moment = 0, flux = 0;
    for (var i = 0; i < BANDS; i++) {
      var v = b[i];
      sum += v;
      moment += v * i;
      flux += Math.max(0, v - dsp.prev[i]);
      if (i < 8) bass += v; else if (i < 28) mid += v; else high += v;
    }
    A.level = sum / BANDS;
    A.bass = bass / 8;
    A.mid = mid / 20;
    A.high = high / (BANDS - 28);
    A.centroid = A.centroid * 0.8 + (sum > 0.01 ? moment / sum / (BANDS - 1) : 0) * 0.2;
    A.flux = A.flux * 0.6 + Math.min(1, flux / (BANDS * 0.08)) * 0.4;
    A.energy += (A.level - A.energy) * (1 - Math.exp(-dt / 4));
    ['kick', 'snare', 'hat'].forEach(function (name) {
      var d = dsp[name];
      if (d.last !== t) A[name] *= Math.exp(-dt / d.tau);
      if (clock) return;
      var f = 0, lvl = 0;
      for (var k = d.lo; k < d.hi; k++) { f += Math.max(0, b[k] - dsp.prev[k]); lvl += b[k]; }
      f /= d.hi - d.lo;
      lvl /= d.hi - d.lo;
      var threshold = d.mean + 1.5 * Math.sqrt(d.vari) + 0.015;
      if (f > threshold && lvl > 0.08 && t - d.last > d.gap) onset(/** @type {'kick'} */ (name), t);
      var diff = f - d.mean;
      d.mean += 0.05 * diff;
      d.vari = 0.95 * (d.vari + 0.05 * diff * diff);
    });
    dsp.prev.set(b);
    if (!clock) {
      if (t - dsp.lastKick > 8) A.bpm = 0;
      A.phase = A.bpm ? ((t - dsp.lastKick) / dsp.period) % 1 : (t * 2) % 1;
    }
  }

  // ---- Engines and sketches. ---------------------------------------------------------------------

  /** @type {Record<string, Promise<unknown> | null>} */
  var loaders = {};
  function load(attr) {
    if (!loaders[attr]) {
      var src = body.getAttribute(attr);
      var p = src ? Sonic.script(src) : Promise.reject(new Error('no ' + attr));
      p.catch(function () { loaders[attr] = null; });
      loaders[attr] = p;
    }
    return loaders[attr];
  }
  function loadEngine(engine) {
    return engine === 'gl'
      ? load('data-three').then(function () { return load('data-viz-gl'); })
      : load('data-p5').then(function () { return load('data-viz-2d'); });
  }
  // WebGL 2 is asked once, before three.js is downloaded for nothing.
  var glState = /** @type {boolean | null} */ (null);
  function glOk() {
    if (glState === null) {
      try {
        var c = document.createElement('canvas');
        var g = /** @type {WebGL2RenderingContext | null} */ (c.getContext('webgl2'));
        glState = !!g;
        var lose = g && g.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { glState = false; }
    }
    return glState;
  }
  /** The mode that actually draws: a gl mode's p5 fallback where WebGL 2 is missing. */
  function effective(mode) {
    var m = BY[mode];
    return m.engine === 'gl' && !glOk() && m.fallback ? m.fallback : mode;
  }

  /**
   * A picture in an element. The returned handle changes the mode and its parameters and removes
   * the sketch. opt.modes: the modes the cycle walks (all by default); opt.slow: time runs at that
   * fraction (reduced motion); opt.onMode: told when the cycle changes the mode by itself;
   * opt.params: the first mode's parameters (a shared link's), else the reader's.
   * @param {HTMLElement} el
   * @param {{mode: string, cycle: boolean, fps: number, density: number, modes?: string[], slow?: number, params?: Record<string, number>, onMode?: (m: string) => void}} opt
   */
  function sketch(el, opt) {
    var ring = opt.modes && opt.modes.length ? opt.modes : MODES;
    var st = { mode: opt.mode, cycle: opt.cycle, started: performance.now(), visible: true, frames: 0,
      params: opt.params || paramsFor(opt.mode) };
    /** @type {SonicVizScratch} */
    var scratch = { t: 0, params: st.params };
    /** @type {{engine: string, set: (id: string) => void, remove: () => void, resize: () => void} | null} */
    var runner = null;
    var pending = /** @type {object | null} */ (null);
    var gone = false;
    var cycling = false;
    // A change of mode fades in from black rather than cutting, whatever the engine.
    var veil = document.createElement('div');
    veil.className = 'pointer-events-none absolute inset-0 bg-black';
    veil.style.opacity = '0';
    veil.setAttribute('aria-hidden', 'true');
    el.appendChild(veil);
    function flash() {
      veil.style.transition = 'none';
      veil.style.opacity = '1';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          veil.style.transition = 'opacity 600ms ease-out';
          veil.style.opacity = '0';
        });
      });
    }
    // A picture draws only while it is on screen.
    var seen = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      st.visible = entries[0].isIntersecting;
    }) : null;
    if (seen) seen.observe(el);
    var size = el.clientWidth + 'x' + el.clientHeight;
    var sized = 'ResizeObserver' in window ? new ResizeObserver(function () {
      var now = el.clientWidth + 'x' + el.clientHeight;
      if (now === size) return;
      size = now;
      scratch = { t: scratch.t, params: st.params };
      if (runner) runner.resize();
    }) : null;
    if (sized) sized.observe(el);

    /** One frame's bookkeeping, shared by both engines: null when nothing should be drawn. */
    function step() {
      if (gone || document.hidden || !st.visible) return null;
      var a = analyse();
      var age = (performance.now() - st.started) / 1000;
      if (st.cycle && age > 40 && !cycling) {
        cycling = true;
        var next = ring[(ring.indexOf(st.mode) + 1) % ring.length];
        // Not from inside the engine's own frame: the new mode may need the other engine.
        setTimeout(function () {
          cycling = false;
          if (gone) return;
          handle.mode(next);
          if (opt.onMode) opt.onMode(next);
        }, 0);
      }
      scratch.t = age * (opt.slow || 1);
      scratch.params = st.params;
      st.frames += 1;
      el.setAttribute('data-visualizer-frame', String(st.frames));
      return a;
    }

    function p5Runner(id) {
      var cur = id;
      var P5 = window.p5;
      var inst = new P5(function (p) {
        p.setup = function () {
          var c = p.createCanvas(el.clientWidth || 1, el.clientHeight || 1);
          c.elt.setAttribute('aria-hidden', 'true');
          c.elt.classList.add('block', 'h-full', 'w-full');
          p.pixelDensity(opt.density);
          p.colorMode(p.HSB, 360, 100, 100, 1);
          p.frameRate(opt.fps);
          p.background(0);
        };
        p.draw = function () {
          var a = step();
          var draw = window.SonicViz2D && window.SonicViz2D[cur];
          if (a && draw) draw(p, a, scratch);
        };
      }, el);
      return {
        engine: 'p5',
        set: function (next) { cur = next; if (inst.background) inst.background(0); },
        remove: function () { inst.remove(); },
        resize: function () {
          if (!inst.resizeCanvas) return;
          inst.resizeCanvas(el.clientWidth || 1, el.clientHeight || 1);
          inst.background(0);
        },
      };
    }

    function glRunner(id) {
      var h = window.SonicVizGL && window.SonicVizGL.mount(el, { density: opt.density, fps: opt.fps });
      if (!h) return null;
      h.set(id);
      var raf = 0;
      var last = 0;
      var gap = 1000 / opt.fps - 2;
      function loop(now) {
        raf = requestAnimationFrame(loop);
        if (now - last < gap) return;
        last = now;
        var a = step();
        if (a) h.frame(a, scratch);
      }
      raf = requestAnimationFrame(loop);
      return {
        engine: 'gl',
        set: function (next) { h.set(next); },
        remove: function () { cancelAnimationFrame(raf); h.remove(); },
        resize: function () { h.resize(); },
      };
    }

    function mount() {
      var id = effective(st.mode);
      var engine = BY[id].engine;
      el.setAttribute('data-visualizer-engine', engine);
      el.toggleAttribute('data-visualizer-fallback', id !== st.mode);
      if (runner && runner.engine === engine) { runner.set(id); return; }
      if (runner) runner.remove();
      runner = null;
      var token = {};
      pending = token;
      loadEngine(engine).then(function () {
        if (gone || pending !== token) return;
        pending = null;
        var made = engine === 'gl' ? glRunner(id) : p5Runner(id);
        if (!made) { glState = false; mount(); return; } // a context the probe allowed was refused
        runner = made;
        el.appendChild(veil); // above the new canvas
      }).catch(function () {
        if (gone || pending !== token) return;
        if (engine === 'gl') { glState = false; mount(); return; }
        el.setAttribute('data-visualizer-error', engine);
      });
    }

    var handle = {
      /** @param {string} m */
      mode: function (m) {
        var id = resolve(m);
        if (!id) return;
        st.mode = id;
        st.started = performance.now();
        st.params = paramsFor(id);
        scratch = { t: 0, params: st.params };
        el.setAttribute('data-visualizer-mode', id);
        flash();
        mount();
      },
      get: function () { return st.mode; },
      shown: function () { return effective(st.mode); },
      cycle: function (on) { st.cycle = on; st.started = performance.now(); },
      params: function () { return st.params; },
      /** @param {string} k @param {number} v */
      param: function (k, v) { var c = clampParam(k, v); if (c !== null) st.params[k] = c; },
      canvas: function () { return /** @type {HTMLCanvasElement | null} */ (el.querySelector('canvas')); },
      remove: function () {
        gone = true;
        if (seen) seen.disconnect();
        if (sized) sized.disconnect();
        if (runner) runner.remove();
        runner = null;
        veil.remove();
      },
    };
    el.setAttribute('data-visualizer-mode', st.mode);
    mount();
    return handle;
  }

  // ---- Fullscreen. ------------------------------------------------------------------------------

  var full = null;
  var hideTimer = 0;
  var opener = null;
  var cinema = false;

  function shell() { return document.getElementById('visualizer-full'); }
  function settings() { return document.getElementById('visualizer-settings'); }
  function isOpen() { var s = shell(); return !!s && !s.hidden; }
  // The names are composed from data/visualizer.json (scripts/i18n.py derives viz.mode.<id>).
  function label(mode) { var key = 'viz.mode.' + mode; return Sonic.t(key); }

  function showControls() {
    var s = shell();
    if (!s) return;
    s.setAttribute('data-controls', 'shown');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      var panel = settings();
      var busy = (panel && !panel.hidden) || (s.contains(document.activeElement) && document.activeElement !== s);
      if (!busy) s.setAttribute('data-controls', 'hidden');
    }, 2600);
  }

  // The visualiser's keys in the URL; every other component's keys (the player's play and t, the
  // explorer's filters) are kept. A slider moving writes at most four times a second.
  var urlTimer = 0;
  function setUrl() {
    clearTimeout(urlTimer);
    urlTimer = 0;
    var u = new URL(location.href);
    Array.from(u.searchParams.keys()).forEach(function (k) {
      if (k === 'viz' || k.indexOf('viz.') === 0) u.searchParams.delete(k);
    });
    if (full && isOpen()) {
      var m = full.get();
      u.searchParams.set('viz', m);
      var p = full.params();
      var d = defaults(m);
      BY[m].params.forEach(function (k) {
        if (Math.abs(p[k] - d[k]) > 1e-9) u.searchParams.set('viz.' + k, String(+p[k].toFixed(3)));
      });
      if (cinema) u.searchParams.set('viz.video', 'cinema');
    }
    var next = u.pathname + u.search + u.hash;
    if (next !== location.pathname + location.search + location.hash) {
      history.replaceState(history.state, '', next);
    }
  }
  function setUrlSoon() { if (!urlTimer) urlTimer = window.setTimeout(setUrl, 250); }

  /** Say something to assistive technology (and, when it matters, in the player's toast). */
  function say(text, toast) {
    var s = shell();
    var live = s && s.querySelector('[data-viz-live]');
    if (live) live.textContent = text;
    var bar = document.getElementById('player');
    if (toast && window.SonicPlayer && window.SonicPlayer.notify && bar && !bar.hidden) {
      window.SonicPlayer.notify(text);
    }
  }

  /** The page under the picture is out of reach while it is open; the player stays usable. */
  function setInert(on) {
    ['shell', 'main-content'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.toggleAttribute('inert', on);
    });
    var nav = document.querySelector('body > nav, nav[aria-label]');
    if (nav) nav.toggleAttribute('inert', on);
  }

  // Cinema: the video panel fills the screen above the bar (styles/app.css), the picture around
  // it, and the picture's colour glows at the video's edge, pulsing with the kick.
  var glowRaf = 0;
  var glowCanvas = /** @type {HTMLCanvasElement | null} */ (null);
  var glowAt = 0;
  function applyCinema() {
    var on = isOpen() && cinema;
    if (on) html.setAttribute('data-viz-video', 'cinema'); else html.removeAttribute('data-viz-video');
    var s = shell();
    if (s) {
      var b = s.querySelector('[data-viz-cinema]');
      if (b) b.setAttribute('aria-pressed', String(cinema));
      var sw = /** @type {HTMLInputElement | null} */ (s.querySelector('[data-viz-cinema-switch]'));
      if (sw) sw.checked = cinema;
    }
    cancelAnimationFrame(glowRaf);
    var panelEl = document.getElementById('player-panel');
    if (on) glowRaf = requestAnimationFrame(glow);
    else if (panelEl) { panelEl.style.removeProperty('--viz-glow'); panelEl.style.removeProperty('--viz-kick'); }
    if (window.SonicPlayer && window.SonicPlayer.placeToast) window.SonicPlayer.placeToast();
    requestAnimationFrame(function () { requestAnimationFrame(layoutSettings); });
  }
  function glow(now) {
    glowRaf = requestAnimationFrame(glow);
    var target = document.getElementById('player-panel');
    if (!target) return;
    target.style.setProperty('--viz-kick', A.kick.toFixed(2));
    if (now - glowAt < 125 || !full) return;
    glowAt = now;
    var c = full.canvas();
    if (!c || !c.width) return;
    if (window.SonicVisualizer.engine() === 'gl') {
      // Reading a WebGL frame back stalls the GPU, and Chrome says so in the console: a three.js
      // picture's glow follows its hue control (its palettes rotate by it) instead of its pixels.
      var hue = Math.round((280 + (full.params().hue || 0)) % 360);
      target.style.setProperty('--viz-glow', 'hsl(' + hue + ' 85% 62% / 0.55)');
      return;
    }
    if (!glowCanvas) { glowCanvas = document.createElement('canvas'); glowCanvas.width = 4; glowCanvas.height = 4; }
    var g = glowCanvas.getContext('2d', { willReadFrequently: true });
    try {
      g.drawImage(c, 0, 0, 4, 4);
      var d = g.getImageData(0, 0, 4, 4).data;
      var r = 0, gr = 0, bl = 0;
      for (var i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; bl += d[i + 2]; }
      var n = d.length / 4;
      // Lifted towards full brightness, so a dark frame still glows in its own hue.
      var m = Math.max(r, gr, bl, 1) / n;
      var k = Math.min(3, 200 / m);
      target.style.setProperty('--viz-glow', 'rgb(' + Math.round(r / n * k) + ' ' + Math.round(gr / n * k) + ' '
        + Math.round(bl / n * k) + ' / 0.55)');
    } catch (e) { /* a canvas the browser will not read: no glow */ }
  }
  function setCinema(on, quiet) {
    cinema = on;
    var p = prefs();
    p.cinema = on;
    savePrefs(p);
    applyCinema();
    setUrl();
    if (!quiet) say(on ? Sonic.t('viz.cinema_on') : Sonic.t('viz.cinema_off'), false);
  }

  /** @param {string=} mode @param {{params?: Record<string, number>, cinema?: boolean}=} shared */
  function open(mode, shared) {
    var s = shell();
    if (!s) return;
    var p = prefs();
    var explicit = resolve(mode || '');
    // Reduced motion: a calm mode, slowed, that never changes by itself.
    var m = explicit || (reduced ? CALM : p.mode);
    if (!isOpen()) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The queue would lie over the controls; the video panel stays where it is.
    if (window.SonicPlayer && window.SonicPlayer.queue) window.SonicPlayer.queue(false);
    s.hidden = false;
    html.setAttribute('data-visualizer', 'open');
    setInert(true);
    cinema = shared && typeof shared.cinema === 'boolean' ? shared.cinema : p.cinema;
    var stage = /** @type {HTMLElement} */ (s.querySelector('[data-visualizer-stage]'));
    if (full) full.mode(m);
    else {
      full = sketch(stage, {
        mode: m, cycle: p.cycle && !reduced, fps: reduced ? 24 : 60, slow: reduced ? 0.3 : 1,
        density: Math.min(1.5, window.devicePixelRatio || 1),
        params: shared && shared.params ? paramsFor(m, shared.params, true) : undefined,
        onMode: function (next) { setUrl(); syncControls(); announceMode(next); },
      });
    }
    applyCinema();
    syncControls();
    setUrl();
    s.focus();
    showControls();
    syncBackground();
  }

  function announceMode(mode) { say(Sonic.t('viz.status_mode', { name: label(mode) }), false); }

  function close() {
    var s = shell();
    if (!s || s.hidden) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    // A picture that fails to tear down still closes: the page is never left inert under it.
    var gone = full;
    full = null;
    try { if (gone) gone.remove(); } catch (e) { console.error('visualizer: close', e); }
    var panel = settings();
    if (panel) panel.hidden = true;
    html.removeAttribute('data-viz-settings');
    s.hidden = true;
    html.removeAttribute('data-visualizer');
    setInert(false);
    applyCinema();
    setUrl();
    syncBackground();
    // Focus returns to what opened it; opened from the queue (which it closed), to the queue's
    // button; otherwise to the nav's opener.
    var back = opener && document.contains(opener) ? opener : null;
    if (back && back.closest('#player-queue')) back = document.querySelector('[data-player-queue]');
    if (!back || back.offsetParent === null) back = document.querySelector('nav [data-visualizer-open]');
    opener = null;
    if (back instanceof HTMLElement) back.focus();
  }

  function choose(m) {
    var id = resolve(m);
    if (!full || !id) return;
    full.mode(id);
    var p = prefs();
    p.mode = id;
    savePrefs(p);
    setUrl();
    syncControls();
    announceMode(id);
  }
  function step(by) {
    if (full) choose(MODES[(MODES.indexOf(full.get()) + by + MODES.length) % MODES.length]);
  }

  // The settings sheet ends above the video when they share a column, and above the bar: it
  // never covers the playing video (measured, as the toast is: the video's box depends on the
  // screen, cinema and what is open).
  function layoutSettings() {
    var panel = settings();
    if (!panel || panel.hidden) return;
    panel.style.maxHeight = '';
    var box = panel.getBoundingClientRect();
    var limit = window.innerHeight;
    var bar = document.getElementById('player');
    if (bar && !bar.hidden) limit = Math.min(limit, bar.getBoundingClientRect().top);
    var video = document.getElementById('player-panel');
    if (video && !video.hidden) {
      var v = (video.firstElementChild || video).getBoundingClientRect();
      if (v.width && v.left < box.right && v.right > box.left && v.bottom > box.top) limit = Math.min(limit, v.top);
    }
    panel.style.maxHeight = Math.max(96, limit - box.top - 8) + 'px';
  }

  function toggleSettings(show) {
    var s = shell();
    var panel = settings();
    if (!s || !panel) return;
    var on = show === undefined ? panel.hidden : show;
    panel.hidden = !on;
    if (on) html.setAttribute('data-viz-settings', 'open'); else html.removeAttribute('data-viz-settings');
    var btn = s.querySelector('[data-viz-settings]');
    if (btn) btn.setAttribute('aria-expanded', String(on));
    if (on) {
      // Cinema makes room for the sheet beside the video on a wide screen (styles/app.css).
      layoutSettings();
      requestAnimationFrame(function () { requestAnimationFrame(layoutSettings); });
      var checked = /** @type {HTMLElement | null} */ (panel.querySelector('[data-viz-mode][aria-checked="true"]'));
      if (checked) checked.focus();
    } else if (btn instanceof HTMLElement) btn.focus();
    showControls();
  }

  // The controls reflect the state; the strings are interface keys (data/i18n).
  function syncControls() {
    var s = shell();
    if (!s) return;
    var mode = full ? full.get() : prefs().mode;
    var name = s.querySelector('[data-viz-name]');
    if (name) {
      name.setAttribute('data-i18n', 'viz.mode.' + mode);
      var text = label(mode);
      if (text !== 'viz.mode.' + mode) name.textContent = text;
    }
    s.querySelectorAll('[data-viz-mode]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-viz-mode') === mode));
    });
    // The radio pattern: one tab stop per group, the checked radio (the first when none is).
    s.querySelectorAll('[role=radiogroup]').forEach(function (g) {
      var radios = g.querySelectorAll('[role=radio]');
      var on = g.querySelector('[role=radio][aria-checked="true"]') || radios[0];
      radios.forEach(function (r) { r.setAttribute('tabindex', r === on ? '0' : '-1'); });
    });
    s.querySelectorAll('[data-viz-source]').forEach(function (b) {
      var kind = b.getAttribute('data-viz-source');
      if (kind === 'connect') /** @type {HTMLElement} */ (b).hidden = audio.kind !== 'clock';
      else b.setAttribute('aria-checked', String(kind === audio.kind));
    });
    // The live controls of this mode, in its order; the others wait hidden.
    var box = s.querySelector('[data-viz-params]');
    var values = full ? full.params() : paramsFor(mode);
    if (box) {
      s.querySelectorAll('[data-viz-param-row]').forEach(function (row) {
        /** @type {HTMLElement} */ (row).hidden = BY[mode].params.indexOf(row.getAttribute('data-viz-param-row')) < 0;
      });
      BY[mode].params.forEach(function (k) {
        var row = box.querySelector('[data-viz-param-row="' + k + '"]');
        if (!row) return;
        if (box.lastElementChild !== row) box.appendChild(row);
        var input = /** @type {HTMLInputElement} */ (row.querySelector('input'));
        if (document.activeElement !== input) input.value = String(values[k]);
        var out = row.querySelector('output');
        if (out) out.textContent = String(+values[k].toFixed(2));
      });
    }
    var fb = /** @type {HTMLElement | null} */ (s.querySelector('[data-viz-fallback]'));
    if (fb) fb.hidden = !full || full.shown() === mode;
    var cyc = /** @type {HTMLInputElement | null} */ (s.querySelector('[data-viz-cycle]'));
    if (cyc) cyc.checked = prefs().cycle && !reduced;
    var bgSwitch = /** @type {HTMLInputElement | null} */ (s.querySelector('[data-viz-bg]'));
    if (bgSwitch) { bgSwitch.checked = prefs().bg && !reduced; bgSwitch.disabled = reduced; }
    var status = s.querySelector('[data-viz-status]');
    if (status) {
      // data-i18n lets i18n.js translate it again when the bundle arrives or the language changes.
      var key = audio.kind === 'tab' ? 'viz.status_tab'
        : audio.kind === 'mic' ? 'viz.status_mic' : 'viz.status_clock';
      var said = audio.kind === 'tab' ? Sonic.t('viz.status_tab')
        : audio.kind === 'mic' ? Sonic.t('viz.status_mic') : Sonic.t('viz.status_clock');
      status.setAttribute('data-i18n', key);
      if (said !== key) status.textContent = said;
    }
    syncTempo();
  }
  function syncTempo() {
    var s = shell();
    var el = /** @type {HTMLElement | null} */ (s && s.querySelector('[data-viz-tempo]'));
    if (!el) return;
    el.hidden = !(audio.analyser && A.bpm);
    if (!el.hidden) el.textContent = Sonic.t('viz.tempo', { bpm: String(A.bpm) });
  }
  setInterval(function () { if (isOpen()) syncTempo(); }, 1000);
  function announce() {
    syncControls();
    var s = shell();
    var status = s && s.querySelector('[data-viz-status]');
    if (status && isOpen()) say(status.textContent, false);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else if (html.requestFullscreen) html.requestFullscreen().catch(function () {});
  }

  function share() {
    setUrl();
    var url = window.SonicPlayer && window.SonicPlayer.link ? window.SonicPlayer.link() : location.href;
    var done = function (ok) { say(ok ? Sonic.t('viz.copied') : Sonic.t('viz.copy_failed'), true); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  }

  /** @param {HTMLInputElement} input */
  function setParam(input) {
    if (!full) return;
    var k = input.getAttribute('data-viz-param');
    var mode = full.get();
    full.param(k, Number(input.value));
    var v = full.params()[k];
    var out = shell().querySelector('[data-viz-param-value="' + k + '"]');
    if (out) out.textContent = String(+v.toFixed(2));
    var p = prefs();
    p.params[mode] = p.params[mode] || {};
    p.params[mode][k] = v;
    savePrefs(p);
    setUrlSoon();
  }
  function resetParams() {
    if (!full) return;
    var mode = full.get();
    var p = prefs();
    delete p.params[mode];
    savePrefs(p);
    var d = defaults(mode);
    BY[mode].params.forEach(function (k) { full.param(k, d[k]); });
    syncControls();
    setUrl();
  }

  function wire() {
    var s = shell();
    if (!s || s.getAttribute('data-wired')) return;
    s.setAttribute('data-wired', '1');
    s.addEventListener('pointermove', showControls);
    s.addEventListener('focusin', showControls);
    s.addEventListener('click', function (e) {
      var t = /** @type {HTMLElement} */ (e.target);
      var btn = /** @type {HTMLElement | null} */ (t.closest('button'));
      if (!btn) { showControls(); return; }
      var mode = btn.getAttribute('data-viz-mode');
      var source = btn.getAttribute('data-viz-source');
      if (mode) choose(mode);
      else if (source === 'clock') stopAudio();
      else if (source === 'tab' || source === 'mic' || source === 'connect') {
        var kind = source === 'connect' ? bestSource() : source;
        // A refusal is said beside the buttons that asked, not in a toast over them.
        listen(/** @type {'tab' | 'mic'} */ (kind)).catch(function (err) {
          // A shared tab without its audio is not a refusal: follow the room instead.
          if (source === 'connect' && kind === 'tab' && err && err.message === 'no-audio') return listen('mic');
          throw err;
        }).catch(function () {
          var status = s.querySelector('[data-viz-status]');
          if (status) { status.setAttribute('data-i18n', 'viz.denied'); status.textContent = Sonic.t('viz.denied'); }
          say(Sonic.t('viz.denied'), source === 'connect');
        });
      } else if (btn.hasAttribute('data-viz-settings')) { toggleSettings(); return; }
      else if (btn.hasAttribute('data-viz-cinema')) setCinema(!cinema, false);
      else if (btn.hasAttribute('data-viz-share')) share();
      else if (btn.hasAttribute('data-viz-reset')) resetParams();
      else if (btn.hasAttribute('data-viz-fullscreen')) toggleFullscreen();
      else if (btn.hasAttribute('data-viz-close')) { close(); return; }
      syncControls();
      showControls();
    });
    s.addEventListener('input', function (e) {
      var t = /** @type {HTMLInputElement} */ (e.target);
      if (t.hasAttribute('data-viz-param')) setParam(t);
    });
    s.addEventListener('change', function (e) {
      var t = /** @type {HTMLInputElement} */ (e.target);
      var q = prefs();
      if (t.hasAttribute('data-viz-param')) { setParam(t); setUrl(); }
      else if (t.hasAttribute('data-viz-cinema-switch')) setCinema(t.checked, false);
      else if (t.hasAttribute('data-viz-cycle')) {
        q.cycle = t.checked;
        savePrefs(q);
        if (full) full.cycle(q.cycle && !reduced);
      } else if (t.hasAttribute('data-viz-bg')) {
        q.bg = t.checked;
        savePrefs(q);
        syncBackground();
      }
    });
  }

  // While it is open, one handler on the document, ahead of the player's: Escape closes the
  // topmost layer only (the queue, then the settings, then the picture), and the arrows, C and F
  // work wherever focus is, except in a field or on a slider. A key typed there is never taken.
  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    var t = /** @type {HTMLElement} */ (e.target);
    var field = t && t.closest && t.closest('input:not([type=checkbox]), textarea, select, [contenteditable="true"]');
    var queue = document.getElementById('player-queue');
    if (e.key === 'Escape') {
      if (queue && !queue.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      var panel = settings();
      if (panel && !panel.hidden) toggleSettings(false); else close();
      return;
    }
    if (field || e.metaKey || e.ctrlKey || e.altKey) return;
    if (t && t.closest && t.closest('#player, #player-queue')) return;
    // On a radio the arrows move within its own group and check what they reach (the ARIA radio
    // pattern); they never change the picture from the Sound group.
    var radio = t && t.closest && /** @type {HTMLElement | null} */ (t.closest('#visualizer-full [role=radio]'));
    if (radio && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      e.preventDefault();
      var group = /** @type {HTMLElement} */ (radio.closest('[role=radiogroup]'));
      var radios = Array.prototype.slice.call(group.querySelectorAll('[role=radio]'));
      var by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      var next = /** @type {HTMLElement} */ (radios[(radios.indexOf(radio) + by + radios.length) % radios.length]);
      next.focus();
      if (!next.hasAttribute('data-viz-source') || next.getAttribute('data-viz-source') === 'clock') next.click();
      showControls();
      return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setCinema(!cinema, false); }
    else return;
    showControls();
  }, true);

  // Any [data-visualizer-open] button opens the picture (the nav, the queue's tools, the hero).
  document.addEventListener('click', function (e) {
    var t = /** @type {HTMLElement} */ (e.target);
    var button = t.closest && t.closest('[data-visualizer-open]');
    if (!button) return;
    e.preventDefault();
    open(button.getAttribute('data-visualizer-open') || undefined);
  });

  // The router is about to push the next page's entry: the picture closes now, so the entry being
  // left keeps no viz keys and Back never reopens it (an independent review, 2026-11-22).
  Sonic.on('sonic:leaving', function () {
    if (!isOpen()) return;
    var keep = opener;
    close();
    opener = keep && document.contains(keep) ? keep : null;
  });
  // A navigation (the player's title, Back) changes the page under it: the picture closes first.
  Sonic.on('sonic:navigated', function () {
    if (!isOpen()) return;
    var keep = opener;
    close();
    opener = keep && document.contains(keep) ? keep : null;
  });
  window.addEventListener('resize', function () { if (isOpen()) layoutSettings(); });

  // ---- Behind every page while the player plays (the owner, 2026-11-16). --------------------
  // #visualizer-bg lies behind the page's content (styles/app.css blends it into the theme: as
  // darker tints on light, as light on dark) and draws a calm mode only while the player plays,
  // the switch in the settings is on, motion is welcome, the full screen is closed and the tab
  // is visible; it fades out otherwise and its sketch is removed once the fade is over.

  var bgHandle = null;
  var bgTimer = 0;
  function bgWanted() {
    return !reduced && prefs().bg && playing() && !isOpen() && !document.hidden;
  }
  function syncBackground() {
    var layer = document.getElementById('visualizer-bg');
    if (!layer) return;
    var want = bgWanted();
    html.toggleAttribute('data-visualizer-bg', want);
    clearTimeout(bgTimer);
    if (want && !bgHandle) {
      bgHandle = sketch(layer, { mode: CONF.background[0], cycle: true, modes: CONF.background, fps: 30, density: 1 });
    } else if (!want && bgHandle) {
      bgTimer = window.setTimeout(function () {
        if (bgHandle && !bgWanted()) { bgHandle.remove(); bgHandle = null; }
      }, 900);
    }
  }
  new MutationObserver(function () {
    syncBackground();
    if (isOpen()) layoutSettings();
  }).observe(html, { attributes: true, attributeFilter: ['data-player-state', 'data-player-panel-state', 'data-player-video-state'] });
  document.addEventListener('visibilitychange', syncBackground);

  // ---- Embedded pictures (the landing hero): a page module, so the router mounts it. ----------
  // [data-visualizer-modes] limits the modes it walks; [data-visualizer-media] the screens it is
  // drawn on (the libraries are large: the hero asks for wide screens only). It starts once the
  // page is idle.

  Sonic.module('visualizer', function mount() {
    var handles = [];
    var idle = /** @type {any} */ (window).requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
    var cancelled = false;
    if (reduced) return null;
    idle(function () {
      if (cancelled) return;
      document.querySelectorAll('#main [data-visualizer]').forEach(function (node) {
        var el = /** @type {HTMLElement} */ (node);
        var media = el.getAttribute('data-visualizer-media');
        if (media && !window.matchMedia(media).matches) return;
        var modes = (el.getAttribute('data-visualizer-modes') || '').split(/\s+/).map(resolve).filter(Boolean);
        var mode = resolve(el.getAttribute('data-visualizer')) || modes[0] || prefs().mode;
        handles.push(sketch(el, { mode: mode, cycle: el.hasAttribute('data-visualizer-cycle'), modes: modes, fps: 30, density: 1 }));
      });
    });
    return function unmount() {
      cancelled = true;
      handles.forEach(function (h) { h.remove(); });
    };
  });

  wire();
  syncBackground();
  // A shared link: ?viz=<mode>, its live controls and cinema.
  (function () {
    var q = new URL(location.href).searchParams;
    var asked = resolve(q.get('viz'));
    if (!asked) return;
    /** @type {Record<string, number>} */
    var params = {};
    Object.keys(PARAMS).forEach(function (k) {
      if (q.has('viz.' + k)) params[k] = Number(q.get('viz.' + k));
    });
    open(asked, { params: params, cinema: q.get('viz.video') === 'cinema' });
  })();

  window.SonicVisualizer = {
    modes: function () { return MODES.slice(); },
    open: function (mode) { open(mode); },
    close: close,
    mode: function () { return full ? full.get() : null; },
    shown: function () { return full ? full.shown() : null; },
    engine: function () {
      var st = document.querySelector('[data-visualizer-stage]');
      return full && st ? st.getAttribute('data-visualizer-engine') : null;
    },
    set: choose,
    params: function () { return full ? Object.assign({}, full.params()) : null; },
    param: function (k, v) {
      var s = shell();
      var input = /** @type {HTMLInputElement | null} */ (s && s.querySelector('[data-viz-param="' + k + '"]'));
      if (!full || !input) return;
      input.value = String(v);
      setParam(input);
      setUrl();
    },
    cinema: function (on) { if (typeof on === 'boolean') setCinema(on, true); return cinema && isOpen(); },
    analysis: function () {
      return { level: A.level, kick: A.kick, flux: A.flux, centroid: A.centroid, bpm: A.bpm, source: A.source };
    },
    source: function () { return audio.kind; },
    listen: listen,
    stop: stopAudio,
    background: function () { return !!bgHandle && html.hasAttribute('data-visualizer-bg'); },
  };
})();
