// The sound the visualiser follows (static/js/visualizer.js reads it): where it comes from and what
// is heard in it, once per frame, for every picture on the page.
//
// Where the sound comes from. The player is a YouTube iframe on another origin, so the page
// cannot read its audio; the browser hands it over only when the reader agrees:
//   tab    the reader shares this tab with its audio (getDisplayMedia); the picture follows the
//          music exactly. Chrome and Edge on a computer.
//   system the reader shares the whole screen with the computer's sound (getDisplayMedia with
//          systemAudio), where the browser offers it (Chromium on Windows and ChromeOS, on macOS
//          from 14.2): the picture follows everything the computer plays.
//   device an audio input the reader picks (getUserMedia with its exact deviceId): a loopback
//          device such as BlackHole carries what the computer plays, with no tab to share and no
//          microphone on. A loopback chosen once starts again by itself on a later visit while the
//          browser already allows it (resume); nothing else ever starts without a click.
//   mic    the microphone (getUserMedia); the picture follows the sound in the room. Phones too.
//   clock  no audio: the picture follows the player's state and time only (moving at 120 bpm
//          while it plays, resting while it is paused), and says so.
//
// What is heard: 48 log-spaced bands in dB with automatic gain, the waveform, the level and three
// ranges, onsets of the kick, snare and hi-hat ranges (the rise of each range's level over an
// adaptive threshold) as decaying envelopes, the overall novelty and the spectral centroid, a
// tempo from the kicks' intervals with the position in the beat, and the loudness of the last
// seconds (SonicVizAnalysis in types/sonic.d.ts). Every mode is a function of these features and
// of its parameters.
//
// Beyond the bands and the onsets, the musical dimensions a picture can follow, each clamped to
// a documented range (types/sonic.d.ts) and smoothed so it does not flicker:
//   stereo     balance and width from the two channels (a mono source reads as 0 and 0);
//   pitch      a 12-class chroma from a longer window, its dominant class, and the triad (key or
//              chord colour) the last second matches, which changes only after holding 0.8 s;
//   timbre     spectral flatness, the 85% rolloff and the brightness (the share above 1.5 kHz);
//   loudness   an approximate K-weighted loudness (ITU BS.1770 filters, EBU's 0.4 s window) and
//              the dynamics, the loudest moment of the last 3 s over its mean;
//   rhythm     the position in a 4/4 bar (3/4 is not told apart) whose first beat is the beat the
//              kicks accent most, and an envelope on that downbeat;
//   structure  the contrast of the last 3 s with the 6 s before them, which counts a new section
//              and raises a decaying `change` when the music moves on, at most every 6 s.
// The clock hears no sound: it has no pitch (the chroma stays flat at 0), no stereo, flatness,
// dynamics or novelty; its loudness and timbre are read from its own bands and its bar runs at
// 120 bpm with the downbeat on every fourth beat.
// The snapshot's `cost` is the mean milliseconds a frame's analysis takes (the e2e test reads it).
(function () {
  'use strict';
  var html = document.documentElement;
  var BANDS = 48;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** @type {(() => void)[]} */
  var listeners = [];
  function changed() { listeners.forEach(function (fn) { fn(); }); }

  /** @type {SonicVizAnalysis} */
  var A = {
    bands: new Float32Array(BANDS), wave: new Float32Array(256),
    level: 0, bass: 0, mid: 0, high: 0, kick: 0, snare: 0, hat: 0, beat: false,
    flux: 0, centroid: 0, bpm: 0, phase: 0, energy: 0, t: 0, dt: 1 / 60, source: 'clock',
    balance: 0, width: 0, chroma: new Float32Array(12), pitch: 0, key: 0, minor: 0, keyStrength: 0,
    flatness: 0, rolloff: 0, brightness: 0, loudness: 0, dynamics: 0, bar: 0, downbeat: 0,
    novelty: 0, section: 0, change: 0,
  };
  var audio = {
    ctx: /** @type {AudioContext | null} */ (null), analyser: /** @type {AnalyserNode | null} */ (null),
    stream: /** @type {MediaStream | null} */ (null), freq: new Float32Array(0), time: new Float32Array(0),
    kind: /** @type {SonicAudioSource} */ ('clock'), edges: /** @type {number[]} */ ([]),
    device: /** @type {{id: string, label: string} | null} */ (null),
    src: /** @type {MediaStreamAudioSourceNode | null} */ (null), request: 0,
    // Each bin's power (linear), read once a frame by the bands, the kick and the timbre.
    power: new Float32Array(0),
    // The pitch: a longer window, its bins from 80 Hz to 5 kHz (ca..cz) and their width in Hz.
    pitch: /** @type {AnalyserNode | null} */ (null),
    cfreq: new Float32Array(0), ca: 1, cz: 2, chz: 1,
    // The two channels, K-weighted: balance, width and loudness.
    left: /** @type {AnalyserNode | null} */ (null),
    right: /** @type {AnalyserNode | null} */ (null),
    l: new Float32Array(0), r: new Float32Array(0), bright: 1,
  };
  // Band i spans 40 * 400^(i/48) to 40 * 400^((i+1)/48) Hz: log-spaced from 40 Hz to 16 kHz.
  function bandOf(hz) { return Math.round(Math.log(hz / 40) / Math.log(400) * BANDS); }
  // The ranges every mode reads: the bass up to 180 Hz, the mids to 3.6 kHz, the highs above.
  var BASS_END = bandOf(180);
  var MID_END = bandOf(3600);
  // The clock's brightness reads its bands above 1.5 kHz.
  var BRIGHT = bandOf(1500);
  // The picture spans RANGE dB below the loudest band of the last seconds. TILT dB per octave
  // around 1 kHz evens out music's falling spectrum, as an analyser's slope does, so the treble
  // moves as visibly as the bass.
  var RANGE = 40;
  var TILT = 3;
  var tilt = new Float32Array(BANDS);
  for (var ti = 0; ti < BANDS; ti++) tilt[ti] = TILT * Math.log2(40 * Math.pow(400, (ti + 0.5) / BANDS) / 1000);
  // The loudness maps -54 to -6 LUFS (a quiet room to a loud master) onto 0..1.
  var LOUD_FLOOR = -54;
  var LOUD_TOP = -6;
  // The triads the key reads: 12 major (root, major third, fifth), then 12 minor.
  /** @type {number[][]} */
  var TRIADS = [];
  for (var tr = 0; tr < 24; tr++) {
    var root = tr % 12;
    TRIADS.push([root, (root + (tr < 12 ? 4 : 3)) % 12, (root + 7) % 12]);
  }
  // The structure: one feature row every 0.25 s (8 broad band groups, so a change of chord moves
  // little; the loudness, the flatness, the brightness), 36 rows (9 s): the last 12 rows (3 s)
  // against the 24 (6 s) before them.
  var GROUPS = 8;
  var ROW = GROUPS + 3;
  var ROWS = 36;
  var RECENT = 12;
  /** @param {number} x */
  function unit(x) { return Math.max(0, Math.min(1, x)); }
  // An onset detector per range. Its level is the mean power of every FFT bin in the range, in dB:
  // one figure over all the range's bins, so a quiet room's noise averages out where a narrow band
  // of one or two bins would jump by several dB from frame to frame. An onset is a rise of that
  // level over the last 25-40 ms (one frame at 30 fps, two at 60, since the 43 ms FFT window
  // spreads an attack over every frame it overlaps) above an adaptive threshold, the rises'
  // running mean plus `k` standard deviations plus `min` dB, with the level `lift` dB above its
  // own average of the last second, at most one onset per `gap` seconds; its envelope decays with
  // `tau`. In dB a kick over a sustained bass line is a rise like any other. The earlier analysis
  // read 8-bit levels clipped at -20 dB, whose loudest bands were pinned at the top and never
  // rose: on a mastered mix it found none of 25 kicks and no tempo (measured 2026-11-22).
  function detector(fromHz, toHz, gap, tau) {
    return { from: fromHz, to: toHz, lo: bandOf(fromHz), hi: bandOf(toHz), a: 1, z: 2, gap: gap, tau: tau,
      bins: false, k: 1.5, min: 1.2, lift: 0, level: -200, prev: -200, lag: -200, slow: -200, mean: 0, vari: 1, last: -10 };
  }
  var dsp = {
    db: new Float32Array(BANDS), prevDb: new Float32Array(BANDS), primed: false, ceil: -30,
    prev: new Float32Array(BANDS),
    // The kick's lift and threshold are measured: a kick of a mastered mix rises 9-12 dB within
    // 33 ms and stands 7-12 dB above the last second of its range; a room's noise stands less than
    // 6 dB above it 99 times in 100 (2026-11-22). The kick reads its
    // bins' power: its range has only a handful, and their mean power is the steadiest figure; the
    // snare and the hats read their bands equally, so a loud bin (a kick's tail, the bass line)
    // does not decide their level.
    kick: Object.assign(detector(40, 150, 0.22, 0.16), { bins: true, k: 2.5, lift: 6 }),
    snare: Object.assign(detector(200, 5000, 0.14, 0.12), { lift: 2 }),
    hat: detector(6500, 16000, 0.08, 0.06),
    kicks: /** @type {number[]} */ ([]), period: 0.5, lastKick: -10, steady: 0, median: 0,
    onsets: /** @type {{name: string, t: number}[]} */ ([]),
    clock: { playing: false, base: 0, at: 0, beat: -1, half: -1 },
    // The pitch: the raw chroma of this frame, its slow mean (about a second), the loudest peak of
    // the last frame, the triad held (0-23) and the one that would replace it, held for how long.
    raw: new Float32Array(12), slow: new Float32Array(12), ctop: -110, key: 0, cand: -1, candT: 0,
    // The loudness: the mean square (EBU's 0.4 s), in LUFS, and each frame's for the dynamics.
    ms: 1e-7, lufs: -70, dynDb: 0,
    hist: { ms: new Float32Array(256), t: new Float32Array(256).fill(-100), i: 0 },
    // The bar: the beat of the last kick on the grid (0-3), when it was, which beat is the
    // downbeat, each beat's accent (dB above the kicks' mean) and the accent being measured.
    beatN: 0, beatAt: -10, down: 0, acc: [0, 0, 0, 0], accMean: -200, downLast: -10,
    accent: { slot: 0, peak: -200, until: 0 },
    cost: 0,
    // The structure: the rows, the row being summed, the novelty's usual level, the last section.
    st: { ring: new Float32Array(ROW * ROWS), sum: new Float32Array(ROW), n: 0, at: -10, i: 0,
      filled: 0, base: 0.02, armed: true, sectionAt: -10 },
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
    // A request still on its way loses to this one (see the request token in listen).
    audio.request += 1;
    if (audio.stream) audio.stream.getTracks().forEach(function (tr) { tr.stop(); });
    // The graph is let go and the audio thread rests until the next source.
    if (audio.src) audio.src.disconnect();
    audio.src = null;
    if (audio.ctx && audio.ctx.state === 'running') audio.ctx.suspend();
    audio.stream = null;
    audio.analyser = audio.pitch = audio.left = audio.right = null;
    audio.kind = 'clock';
    audio.device = null;
    dsp.kicks = [];
    dsp.steady = 0;
    dsp.median = 0;
    dsp.primed = false;
    A.bpm = 0;
    changed();
  }

  /** The FFT bins [first, end) of every band, flat. */
  function bandEdges(bins, nyquist) {
    var out = [];
    for (var i = 0; i < BANDS; i++) {
      var a = Math.max(1, Math.floor(40 * Math.pow(400, i / BANDS) / nyquist * bins));
      var z = Math.max(a + 1, Math.ceil(40 * Math.pow(400, (i + 1) / BANDS) / nyquist * bins));
      out.push(Math.min(a, bins - 1), Math.min(z, bins));
    }
    return out;
  }

  /**
   * Listen to a source; a 'device' names its input. Every source is the sound as it is: no echo
   * cancellation, noise suppression or automatic gain, which would flatten the very dynamics the
   * picture follows.
   * @param {'tab' | 'system' | 'device' | 'mic'} kind @param {string} [id] the input of 'device'
   */
  function listen(kind, id) {
    var md = navigator.mediaDevices;
    if (!md) return Promise.reject(new Error('unsupported'));
    if (kind === 'device' && !id) return Promise.reject(new Error('no-device'));
    var raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    // This tab, offered first; or the whole screen, offered first, with the computer's sound.
    var screen = kind === 'tab'
      ? { video: true, audio: raw, preferCurrentTab: true, selfBrowserSurface: 'include' }
      : { video: { displaySurface: 'monitor' }, audio: raw, systemAudio: 'include', selfBrowserSurface: 'exclude' };
    var ask = kind === 'tab' || kind === 'system'
      ? (md.getDisplayMedia ? md.getDisplayMedia(/** @type {any} */ (screen))
        : Promise.reject(new Error('unsupported')))
      : md.getUserMedia({ audio: kind === 'device' ? Object.assign({ deviceId: { exact: id } }, raw) : raw });
    // The last request wins, not the last to be granted: a pick, a "don't listen" or a remembered
    // device's start made while an earlier request waits (a picker open, a slow device) makes
    // that earlier one stop its stream when it arrives (a review, 2026-11-23).
    var mine = ++audio.request;
    return ask.then(function (stream) {
      if (mine !== audio.request) {
        stream.getTracks().forEach(function (tr) { tr.stop(); });
        return;
      }
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(function (tr) { tr.stop(); });
        throw new Error('no-audio');
      }
      // Only the sound is wanted; the shared picture is dropped at once.
      stream.getVideoTracks().forEach(function (tr) { tr.stop(); });
      if (audio.stream) audio.stream.getTracks().forEach(function (tr) { tr.stop(); });
      var AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      var ctx = audio.ctx = audio.ctx || new AC();
      if (ctx.state === 'suspended') ctx.resume();
      var an = ctx.createAnalyser();
      an.fftSize = 2048;
      // No smoothing in the analyser: the onsets read the raw spectrum; the picture smooths each
      // band itself, quickly up and slowly down (fromAudio).
      an.smoothingTimeConstant = 0;
      if (audio.src) audio.src.disconnect();
      var src = audio.src = ctx.createMediaStreamSource(stream);
      src.connect(an);
      audio.analyser = an;
      audio.freq = new Float32Array(an.frequencyBinCount);
      audio.power = new Float32Array(an.frequencyBinCount);
      audio.time = new Float32Array(an.fftSize);
      audio.edges = bandEdges(an.frequencyBinCount, ctx.sampleRate / 2);
      audio.bright = Math.round(1500 / (ctx.sampleRate / an.fftSize));
      // The pitch reads a window four times longer (170 ms at 48 kHz, 6 Hz a bin), so the
      // semitones of the low notes are told apart; only its bins up to 5 kHz are copied.
      var pa = ctx.createAnalyser();
      pa.fftSize = 8192;
      pa.smoothingTimeConstant = 0;
      src.connect(pa);
      audio.pitch = pa;
      audio.chz = ctx.sampleRate / pa.fftSize;
      audio.ca = Math.round(80 / audio.chz);
      audio.cz = Math.round(5000 / audio.chz);
      audio.cfreq = new Float32Array(audio.cz + 1);
      // The two channels through the K-weighting of ITU BS.1770 (a high-pass at 38 Hz, a 4 dB
      // shelf above 1.5 kHz), after an up-mix that puts a mono source on both, so a microphone
      // reads as centred and narrow rather than hard left.
      var up = ctx.createGain();
      up.channelCount = 2;
      up.channelCountMode = 'explicit';
      up.channelInterpretation = 'speakers';
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
      var shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
      var split = ctx.createChannelSplitter(2);
      src.connect(up).connect(hp).connect(shelf).connect(split);
      audio.left = ctx.createAnalyser();
      audio.right = ctx.createAnalyser();
      split.connect(audio.left, 0);
      split.connect(audio.right, 1);
      audio.l = new Float32Array(audio.left.fftSize);
      audio.r = new Float32Array(audio.right.fftSize);
      dsp.st.filled = dsp.st.n = 0;
      dsp.st.sum.fill(0);
      [dsp.kick, dsp.snare, dsp.hat].forEach(function (d) {
        var bins = an.frequencyBinCount;
        var hz = ctx.sampleRate / 2 / bins;
        d.a = Math.min(bins - 1, Math.max(1, Math.round(d.from / hz)));
        d.z = Math.max(d.a + 1, Math.min(bins, Math.round(d.to / hz)));
      });
      audio.stream = stream;
      audio.kind = kind;
      // The input heard, named for the status: the track's own label (the device's, where the
      // browser gives one); a shared screen's track is named by the browser, not by a device.
      var track = stream.getAudioTracks()[0];
      audio.device = kind === 'device' || kind === 'mic' ? { id: id || '', label: track.label || '' } : null;
      dsp.primed = false;
      dsp.ceil = -30;
      stream.getAudioTracks()[0].addEventListener('ended', stopAudio);
      changed();
    });
  }
  /** True where a screen's or a tab's audio can be shared: Chromium on a computer. */
  function canShare() {
    var md = navigator.mediaDevices;
    var phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // Only Chromium shares a tab's audio; Firefox and Safari would ask for a silent screen.
    var brands = /** @type {any} */ (navigator).userAgentData ? /** @type {any} */ (navigator).userAgentData.brands || [] : [];
    var chromium = brands.some(function (b) { return /Chromium/.test(b.brand); });
    return !!(md && md.getDisplayMedia && !phone && chromium);
  }
  /** The source "Follow the music" asks for: the tab where a computer can share one, else the mic. */
  function bestSource() { return canShare() ? 'tab' : 'mic'; }

  // A loopback device is a virtual input that carries what the computer plays: BlackHole,
  // Loopback and Soundflower on a Mac, VB-Cable ("CABLE Output") and Stereo Mix on Windows, the
  // PulseAudio and PipeWire monitors on Linux ("Monitor of ...", "....monitor").
  var LOOPBACK = /blackhole|loopback|soundflower|vb-?cable|cable output|stereo mix|monitor of|\.monitor\b|pipewire|pulse(audio)?.*monitor/i;
  /** @param {string} label */
  function isLoopback(label) { return LOOPBACK.test(label || ''); }
  /**
   * Every audio input, loopback devices first. Reading the list never asks: until the reader has
   * allowed an input the browser hides its ids and labels, and the list is empty. The aliases
   * 'default' and 'communications' are left out: they name another entry, and may change.
   * @returns {Promise<{id: string, label: string, loopback: boolean}[]>}
   */
  function devices() {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve([]);
    return md.enumerateDevices().then(function (list) {
      var out = list.filter(function (d) {
        return d.kind === 'audioinput' && d.deviceId && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications';
      }).map(function (d) { return { id: d.deviceId, label: d.label, loopback: isLoopback(d.label) }; });
      return out.filter(function (d) { return d.loopback; }).concat(out.filter(function (d) { return !d.loopback; }));
    }, function () { return []; });
  }
  /** Resolves once the page may start sound: at once after the reader's first click or key. */
  function activated() {
    var ua = /** @type {any} */ (navigator).userActivation;
    if (!ua || ua.hasBeenActive) return Promise.resolve();
    return new Promise(function (done) {
      function go() {
        document.removeEventListener('pointerdown', go, true);
        document.removeEventListener('keydown', go, true);
        done(undefined);
      }
      document.addEventListener('pointerdown', go, true);
      document.addEventListener('keydown', go, true);
    });
  }
  /**
   * Start a remembered loopback device again without asking: only while the browser already
   * allows the inputs (so no prompt can appear), the device is still there and still a loopback,
   * and nothing else is heard; the sound starts with the reader's first click or key on the page
   * (a browser starts audio only then). A plain microphone never starts by itself.
   * @param {string} id @returns {Promise<boolean>} true when it listens
   */
  function resume(id) {
    var perms = navigator.permissions;
    if (!id || !navigator.mediaDevices || !perms || !perms.query) return Promise.resolve(false);
    // Any request the reader makes meanwhile (a pick, "don't listen") wins over this one.
    var at = audio.request;
    return perms.query(/** @type {any} */ ({ name: 'microphone' })).then(function (st) {
      if (st.state !== 'granted') return false;
      return devices().then(function (list) {
        if (!list.some(function (d) { return d.id === id && d.loopback; })) return false;
        return activated().then(function () {
          if (audio.analyser || audio.request !== at) return false;
          return listen('device', id).then(function () { return true; });
        });
      });
    }).catch(function () { return false; });
  }

  var analysedAt = -1;
  /** @returns {SonicVizAnalysis} */
  function analyse() {
    var now = performance.now();
    // The sketches of one frame share it. Two sketches drawing at 30 fps out of step (the hero and
    // the background) would otherwise read the spectrum twice within a few milliseconds, and the
    // rise of an onset would be split between two near-identical frames.
    if (analysedAt >= 0 && now - analysedAt < 12) return A;
    // After a pause (a hidden tab, a picture off screen) the last spectrum is stale: the detectors
    // start again from the next one rather than compare against it.
    if (analysedAt >= 0 && now - analysedAt > 250) dsp.primed = false;
    var dt = analysedAt < 0 ? 1 / 60 : Math.min(0.1, (now - analysedAt) / 1000);
    analysedAt = now;
    var t = now / 1000;
    A.t = t;
    A.dt = dt;
    A.source = audio.analyser ? audio.kind : 'clock';
    A.beat = false;
    if (audio.analyser) fromAudio(dt, t); else fromClock();
    features(dt, t, !audio.analyser);
    // What the analysis costs: the mean milliseconds of a frame's analysis, over about 20 frames.
    dsp.cost += (performance.now() - now - dsp.cost) * 0.05;
    return A;
  }

  /** @param {number} dt @param {number} t */
  function fromAudio(dt, t) {
    var an = /** @type {AnalyserNode} */ (audio.analyser);
    an.getFloatFrequencyData(audio.freq);
    an.getFloatTimeDomainData(audio.time);
    var e = audio.edges;
    var top = -200;
    var pw = audio.power;
    // Each bin's power, once (a silent bin is -Infinity in dB, 0 here), with what the timbre reads:
    // the total, the mean in dB (the geometric mean of the powers) and the share above 1.5 kHz.
    var from = e[0], to = e[2 * BANDS - 1], sumP = 0, sumDb = 0, hiP = 0;
    for (var q = from; q < to; q++) {
      var qd = audio.freq[q];
      var qp = qd > -200 ? Math.pow(10, qd / 10) : 0;
      pw[q] = qp;
      sumP += qp;
      sumDb += Math.max(qd, -160);
      if (q >= audio.bright) hiP += qp;
    }
    timbre(dt, from, to, sumP, sumDb, hiP);
    // Each band's level is the mean power of its bins in dB, tilted.
    for (var i = 0; i < BANDS; i++) {
      var p = 0;
      for (var k = e[2 * i]; k < e[2 * i + 1]; k++) p += pw[k];
      var db = 10 * Math.log10(p / (e[2 * i + 1] - e[2 * i]) + 1e-20) + tilt[i];
      dsp.db[i] = db;
      if (db > top) top = db;
    }
    // Automatic gain in dB: the ceiling follows the loudest band up at once and falls 3 dB a
    // second, so a quiet room (the microphone) moves the picture as much as a loud tab; it never
    // falls below -60 dB, so silence stays dark rather than amplified into noise.
    dsp.ceil = Math.max(top, dsp.ceil - 3 * dt, -60);
    var floor = dsp.ceil - RANGE;
    // The bars jump up and fall back over about a tenth of a second.
    var fall = 1 - Math.exp(-dt / 0.12);
    for (var j = 0; j < BANDS; j++) {
      var target = Math.min(1, Math.max(0, (dsp.db[j] - floor) / RANGE));
      var b = A.bands[j];
      A.bands[j] = target > b ? b + (target - b) * 0.8 : b + (target - b) * fall;
    }
    // The novelty: the mean rise of the bands within the picture since the last frame, per 1/60 s
    // (so it reads the same at 30 and at 60 fps); 4 dB over every band is full novelty.
    if (dsp.primed) {
      var rise = 0;
      for (var x = 0; x < BANDS; x++) rise += Math.max(0, Math.max(dsp.db[x], floor) - Math.max(dsp.prevDb[x], floor));
      A.flux = A.flux * 0.6 + Math.min(1, rise / BANDS / 4 / (dt * 60)) * 0.4;
    }
    dsp.prevDb.set(dsp.db);
    detect('kick', t, dt);
    accent(t);
    detect('snare', t, dt);
    detect('hat', t, dt);
    dsp.primed = true;
    chroma(dt);
    stereo(dt, t);
    var step = audio.time.length / A.wave.length;
    var rms = 0;
    for (var w = 0; w < A.wave.length; w++) {
      var s = audio.time[Math.floor(w * step)];
      A.wave[w] = s;
      rms += s * s;
    }
    // The waveform is gained like the bands, so a quiet source still draws a shape.
    var wg = Math.min(6, 0.5 / Math.max(0.02, Math.sqrt(rms / A.wave.length)));
    for (var y = 0; y < A.wave.length; y++) A.wave[y] = Math.max(-1, Math.min(1, A.wave[y] * wg));
  }

  /** @param {'kick' | 'snare' | 'hat'} name @param {number} t @param {number} dt */
  function detect(name, t, dt) {
    var d = dsp[name];
    var level = 0, lvl = 0;
    if (d.bins) {
      for (var k = d.a; k < d.z; k++) level += audio.power[k];
      level = 10 * Math.log10(level / (d.z - d.a) + 1e-20);
    } else {
      for (var c = d.lo; c < d.hi; c++) level += Math.max(dsp.db[c], -160);
      level /= d.hi - d.lo;
    }
    for (var b = d.lo; b < d.hi; b++) lvl += A.bands[b];
    lvl /= d.hi - d.lo;
    if (!dsp.primed) { d.prev = d.lag = d.slow = level; }
    d.level = level;
    var ref = dt >= 0.025 ? d.prev : d.lag;
    d.lag = d.prev;
    d.prev = level;
    // A rise counts up to 24 dB: sound after silence is one onset, not a burst that would raise
    // the threshold for seconds.
    var f = Math.min(24, Math.max(0, level - ref));
    var sd = Math.sqrt(d.vari);
    var a = 1 - Math.exp(-dt / 0.8);
    if (f > d.mean + d.k * sd + d.min && level > d.slow + d.lift && lvl > 0.05 && t - d.last > d.gap) onset(name, t);
    d.slow += (Math.max(level, d.slow - 24) - d.slow) * a;
    // The running mean and variance forget over about a second, whatever the frame rate; an
    // outlier counts as three standard deviations, so one burst does not raise the threshold for
    // the onsets after it.
    var diff = Math.min(f, d.mean + 3 * sd + d.min) - d.mean;
    d.mean += a * diff;
    d.vari = (1 - a) * (d.vari + a * diff * diff);
  }

  // The timbre of this frame's bins from 40 Hz to 16 kHz: the flatness is their geometric mean
  // over their arithmetic mean, over 0.56, the ratio a white noise's spectrum has (each bin of a
  // noise scatters, so even white noise reads 0.56, not 1); the rolloff is the frequency below
  // which 85% of the power lies, on the bands' log axis (0 at 40 Hz, 1 at 16 kHz); the
  // brightness the share of the power above 1.5 kHz. Silence leaves them falling to 0.
  /**
   * @param {number} dt @param {number} from @param {number} to the bins read
   * @param {number} sumP their power @param {number} sumDb their dB
   * @param {number} hiP their power above 1.5 kHz
   */
  function timbre(dt, from, to, sumP, sumDb, hiP) {
    var n = to - from;
    var heard = sumP / n > 1e-12;
    var flat = 0, roll = 0;
    if (heard) {
      flat = unit(Math.pow(10, (sumDb / n - 10 * Math.log10(sumP / n)) / 10) / 0.56);
      var k = from, acc = 0;
      while (k < to - 1 && acc + audio.power[k] < sumP * 0.85) acc += audio.power[k++];
      roll = unit(Math.log(k * audio.ctx.sampleRate / 2 / audio.power.length / 40) / Math.log(400));
    }
    var g = 1 - Math.exp(-dt / 0.1);
    A.flatness += (flat - A.flatness) * g;
    A.rolloff += (roll - A.rolloff) * g;
    A.brightness += ((heard ? hiP / sumP : 0) - A.brightness) * g;
  }

  // The chroma: every spectral peak from 80 Hz to 5 kHz within 50 dB of the loudest, at its
  // interpolated frequency, adds its magnitude to its pitch class, weighted down the further it
  // lies from the semitone (a quarter tone counts nothing). Normalised to its strongest class,
  // smoothed over 0.15 s; its mean over about a second picks the triad.
  /** @param {number} dt */
  function chroma(dt) {
    var f = audio.cfreq, raw = dsp.raw;
    /** @type {AnalyserNode} */ (audio.pitch).getFloatFrequencyData(f);
    raw.fill(0);
    var floor = Math.max(dsp.ctop - 50, -120), top = -200, most = 0;
    for (var k = audio.ca; k < audio.cz; k++) {
      var b = f[k];
      if (b > top) top = b;
      if (b <= floor || b <= f[k - 1] || b < f[k + 1]) continue;
      var off = 0.5 * (f[k - 1] - f[k + 1]) / (f[k - 1] - 2 * b + f[k + 1]);
      if (!(Math.abs(off) < 1)) off = 0;
      var midi = 12 * Math.log2((k + off) * audio.chz / 440) + 69;
      var near = Math.round(midi);
      var w = Math.cos(Math.PI * (midi - near));
      raw[near % 12] += Math.pow(10, b / 20) * w * w;
    }
    dsp.ctop = top;
    for (var c = 0; c < 12; c++) most = Math.max(most, raw[c]);
    var g = 1 - Math.exp(-dt / 0.15), s = 1 - Math.exp(-dt / 1), lead = 0, norm = 0;
    for (var i = 0; i < 12; i++) {
      var v = most > 0 ? raw[i] / most : 0;
      A.chroma[i] += (v - A.chroma[i]) * g;
      dsp.slow[i] += (v - dsp.slow[i]) * s;
      norm += dsp.slow[i] * dsp.slow[i];
      if (A.chroma[i] > A.chroma[lead]) lead = i;
    }
    if (A.chroma[lead] > 0.2) A.pitch = lead;
    key(dt, Math.sqrt(norm));
  }

  // The key (the chord colour of the last second): the triad whose pitch classes the slow chroma
  // matches best (cosine, its root weighted 1.2 so a lone note names its own triad). Another
  // triad replaces the held one only after winning for 0.8 s.
  /** @param {number} dt @param {number} norm */
  function key(dt, norm) {
    var sl = dsp.slow;
    /** @param {number} j */
    var score = function (j) {
      var t = TRIADS[j];
      return (1.2 * sl[t[0]] + sl[t[1]] + sl[t[2]]) / (norm * Math.sqrt(3.44));
    };
    if (norm < 0.05) { A.keyStrength *= 1 - dt; return; }
    var best = 0;
    for (var j = 1; j < 24; j++) if (score(j) > score(best)) best = j;
    if (best === dsp.key) dsp.cand = -1;
    else if (best === dsp.cand) dsp.candT += dt;
    else { dsp.cand = best; dsp.candT = 0; }
    if (dsp.cand >= 0 && dsp.candT >= 0.8) { dsp.key = dsp.cand; dsp.cand = -1; }
    A.key = dsp.key % 12;
    A.minor = dsp.key >= 12 ? 1 : 0;
    A.keyStrength = unit(score(dsp.key));
  }

  // The two K-weighted channels: the balance is the right's level against the left's (-1 hard
  // left, 1 hard right), the width the share of the side (L - R) in the power (0 mono, 0.5 one
  // side only or two unrelated channels, 1 out of phase), both over 0.2 s. The loudness is their
  // summed mean square over 0.4 s in LUFS (BS.1770; a mono source counts on both speakers); the
  // dynamics the loudest frame of the last 3 s over their mean, 20 dB being 1.
  /** @param {number} dt @param {number} t */
  function stereo(dt, t) {
    var l = audio.l, r = audio.r;
    /** @type {AnalyserNode} */ (audio.left).getFloatTimeDomainData(l);
    /** @type {AnalyserNode} */ (audio.right).getFloatTimeDomainData(r);
    var sl = 0, sr = 0, x = 0;
    for (var i = 0; i < l.length; i++) { sl += l[i] * l[i]; sr += r[i] * r[i]; x += l[i] * r[i]; }
    var both = sl + sr, ms = both / l.length, heard = ms > 1e-8;
    var bal = heard ? (Math.sqrt(sr) - Math.sqrt(sl)) / (Math.sqrt(sr) + Math.sqrt(sl)) : 0;
    var wid = heard ? unit((both - 2 * x) / (2 * both)) : 0;
    var g = 1 - Math.exp(-dt / 0.2);
    A.balance += (bal - A.balance) * g;
    A.width += (wid - A.width) * g;
    ms = Math.max(1e-7, ms);
    dsp.ms += (ms - dsp.ms) * (1 - Math.exp(-dt / 0.4));
    dsp.lufs = -0.691 + 10 * Math.log10(dsp.ms);
    A.loudness = unit((dsp.lufs - LOUD_FLOOR) / (LOUD_TOP - LOUD_FLOOR));
    var h = dsp.hist, peak = 0, sum = 0, n = 0;
    h.ms[h.i] = ms;
    h.t[h.i] = t;
    h.i = (h.i + 1) % h.ms.length;
    for (var j = 0; j < h.ms.length; j++) {
      if (t - h.t[j] > 3) continue;
      peak = Math.max(peak, h.ms[j]);
      sum += h.ms[j];
      n++;
    }
    dsp.dynDb = 10 * Math.log10(peak * n / sum);
    A.dynamics = unit(dsp.dynDb / 20);
  }

  // The accent of a kick on the grid: its range's loudest level within 80 ms of the onset, in dB
  // above the kicks' running mean, averaged per beat of the bar; the beat accented most is the
  // downbeat, and another beat takes its place only when it is accented 1.5 dB more.
  /** @param {number} t */
  function accent(t) {
    var ac = dsp.accent;
    if (!ac.until) return;
    ac.peak = Math.max(ac.peak, dsp.kick.level);
    if (t < ac.until) return;
    ac.until = 0;
    if (dsp.accMean < -150) dsp.accMean = ac.peak;
    var acc = dsp.acc;
    acc[ac.slot] += (ac.peak - dsp.accMean - acc[ac.slot]) * 0.35;
    dsp.accMean += (ac.peak - dsp.accMean) * 0.25;
    var best = 0;
    for (var s = 1; s < 4; s++) if (acc[s] > acc[best]) best = s;
    if (acc[best] > acc[dsp.down] + 1.5) dsp.down = best;
  }

  // The kick's place in the bar: a kick within a quarter beat of the grid (whole beats after the
  // last one on it) moves the count on; one off the grid is passed over; after 2 s without one
  // the count starts again from this kick.
  /** @param {number} t */
  function count(t) {
    var beats = (t - dsp.beatAt) / dsp.period;
    var n = Math.round(beats);
    if (t - dsp.beatAt > 2) { dsp.beatN = 0; dsp.acc = [0, 0, 0, 0]; dsp.down = 0; }
    else if (n < 1 || Math.abs(beats - n) > 0.25) return;
    else dsp.beatN = (dsp.beatN + n) % 4;
    dsp.beatAt = t;
    dsp.accent = { slot: dsp.beatN, peak: dsp.kick.level, until: t + 0.08 };
    if (dsp.beatN === dsp.down && A.bpm) { A.downbeat = reduced ? 0.35 : 1; dsp.downLast = t; }
  }

  // The structure: a row of features every 0.25 s; once 9 s are heard, the novelty is the mean
  // difference of the last 3 s from the 6 s before them (0.25 being 1). A section begins where
  // it stands above both 0.06 and three times its usual level, at least 6 s after the last, and
  // the next waits until it has fallen back below half of that.
  /** @param {number} t */
  function structure(t) {
    var st = dsp.st, sum = st.sum;
    var per = BANDS / GROUPS;
    for (var b = 0; b < BANDS; b++) sum[Math.floor(b / per)] += A.bands[b] / per;
    sum[GROUPS] += A.loudness;
    sum[GROUPS + 1] += A.flatness;
    sum[GROUPS + 2] += A.brightness;
    st.n++;
    if (t - st.at < 0.25) return;
    st.at = t;
    for (var d = 0; d < ROW; d++) { st.ring[st.i * ROW + d] = sum[d] / st.n; sum[d] = 0; }
    st.n = 0;
    st.i = (st.i + 1) % ROWS;
    st.filled = Math.min(ROWS, st.filled + 1);
    if (st.filled < ROWS) return;
    var nov = 0;
    for (var c = 0; c < ROW; c++) {
      var recent = 0, past = 0;
      for (var row = 0; row < ROWS; row++) {
        var v = st.ring[((st.i - 1 - row + ROWS) % ROWS) * ROW + c];
        if (row < RECENT) recent += v; else past += v;
      }
      nov += Math.abs(recent / RECENT - past / (ROWS - RECENT));
    }
    nov /= ROW;
    A.novelty = unit(nov / 0.25);
    var bar = Math.max(0.06, st.base * 3);
    if (st.armed && nov > bar && t - st.sectionAt >= 6) {
      A.section += 1;
      A.change = reduced ? 0.35 : 1;
      st.sectionAt = t;
      st.armed = false;
    } else if (nov < bar / 2) {
      st.armed = true;
      st.base += (Math.min(nov, 0.04) - st.base) * 0.02;
    }
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
    if (on && beat !== c.beat) {
      c.beat = beat;
      onset('kick', A.t);
      if (beat % 2) onset('snare', A.t);
      if (beat % 4 === 0) { A.downbeat = reduced ? 0.35 : 1; dsp.downLast = A.t; }
    }
    if (on && half !== c.half) { c.half = half; onset('hat', A.t); }
    var gain = on ? 0.6 : 0.3;
    for (var i = 0; i < BANDS; i++) {
      var f = i / BANDS;
      var shape = (1 - f) * 0.75 + 0.25;
      var wobble = 0.5 + 0.5 * Math.sin(drift * (0.6 + f * 2.3) + i * 0.7)
        * Math.cos(drift * 0.37 + i * 1.3);
      var hit = i < BASS_END ? A.kick * 0.5 : i < MID_END ? A.snare * 0.25 : A.hat * 0.3;
      var v = gain * shape * (0.35 + 0.65 * wobble) + (on ? hit : 0);
      A.bands[i] = A.bands[i] * 0.7 + Math.min(1, v) * 0.3;
    }
    for (var j = 0; j < A.wave.length; j++) {
      var x = j / A.wave.length;
      A.wave[j] = gain * (Math.sin(x * 12 + drift * 3) * 0.6 + Math.sin(x * 31 - drift * 5) * 0.25)
        * (0.6 + A.kick * 0.8);
    }
    A.phase = on ? (t * 2) % 1 : 0;
    A.bar = on ? (t * 2) % 4 / 4 : 0;
    A.balance = A.width = A.flatness = A.dynamics = A.novelty = A.keyStrength = 0;
    A.chroma.fill(0);
    // The timbre and the loudness of the clock's own bands: the share above 1.5 kHz, the band
    // below which 85% of their sum lies, their mean.
    var sum = 0, hi = 0, acc = 0, roll = 0;
    for (var b = 0; b < BANDS; b++) { sum += A.bands[b]; if (b >= BRIGHT) hi += A.bands[b]; }
    while (roll < BANDS - 1 && acc + A.bands[roll] < sum * 0.85) acc += A.bands[roll++];
    A.brightness = sum > 0 ? hi / sum : 0;
    A.rolloff = roll / BANDS;
    A.loudness = sum / BANDS;
  }

  /** @param {'kick' | 'snare' | 'hat'} name @param {number} t */
  function onset(name, t) {
    dsp[name].last = t;
    A[name] = reduced ? 0.35 : 1;
    dsp.onsets.push({ name: name, t: t });
    if (dsp.onsets.length > 64) dsp.onsets.shift();
    if (name === 'kick') {
      A.beat = !reduced;
      if (audio.analyser) tempo(t);
    }
  }

  // The tempo: the median interval between the last kicks, folded into 75-180 bpm. It is said only
  // from six kicks on, while the intervals agree (their median deviation within 8% of the median;
  // a played beat's is about 2%) and while the kicks fill at least 45% of the beats they span (a
  // kick on every beat fills all, on every other half): folding squeezes any interval into that
  // range, and kicks found at random, in a noisy room, fill about a third.
  function tempo(t) {
    var ks = dsp.kicks;
    ks.push(t);
    while (ks.length && t - ks[0] > 8) ks.shift();
    count(t);
    dsp.lastKick = t;
    if (ks.length < 6) return;
    var iv = [];
    for (var i = 1; i < ks.length; i++) {
      var d = ks[i] - ks[i - 1];
      while (d < 0.333) d *= 2;
      while (d > 0.8) d /= 2;
      iv.push(d);
    }
    iv.sort(function (a, b) { return a - b; });
    var median = iv[iv.length >> 1];
    var dev = iv.map(function (d) { return Math.abs(d - median); }).sort(function (a, b) { return a - b; });
    var filled = (ks.length - 1) / Math.max(1, (t - ks[0]) / median);
    if (dev[dev.length >> 1] > median * 0.08 || filled < 0.45) { A.bpm = 0; dsp.steady = 0; return; }
    // Said only once three estimates in a row agree within 4%: kicks found at random in a loud
    // room can line up once (110 bpm from a fan's noise, 2026-11-23), a played beat keeps agreeing.
    dsp.steady = dsp.median && Math.abs(median - dsp.median) < dsp.median * 0.04 ? dsp.steady + 1 : 0;
    dsp.median = median;
    dsp.period = dsp.period * 0.7 + median * 0.3;
    A.bpm = dsp.steady >= 2 ? Math.round(60 / dsp.period) : 0;
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
      if (i < BASS_END) bass += v; else if (i < MID_END) mid += v; else high += v;
    }
    A.level = sum / BANDS;
    A.bass = bass / BASS_END;
    A.mid = mid / (MID_END - BASS_END);
    A.high = high / (BANDS - MID_END);
    A.centroid = A.centroid * 0.8 + (sum > 0.01 ? moment / sum / (BANDS - 1) : 0) * 0.2;
    // The sound's novelty is measured in dB by fromAudio; the clock's from its own bands.
    if (clock) A.flux = A.flux * 0.6 + Math.min(1, flux / (BANDS * 0.08)) * 0.4;
    A.energy += (A.level - A.energy) * (1 - Math.exp(-dt / 4));
    ['kick', 'snare', 'hat'].forEach(function (name) {
      if (dsp[name].last !== t) A[name] *= Math.exp(-dt / dsp[name].tau);
    });
    if (dsp.downLast !== t) A.downbeat *= Math.exp(-dt / dsp.kick.tau);
    A.change *= Math.exp(-dt / 1.5);
    dsp.prev.set(b);
    if (!clock) {
      if (t - dsp.lastKick > 8) A.bpm = 0;
      A.phase = A.bpm ? ((t - dsp.lastKick) / dsp.period) % 1 : (t * 2) % 1;
      // The bar: the beats since the downbeat, counted from the last kick on the grid; without a
      // tempo it runs at 120 bpm, as the beat does.
      var beats = dsp.beatN - dsp.down + 4 + (t - dsp.beatAt) / dsp.period;
      A.bar = A.bpm ? (beats % 4) / 4 : (t * 0.5) % 1;
      structure(t);
    }
  }

  window.SonicAudio = {
    /** The analysis of this frame (shared by every caller within it). */
    analyse: analyse,
    /** The live features, as last analysed (the same object analyse() returns). */
    features: A,
    /** 'tab', 'system', 'device', 'mic' or 'clock'. */
    source: function () { return audio.kind; },
    /** The input heard (a device or the microphone): its id and label; null otherwise. */
    device: function () { return audio.device ? { id: audio.device.id, label: audio.device.label } : null; },
    devices: devices,
    isLoopback: isLoopback,
    resume: resume,
    canShare: canShare,
    /** True while a stream is analysed. */
    listening: function () { return !!audio.analyser; },
    listen: listen,
    stop: stopAudio,
    bestSource: bestSource,
    /** @param {() => void} fn called whenever the source changes */
    onChange: function (fn) { listeners.push(fn); },
    /** A copy of the features a test or a page reads: plain numbers and arrays. */
    snapshot: function () {
      return { level: A.level, bass: A.bass, mid: A.mid, high: A.high, kick: A.kick, snare: A.snare,
        hat: A.hat, flux: A.flux, centroid: A.centroid, bpm: A.bpm, source: A.source,
        bands: Array.from(A.bands), onsets: dsp.onsets.slice(),
        balance: A.balance, width: A.width, chroma: Array.from(A.chroma), pitch: A.pitch,
        key: A.key, minor: A.minor, keyStrength: A.keyStrength, flatness: A.flatness,
        rolloff: A.rolloff, brightness: A.brightness, loudness: A.loudness, lufs: dsp.lufs, dynamics: A.dynamics,
        dynamicsDb: dsp.dynDb, bar: A.bar, downbeat: A.downbeat, phase: A.phase, novelty: A.novelty,
        section: A.section, change: A.change, cost: dsp.cost };
    },
  };
})();
