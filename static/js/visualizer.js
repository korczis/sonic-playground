// The visualiser: 25 pictures of what is playing, each an original homage to one Winamp-era
// visualisation, as one component that mounts in any element marked [data-visualizer] (the
// landing hero), behind every page while music plays, and full screen on request.
//
// The modes are one list, data/visualizer.json (embedded by templates/partials/visualizer.html as
// #viz-conf): each has an engine, p5 (static/js/viz-2d.js) or gl (three.js, static/js/viz-gl.js),
// a p5 fallback for a browser without WebGL 2, and the live controls (parameters) it offers. Both
// engines and their libraries load on demand, only when a mode of theirs is shown.
//
// The sound, where it comes from and what is heard in it, is static/js/viz-audio.js
// (window.SonicAudio); the controls always say which source is active. Nothing asks for a
// permission by itself: the reader presses "Follow the music" (the tab on a computer that can
// share one, the microphone elsewhere) or chooses a source in the settings.
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

  // `device` is the audio input the reader chose last (SonicAudio's 'device'), '' for none: a
  // loopback device among them starts again by itself on a later visit (SonicAudio.resume).
  /** @returns {{mode: string, cycle: boolean, bg: boolean, cinema: boolean, device: string, params: Record<string, Record<string, number>>}} */
  function prefs() {
    try {
      var p = JSON.parse(localStorage.getItem(STORE) || '{}');
      return { mode: resolve(p.mode) || MODES[0], cycle: p.cycle !== false, bg: p.bg !== false,
        cinema: p.cinema === true, device: typeof p.device === 'string' ? p.device : '',
        params: p.params && typeof p.params === 'object' ? p.params : {} };
    } catch (e) {
      return { mode: MODES[0], cycle: true, bg: true, cinema: false, device: '', params: {} };
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

  // ---- The sound (static/js/viz-audio.js). ------------------------------------------------------

  var SA = window.SonicAudio;
  var A = SA.features;
  var analyse = SA.analyse;
  function playing() { return html.getAttribute('data-player-state') === 'playing'; }

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
    // The grammar's signals for this picture, with its own envelopes (static/js/viz-map.js).
    var mapper = window.SonicVizMap.create();
    /** @type {SonicVizScratch} */
    var scratch = { t: 0, params: st.params, m: mapper.map };
    /** @type {{engine: string, set: (id: string) => void, remove: () => void, resize: () => void, memory?: () => {textures: number, geometries: number}} | null} */
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
      st.visible = entries[entries.length - 1].isIntersecting;
    }) : null;
    if (seen) seen.observe(el);
    var size = el.clientWidth + 'x' + el.clientHeight;
    var sized = 'ResizeObserver' in window ? new ResizeObserver(function () {
      var now = el.clientWidth + 'x' + el.clientHeight;
      if (now === size) return;
      size = now;
      scratch = { t: scratch.t, params: st.params, m: mapper.map };
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
      scratch.m = mapper.frame(a, st.params);
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
        memory: function () { return h.memory(); },
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
        scratch = { t: 0, params: st.params, m: mapper.map };
        el.setAttribute('data-visualizer-mode', id);
        flash();
        mount();
      },
      get: function () { return st.mode; },
      shown: function () { return effective(st.mode); },
      cycle: function (on) { st.cycle = on; st.started = performance.now(); },
      params: function () { return st.params; },
      map: function () { return mapper.map; },
      /** The WebGL renderer's GPU holdings, or null for a p5 picture. */
      memory: function () { return runner && runner.memory ? runner.memory() : null; },
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
    // The picture's palette, as every mode builds it (static/js/viz-map.js: the key's hue turned
    // by the hue control, its saturation and lightness): nothing is read back from the picture,
    // which for a WebGL frame stalls the GPU and for a 2D one copies the whole canvas back
    // (a review, 2026-11-23).
    var m = full.map();
    target.style.setProperty('--viz-glow', 'hsl(' + Math.round(m.hue * 360) + ' ' + Math.round(45 + 45 * m.sat) + '% '
      + Math.round(48 + 22 * m.light) + '% / 0.55)');
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
    // Reduced motion: a calm mode, slowed, that never changes by itself; a shared link's mode too
    // gives way to it (the reader can still choose any mode in the settings).
    var m = reduced && shared ? CALM : explicit || (reduced ? CALM : p.mode);
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
    // A toast showing keeps off the sheet (static/js/player.js placeToast), and comes back when it closes.
    if (window.SonicPlayer && window.SonicPlayer.placeToast) requestAnimationFrame(window.SonicPlayer.placeToast);
    var btn = s.querySelector('[data-viz-settings]');
    if (btn) btn.setAttribute('aria-expanded', String(on));
    if (on) {
      refreshDevices();
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
      var radios = shownRadios(g);
      var on = radios.filter(function (r) { return r.getAttribute('aria-checked') === 'true'; })[0] || radios[0];
      radios.forEach(function (r) { r.setAttribute('tabindex', r === on ? '0' : '-1'); });
    });
    s.querySelectorAll('[data-viz-source]').forEach(function (b) {
      var kind = b.getAttribute('data-viz-source');
      if (kind === 'connect') /** @type {HTMLElement} */ (b).hidden = SA.source() !== 'clock';
      else b.setAttribute('aria-checked', String(kind === SA.source()));
      if (kind === 'system') /** @type {HTMLElement} */ (b).hidden = !SA.canShare();
    });
    var heard = SA.device();
    s.querySelectorAll('[data-viz-device]').forEach(function (b) {
      b.setAttribute('aria-checked', String(SA.source() === 'device' && !!heard && b.getAttribute('data-viz-device') === heard.id));
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
      // The status names the source and the input heard. data-i18n (with data-i18n-vars) lets
      // i18n.js translate it again when the bundle arrives or the language changes.
      var src = SA.source();
      var called = heard ? deviceLabel(heard.id) || heard.label : '';
      var vars = { device: called };
      var pick = src === 'tab' ? ['viz.status_tab', Sonic.t('viz.status_tab')]
        : src === 'system' ? ['viz.status_system', Sonic.t('viz.status_system')]
          : src === 'device' ? ['viz.status_device', Sonic.t('viz.status_device', vars)]
            : src === 'mic' && called ? ['viz.status_mic_named', Sonic.t('viz.status_mic_named', vars)]
              : src === 'mic' ? ['viz.status_mic', Sonic.t('viz.status_mic')] : ['viz.status_clock', Sonic.t('viz.status_clock')];
      var key = pick[0];
      var said = pick[1];
      status.setAttribute('data-i18n', key);
      status.setAttribute('data-i18n-vars', JSON.stringify(vars));
      if (said !== key) status.textContent = said;
    }
    syncTempo();
  }
  // The audio inputs, as the browser last listed them (SonicAudio.devices: empty until the reader
  // has allowed one), rendered as chips; refreshed when the sheet opens, the source changes or a
  // device comes or goes. Reading the list never asks for anything.
  /** @type {SonicAudioDevice[]} */
  var inputs = [];
  var PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  /** A radio group's radios that are shown (a hidden one, such as "the whole computer" where it
   *  cannot be shared, takes no stop and the arrows pass it). @param {Element} g */
  function shownRadios(g) {
    return Array.prototype.filter.call(g.querySelectorAll('[role=radio]'), function (r) { return !r.hidden; });
  }
  function deviceLabel(id) {
    var d = inputs.filter(function (x) { return x.id === id; })[0];
    return d ? d.label : '';
  }
  function refreshDevices() {
    return SA.devices().then(function (list) {
      inputs = list;
      renderDevices();
      syncControls();
    });
  }
  function renderDevices() {
    var s = shell();
    var box = /** @type {HTMLElement | null} */ (s && s.querySelector('[data-viz-devices-box]'));
    var group = s && s.querySelector('[data-viz-devices]');
    var chip = /** @type {HTMLTemplateElement | null} */ (s && s.querySelector('template[data-viz-device-chip]'));
    var hint = /** @type {HTMLElement | null} */ (s && s.querySelector('[data-viz-loopback-hint]'));
    if (!box || !group || !chip || !hint) return;
    var loopback = inputs.some(function (d) { return d.loopback; });
    // A lone plain microphone is already "Listen with the microphone": the group shows when it
    // offers more (a loopback, or a choice of inputs). A phone cannot install a loopback, so the
    // hint to install one is for computers only.
    box.hidden = !(loopback || inputs.length > 1);
    hint.hidden = loopback || PHONE;
    var focused = document.activeElement && group.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-viz-device') : null;
    group.textContent = '';
    inputs.forEach(function (d) {
      var b = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (chip.content.cloneNode(true)).firstElementChild);
      b.setAttribute('data-viz-device', d.id);
      /** @type {HTMLElement} */ (b.querySelector('[data-viz-device-label]')).textContent = d.label;
      /** @type {HTMLElement} */ (b.querySelector('[data-viz-device-badge]')).hidden = !d.loopback;
      group.appendChild(b);
      if (d.id === focused) b.focus();
    });
  }
  function syncTempo() {
    var s = shell();
    var el = /** @type {HTMLElement | null} */ (s && s.querySelector('[data-viz-tempo]'));
    if (!el) return;
    el.hidden = !(SA.listening() && A.bpm);
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

  /** @param {string} id the device to remember, '' for none */
  function rememberDevice(id) {
    var p = prefs();
    if (p.device === id) return;
    p.device = id;
    savePrefs(p);
  }
  /** A source that could not start is said beside the buttons that asked. @param {boolean} toast */
  function refused(toast) {
    var s = shell();
    var status = s && s.querySelector('[data-viz-status]');
    if (status) {
      status.setAttribute('data-i18n', 'viz.denied');
      status.removeAttribute('data-i18n-vars');
      status.textContent = Sonic.t('viz.denied');
    }
    say(Sonic.t('viz.denied'), toast);
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
      var device = btn.getAttribute('data-viz-device');
      // A source the reader picks replaces the remembered device: only a device chosen again is
      // remembered (and, a loopback, started again on a later visit).
      if (source) rememberDevice('');
      if (mode) choose(mode);
      else if (source === 'clock') SA.stop();
      else if (device) {
        SA.listen('device', device).then(function () { rememberDevice(device); }, function () { refused(false); });
      } else if (source === 'tab' || source === 'system' || source === 'mic' || source === 'connect') {
        var kind = source === 'connect' ? SA.bestSource() : source;
        // A refusal is said beside the buttons that asked, not in a toast over them.
        SA.listen(/** @type {'tab' | 'system' | 'mic'} */ (kind)).catch(function (err) {
          // A shared tab without its audio is not a refusal: follow the room instead.
          if (source === 'connect' && kind === 'tab' && err && err.message === 'no-audio') return SA.listen('mic');
          throw err;
        }).catch(function () { refused(source === 'connect'); });
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
      var radios = shownRadios(group);
      var by = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      var next = /** @type {HTMLElement} */ (radios[(radios.indexOf(radio) + by + radios.length) % radios.length]);
      next.focus();
      // A source or a device (and "don't listen" too) changes only on a click, Space or Enter: the
      // arrows move to it, no further, so passing over "don't listen" never stops the music.
      var sound = next.hasAttribute('data-viz-device') || next.hasAttribute('data-viz-source');
      if (!sound) next.click();
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

  SA.onChange(announce);
  // A newly allowed input names every device: the list follows the source and the hardware.
  SA.onChange(refreshDevices);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  // A loopback device chosen on an earlier visit starts again, without asking (SonicAudio.resume).
  SA.resume(prefs().device);
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
    map: function () { return full ? JSON.parse(JSON.stringify(full.map())) : null; },
    memory: function () { return full ? full.memory() : null; },
    param: function (k, v) {
      var s = shell();
      var input = /** @type {HTMLInputElement | null} */ (s && s.querySelector('[data-viz-param="' + k + '"]'));
      if (!full || !input) return;
      input.value = String(v);
      setParam(input);
      setUrl();
    },
    cinema: function (on) { if (typeof on === 'boolean') setCinema(on, true); return cinema && isOpen(); },
    analysis: SA.snapshot,
    source: SA.source,
    listen: SA.listen,
    devices: function () { return inputs.slice(); },
    stop: SA.stop,
    background: function () { return !!bgHandle && html.hasAttribute('data-visualizer-bg'); },
  };
})();
