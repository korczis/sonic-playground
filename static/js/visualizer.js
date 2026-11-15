// The visualiser: Winamp/MilkDrop-style pictures of what is playing, as one component that mounts
// in any element marked [data-visualizer] (the landing hero) and fills the screen on request.
//
// Where the sound comes from. The player is a YouTube iframe on another origin, so the page
// cannot read its audio. There are three sources, and the controls always say which one is
// active:
//   tab   the reader shares this tab with its audio (getDisplayMedia); the picture follows the
//         music exactly. Chrome and Edge only, and only after the reader agrees.
//   mic   the microphone (getUserMedia); the picture follows the sound in the room.
//   clock no audio: the picture follows the player's state and time only (moving while it
//         plays, resting while it is paused), and says so.
// Nothing asks for a permission by itself: the reader opens the controls and chooses.
//
// The picture is drawn with p5 (loaded on demand from static/vendor, data-p5 on <body>), in
// instance mode, one sketch per mounted element. Every mode is a pure function of the frame's
// analysis {bands, wave, level, bass, mid, high, beat, t}, so the seven of them share one engine.
//
// Fullscreen: SonicVisualizer.open() lays the picture over the page below the player (z 35,
// under the queue and panels at 40 and the bar at 50), with no chrome. Moving the pointer or
// pressing a key shows the controls for a few seconds; Escape closes; the arrow keys change the
// mode; F asks the browser for real fullscreen. The open state and mode live in the URL
// (?viz=<mode>), so a link opens the same picture.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var body = document.body;
  var MODES = ['tunnel', 'nebula', 'aurora', 'bloom', 'bars', 'warp', 'plasma'];
  var STORE = 'sonic.visualizer';
  var BANDS = 48;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @returns {{mode: string, cycle: boolean}} */
  function prefs() {
    try {
      var p = JSON.parse(localStorage.getItem(STORE) || '{}');
      return { mode: MODES.indexOf(p.mode) >= 0 ? p.mode : MODES[0], cycle: p.cycle !== false };
    } catch (e) {
      return { mode: MODES[0], cycle: true };
    }
  }
  function savePrefs(p) {
    try { localStorage.setItem(STORE, JSON.stringify(p)); } catch (e) { /* private window */ }
  }

  // ---- The sound: one engine shared by every sketch. ------------------------------------------

  var engine = {
    source: 'clock',
    ctx: null,
    analyser: null,
    stream: null,
    freq: null,
    time: null,
    bands: new Float32Array(BANDS),
    wave: new Float32Array(256),
    level: 0, bass: 0, mid: 0, high: 0, beat: false,
    bassAvg: 0.2,
    lastBeat: 0,
    clock: { playing: false, base: 0, at: 0 },
  };

  function playing() { return document.documentElement.getAttribute('data-player-state') === 'playing'; }

  // The player saves its time every few seconds; between saves the clock runs on its own.
  function syncClock() {
    var now = performance.now() / 1000;
    var on = playing();
    var t = 0;
    try { t = window.SonicPlayer ? window.SonicPlayer.state().time || 0 : 0; } catch (e) { t = 0; }
    if (on !== engine.clock.playing || Math.abs(t - clockTime()) > 6) {
      engine.clock = { playing: on, base: on ? t : clockTime(), at: now };
    }
  }
  function clockTime() {
    var c = engine.clock;
    return c.playing ? c.base + (performance.now() / 1000 - c.at) : c.base;
  }

  /** Stop listening and return to the clock. */
  function stopAudio() {
    if (engine.stream) engine.stream.getTracks().forEach(function (tr) { tr.stop(); });
    engine.stream = null;
    engine.analyser = null;
    engine.source = 'clock';
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
      if (engine.stream) engine.stream.getTracks().forEach(function (tr) { tr.stop(); });
      var AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      engine.ctx = engine.ctx || new AC();
      if (engine.ctx.state === 'suspended') engine.ctx.resume();
      var an = engine.ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.78;
      engine.ctx.createMediaStreamSource(stream).connect(an);
      engine.analyser = an;
      engine.freq = new Uint8Array(an.frequencyBinCount);
      engine.time = new Uint8Array(an.fftSize);
      engine.stream = stream;
      engine.source = kind;
      stream.getAudioTracks()[0].addEventListener('ended', stopAudio);
      announce();
    });
  }

  // One analysis per animation frame, whoever asks first.
  var analysedAt = -1;
  function analyse() {
    var frame = Math.floor(performance.now() / 8);
    if (frame === analysedAt) return engine;
    analysedAt = frame;
    if (engine.analyser) fromAudio(); else fromClock();
    var b = engine.bands;
    var sum = 0;
    var bass = 0, mid = 0, high = 0;
    for (var i = 0; i < BANDS; i++) {
      sum += b[i];
      if (i < 8) bass += b[i]; else if (i < 28) mid += b[i]; else high += b[i];
    }
    engine.level = sum / BANDS;
    engine.bass = bass / 8;
    engine.mid = mid / 20;
    engine.high = high / (BANDS - 28);
    var now = performance.now();
    engine.beat = engine.bass > engine.bassAvg * 1.3 + 0.05 && now - engine.lastBeat > 240;
    if (engine.beat) engine.lastBeat = now;
    engine.bassAvg = engine.bassAvg * 0.96 + engine.bass * 0.04;
    return engine;
  }

  function fromAudio() {
    var an = engine.analyser;
    an.getByteFrequencyData(engine.freq);
    an.getByteTimeDomainData(engine.time);
    var n = engine.freq.length;
    var nyquist = engine.ctx.sampleRate / 2;
    // Log-spaced bands from 40 Hz to 16 kHz, so the bass is not one bar among a thousand.
    for (var i = 0; i < BANDS; i++) {
      var lo = 40 * Math.pow(400, i / BANDS);
      var hi = 40 * Math.pow(400, (i + 1) / BANDS);
      var a = Math.max(1, Math.floor(lo / nyquist * n));
      var z = Math.max(a + 1, Math.ceil(hi / nyquist * n));
      var peak = 0;
      for (var k = a; k < z && k < n; k++) peak = Math.max(peak, engine.freq[k]);
      engine.bands[i] = Math.pow(peak / 255, 1.4);
    }
    var step = engine.time.length / engine.wave.length;
    for (var j = 0; j < engine.wave.length; j++) {
      engine.wave[j] = (engine.time[Math.floor(j * step)] - 128) / 128;
    }
  }

  // No sound to read: a calm, honest motion driven by the player's time. It breathes at 120 bpm
  // while the player plays and settles to a slow drift when it is paused or stopped.
  function fromClock() {
    syncClock();
    var on = engine.clock.playing;
    var t = clockTime();
    var drift = performance.now() / 1000;
    var pulse = on ? Math.pow(Math.max(0, Math.cos(t * Math.PI * 2)), 6) : 0;
    var gain = on ? 0.6 : 0.3;
    for (var i = 0; i < BANDS; i++) {
      var f = i / BANDS;
      var shape = (1 - f) * 0.75 + 0.25;
      var wobble = 0.5 + 0.5 * Math.sin(drift * (0.6 + f * 2.3) + i * 0.7)
        * Math.cos(drift * 0.37 + i * 1.3);
      var v = gain * shape * (0.35 + 0.65 * wobble) + (i < 8 ? pulse * 0.45 : pulse * 0.08);
      engine.bands[i] = engine.bands[i] * 0.7 + Math.min(1, v) * 0.3;
    }
    for (var j = 0; j < engine.wave.length; j++) {
      var x = j / engine.wave.length;
      engine.wave[j] = gain * (Math.sin(x * 12 + drift * 3) * 0.6 + Math.sin(x * 31 - drift * 5) * 0.25)
        * (0.6 + pulse);
    }
  }

  // ---- The seven pictures. Each draws one frame from the analysis a. --------------------------

  /** @param {any} p @param {number} n @param {number} alpha */
  function hue(p, n, alpha) { return p.color((n % 360 + 360) % 360, 85, 100, alpha); }

  var DRAW = {
    // MilkDrop's feedback: the last frame, zoomed and turned a little, under a new waveform ring.
    tunnel: function (p, a, s) {
      var g = p.drawingContext;
      var w = p.width, h = p.height;
      g.save();
      g.globalAlpha = 0.92;
      g.translate(w / 2, h / 2);
      g.rotate(0.004 + a.mid * 0.02);
      var z = 1.025 + a.bass * 0.05;
      g.scale(z, z);
      g.drawImage(p.canvas, -w / 2, -h / 2, w, h);
      g.restore();
      p.noStroke();
      p.fill(0, 0, 0, 0.06);
      p.rect(0, 0, w, h);
      p.push();
      p.translate(w / 2, h / 2);
      p.noFill();
      p.strokeWeight(2 + a.bass * 4);
      p.stroke(hue(p, s.t * 40, 0.9));
      var r = Math.min(w, h) * (0.16 + a.level * 0.12);
      p.beginShape();
      for (var i = 0; i <= 128; i++) {
        var ang = i / 128 * Math.PI * 2;
        var v = a.wave[i * 2 % a.wave.length];
        p.vertex(Math.cos(ang) * r * (1 + v * 0.5), Math.sin(ang) * r * (1 + v * 0.5));
      }
      p.endShape();
      p.pop();
    },
    // Thousands of motes on a noise field, brighter and faster with the music, added as light.
    nebula: function (p, a, s) {
      if (!s.motes) {
        s.motes = [];
        for (var i = 0; i < 900; i++) s.motes.push([Math.random() * p.width, Math.random() * p.height]);
      }
      p.noStroke();
      p.fill(0, 0, 0, 0.08);
      p.rect(0, 0, p.width, p.height);
      p.drawingContext.globalCompositeOperation = 'lighter';
      var speed = 0.6 + a.level * 4 + (a.beat ? 3 : 0);
      for (var k = 0; k < s.motes.length; k++) {
        var m = s.motes[k];
        var n = p.noise(m[0] * 0.0018, m[1] * 0.0018, s.t * 0.08);
        var ang = n * Math.PI * 4;
        m[0] += Math.cos(ang) * speed;
        m[1] += Math.sin(ang) * speed;
        if (m[0] < 0 || m[0] > p.width || m[1] < 0 || m[1] > p.height) {
          m[0] = Math.random() * p.width;
          m[1] = Math.random() * p.height;
        }
        var band = a.bands[k % BANDS];
        p.fill(hue(p, 200 + n * 160 + s.t * 10, 0.25 + band * 0.6));
        p.circle(m[0], m[1], 1.5 + band * 3.5);
      }
      p.drawingContext.globalCompositeOperation = 'source-over';
    },
    // Ribbons of light that the spectrum lifts, like a curtain of aurora over the horizon.
    aurora: function (p, a, s) {
      p.noStroke();
      p.fill(0, 0, 0, 0.18);
      p.rect(0, 0, p.width, p.height);
      p.drawingContext.globalCompositeOperation = 'lighter';
      p.noFill();
      for (var r = 0; r < 5; r++) {
        p.stroke(hue(p, 140 + r * 38 + s.t * 6, 0.22));
        p.strokeWeight(18 - r * 2);
        p.beginShape();
        for (var i = 0; i <= 60; i++) {
          var x = i / 60 * p.width;
          var band = a.bands[Math.floor(i / 60 * (BANDS - 1))];
          var y = p.height * (0.42 + r * 0.06)
            + Math.sin(i * 0.18 + s.t * (0.4 + r * 0.13)) * p.height * 0.06
            - band * p.height * 0.22;
          // p5 2 renamed curveVertex to splineVertex.
          if (p.splineVertex) p.splineVertex(x, y); else p.curveVertex(x, y);
        }
        p.endShape();
      }
      p.drawingContext.globalCompositeOperation = 'source-over';
    },
    // A turning flower of the spectrum, mirrored eight ways.
    bloom: function (p, a, s) {
      p.noStroke();
      p.fill(0, 0, 0, 0.2);
      p.rect(0, 0, p.width, p.height);
      p.push();
      p.translate(p.width / 2, p.height / 2);
      p.rotate(s.t * 0.15);
      p.drawingContext.globalCompositeOperation = 'lighter';
      var base = Math.min(p.width, p.height) * 0.08;
      var reach = Math.min(p.width, p.height) * 0.36;
      for (var petal = 0; petal < 8; petal++) {
        p.rotate(Math.PI / 4);
        for (var i = 0; i < BANDS; i++) {
          var v = a.bands[i];
          var ang = (i / BANDS) * (Math.PI / 4);
          var r1 = base + v * reach;
          p.stroke(hue(p, 280 + i * 3 + s.t * 20, 0.35 + v * 0.5));
          p.strokeWeight(2 + v * 3);
          p.line(Math.cos(ang) * base, Math.sin(ang) * base, Math.cos(ang) * r1, Math.sin(ang) * r1);
        }
      }
      p.drawingContext.globalCompositeOperation = 'source-over';
      p.pop();
    },
    // Winamp's own: gradient bars with falling peak caps and a reflection on a dark floor.
    bars: function (p, a, s) {
      p.background(0, 0, 4);
      if (!s.peaks) s.peaks = new Float32Array(BANDS);
      var gap = 3;
      var w = (p.width - gap * (BANDS + 1)) / BANDS;
      var floor = p.height * 0.72;
      var top = p.height * 0.62;
      var g = p.drawingContext;
      var grad = g.createLinearGradient(0, floor, 0, floor - top);
      grad.addColorStop(0, '#22c55e');
      grad.addColorStop(0.6, '#facc15');
      grad.addColorStop(1, '#ef4444');
      for (var i = 0; i < BANDS; i++) {
        var v = a.bands[i];
        var x = gap + i * (w + gap);
        var bh = Math.max(2, v * top);
        s.peaks[i] = Math.max(v, s.peaks[i] - 0.008);
        g.fillStyle = grad;
        g.fillRect(x, floor - bh, w, bh);
        g.globalAlpha = 0.18;
        g.fillRect(x, floor + 4, w, bh * 0.35);
        g.globalAlpha = 1;
        g.fillStyle = '#e5e7eb';
        g.fillRect(x, floor - s.peaks[i] * top - 4, w, 2);
      }
    },
    // Stars rushing past, faster with the level, streaking on the beat.
    warp: function (p, a, s) {
      if (!s.stars) {
        s.stars = [];
        for (var i = 0; i < 500; i++) s.stars.push([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()]);
      }
      p.noStroke();
      p.fill(0, 0, 0, 0.35);
      p.rect(0, 0, p.width, p.height);
      var speed = 0.004 + a.level * 0.03 + (a.beat ? 0.02 : 0);
      var cx = p.width / 2, cy = p.height / 2;
      for (var k = 0; k < s.stars.length; k++) {
        var st = s.stars[k];
        var z0 = st[2];
        st[2] -= speed;
        if (st[2] <= 0.02) { st[0] = Math.random() * 2 - 1; st[1] = Math.random() * 2 - 1; st[2] = 1; continue; }
        var x0 = cx + st[0] / z0 * cx, y0 = cy + st[1] / z0 * cy;
        var x1 = cx + st[0] / st[2] * cx, y1 = cy + st[1] / st[2] * cy;
        p.stroke(hue(p, 190 + a.bands[k % BANDS] * 140, 1 - st[2] * 0.8));
        p.strokeWeight((1 - st[2]) * 3);
        p.line(x0, y0, x1, y1);
      }
    },
    // The demoscene's plasma, on a small canvas the browser smooths up to the screen.
    plasma: function (p, a, s) {
      var W = 96, H = 54;
      if (!s.small) {
        s.small = document.createElement('canvas');
        s.small.width = W;
        s.small.height = H;
        s.img = s.small.getContext('2d').createImageData(W, H);
      }
      var d = s.img.data;
      var t = s.t * 0.6;
      var k1 = 0.08 + a.bass * 0.06, k2 = 0.05 + a.high * 0.08;
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var v = Math.sin(x * k1 + t) + Math.sin((y * k2 + t) * 1.3)
            + Math.sin((x + y) * 0.06 + t * 1.7) + Math.sin(Math.sqrt(x * x + y * y) * 0.09 - t);
          var o = (y * W + x) * 4;
          // A cosine palette of deep violet, teal and rose over black, with a soft vignette:
          // the field glows rather than shouts, and brightens with the level.
          var dx = x / W - 0.5, dy = y / H - 0.5;
          var lum = (0.55 + a.level * 0.6) * (1 - Math.min(1, (dx * dx + dy * dy) * 1.6));
          var ph = v * 0.5 + t * 0.15;
          d[o] = lum * (90 + 80 * Math.cos(6.283 * (ph + 0.00)));
          d[o + 1] = lum * (50 + 70 * Math.cos(6.283 * (ph + 0.33)));
          d[o + 2] = lum * (120 + 110 * Math.cos(6.283 * (ph + 0.67)));
          d[o + 3] = 255;
        }
      }
      s.small.getContext('2d').putImageData(s.img, 0, 0);
      var g = p.drawingContext;
      g.imageSmoothingEnabled = true;
      g.drawImage(s.small, 0, 0, p.width, p.height);
    },
  };

  // ---- Sketches: one per mounted element, all reading the one engine. -------------------------

  var p5Promise = null;
  function loadP5() {
    if (!p5Promise) {
      var src = body.getAttribute('data-p5');
      p5Promise = src ? Sonic.script(src) : Promise.reject(new Error('no data-p5'));
      p5Promise.catch(function () { p5Promise = null; });
    }
    return p5Promise;
  }

  /**
   * A picture in an element. The returned handle changes the mode and removes the sketch.
   * @param {HTMLElement} el @param {{mode: string, cycle: boolean, fps: number, density: number}} opt
   */
  function sketch(el, opt) {
    var state = { mode: opt.mode, cycle: opt.cycle, started: performance.now(), fade: 0, t: 0, visible: true };
    // An embedded picture draws only while it is on screen.
    var seen = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      state.visible = entries[0].isIntersecting;
    }) : null;
    if (seen) seen.observe(el);
    var scratch = {};
    var instance = null;
    var gone = false;
    var handle = {
      mode: function (m) {
        if (MODES.indexOf(m) < 0) return;
        state.mode = m;
        state.started = performance.now();
        state.fade = 1;
        scratch = {};
        el.setAttribute('data-visualizer-mode', m);
      },
      get: function () { return state.mode; },
      cycle: function (on) { state.cycle = on; state.started = performance.now(); },
      canvas: function () { return instance ? instance.canvas : null; },
      remove: function () {
        gone = true;
        if (seen) seen.disconnect();
        if (instance) instance.remove();
        instance = null;
      },
    };
    el.setAttribute('data-visualizer-mode', state.mode);
    loadP5().then(function () {
      if (gone) return;
      var P5 = /** @type {any} */ (window).p5;
      instance = new P5(function (p) {
        p.setup = function () {
          var c = p.createCanvas(el.clientWidth || 1, el.clientHeight || 1);
          c.elt.setAttribute('aria-hidden', 'true');
          c.elt.classList.add('block', 'h-full', 'w-full');
          p.pixelDensity(opt.density);
          p.colorMode(p.HSB, 360, 100, 100, 1);
          p.frameRate(opt.fps);
          p.background(0);
        };
        p.windowResized = function () {
          p.resizeCanvas(el.clientWidth || 1, el.clientHeight || 1);
          p.background(0);
          scratch = {};
        };
        p.draw = function () {
          if (document.hidden || !state.visible) return;
          var a = analyse();
          scratch.t = (performance.now() - state.started) / 1000;
          if (state.cycle && scratch.t > 40) {
            handle.mode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);
            scratch.t = 0;
          }
          DRAW[state.mode](p, a, scratch);
          // A change of mode fades in from black rather than cutting.
          if (state.fade > 0) {
            p.noStroke();
            p.fill(0, 0, 0, state.fade);
            p.rect(0, 0, p.width, p.height);
            state.fade = Math.max(0, state.fade - 0.04);
          }
          el.setAttribute('data-visualizer-frame', String(p.frameCount));
        };
      }, el);
    }).catch(function () {
      el.setAttribute('data-visualizer-error', 'p5');
    });
    return handle;
  }

  // ---- Fullscreen. ------------------------------------------------------------------------------

  var full = null;
  var hideTimer = 0;

  function shell() { return document.getElementById('visualizer-full'); }

  function showControls() {
    var s = shell();
    if (!s) return;
    s.setAttribute('data-controls', 'shown');
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      if (!s.contains(document.activeElement) || document.activeElement === s) s.setAttribute('data-controls', 'hidden');
    }, 2600);
  }

  function setUrl(mode) {
    var u = new URL(location.href);
    if (mode) u.searchParams.set('viz', mode); else u.searchParams.delete('viz');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }

  /** @param {string=} mode */
  function open(mode) {
    var s = shell();
    if (!s) return;
    var p = prefs();
    var m = MODES.indexOf(mode || '') >= 0 ? mode : p.mode;
    s.hidden = false;
    document.documentElement.setAttribute('data-visualizer', 'open');
    var stage = /** @type {HTMLElement} */ (s.querySelector('[data-visualizer-stage]'));
    if (full) full.mode(m);
    else full = sketch(stage, { mode: m, cycle: p.cycle, fps: reduced ? 20 : 60, density: Math.min(1.5, window.devicePixelRatio || 1) });
    syncControls();
    setUrl(m);
    s.focus();
    showControls();
  }

  function close() {
    var s = shell();
    if (!s || s.hidden) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    if (full) full.remove();
    full = null;
    s.hidden = true;
    document.documentElement.removeAttribute('data-visualizer');
    setUrl('');
  }

  function step(by) {
    if (!full) return;
    var m = MODES[(MODES.indexOf(full.get()) + by + MODES.length) % MODES.length];
    full.mode(m);
    var p = prefs();
    p.mode = m;
    savePrefs(p);
    setUrl(m);
    syncControls();
  }

  // The controls reflect the state; the strings are interface keys (data/i18n).
  function syncControls() {
    var s = shell();
    if (!s) return;
    var mode = full ? full.get() : prefs().mode;
    s.querySelectorAll('[data-viz-mode]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-viz-mode') === mode));
    });
    s.querySelectorAll('[data-viz-source]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-viz-source') === engine.source));
    });
    var cyc = s.querySelector('[data-viz-cycle]');
    if (cyc) cyc.setAttribute('aria-pressed', String(prefs().cycle));
    var label = s.querySelector('[data-viz-status]');
    if (label) {
      // data-i18n lets i18n.js translate it again when the bundle arrives or the language changes.
      var key = engine.source === 'tab' ? 'viz.status_tab'
        : engine.source === 'mic' ? 'viz.status_mic' : 'viz.status_clock';
      var text = engine.source === 'tab' ? Sonic.t('viz.status_tab')
        : engine.source === 'mic' ? Sonic.t('viz.status_mic') : Sonic.t('viz.status_clock');
      label.setAttribute('data-i18n', key);
      if (text !== key) label.textContent = text;
    }
  }
  function announce() { syncControls(); }

  function wire() {
    var s = shell();
    if (!s || s.getAttribute('data-wired')) return;
    s.setAttribute('data-wired', '1');
    s.addEventListener('pointermove', showControls);
    s.addEventListener('click', function (e) {
      var t = /** @type {HTMLElement} */ (e.target);
      var btn = /** @type {HTMLElement | null} */ (t.closest('button'));
      if (!btn) { showControls(); return; }
      var mode = btn.getAttribute('data-viz-mode');
      var source = btn.getAttribute('data-viz-source');
      if (mode && full) {
        full.mode(mode);
        var p = prefs();
        p.mode = mode;
        savePrefs(p);
        setUrl(mode);
      } else if (source === 'clock') {
        stopAudio();
      } else if (source === 'tab' || source === 'mic') {
        listen(source).catch(function () {
          if (window.SonicPlayer) window.SonicPlayer.notify(Sonic.t('viz.denied'));
        });
      } else if (btn.hasAttribute('data-viz-cycle')) {
        var q = prefs();
        q.cycle = !q.cycle;
        savePrefs(q);
        if (full) full.cycle(q.cycle);
      } else if (btn.hasAttribute('data-viz-fullscreen')) {
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
        else document.documentElement.requestFullscreen().catch(function () {});
      } else if (btn.hasAttribute('data-viz-close')) {
        close();
        return;
      }
      syncControls();
      showControls();
    });
    s.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
        else document.documentElement.requestFullscreen().catch(function () {});
      }
      showControls();
    });
  }

  // Any [data-visualizer-open] button opens the picture (the nav, the queue's tools, the hero).
  document.addEventListener('click', function (e) {
    var t = /** @type {HTMLElement} */ (e.target);
    var opener = t.closest && t.closest('[data-visualizer-open]');
    if (!opener) return;
    e.preventDefault();
    open(opener.getAttribute('data-visualizer-open') || undefined);
  });

  // ---- Embedded pictures (the landing hero): a page module, so the router mounts it. ----------

  Sonic.module('visualizer', function mount() {
    var handles = [];
    document.querySelectorAll('#main [data-visualizer]').forEach(function (node) {
      var el = /** @type {HTMLElement} */ (node);
      if (reduced) return;
      var mode = el.getAttribute('data-visualizer') || prefs().mode;
      handles.push(sketch(el, { mode: mode, cycle: el.hasAttribute('data-visualizer-cycle'), fps: 30, density: 1 }));
    });
    return function unmount() { handles.forEach(function (h) { h.remove(); }); };
  });

  wire();
  var asked = new URL(location.href).searchParams.get('viz');
  if (asked && MODES.indexOf(asked) >= 0) open(asked);

  window.SonicVisualizer = {
    modes: function () { return MODES.slice(); },
    open: open,
    close: close,
    mode: function () { return full ? full.get() : null; },
    set: function (m) { if (full) { full.mode(m); setUrl(m); syncControls(); } },
    source: function () { return engine.source; },
    listen: listen,
    stop: stopAudio,
  };
})();
