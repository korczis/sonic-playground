// The page-module core. The site navigates without reloading (static/js/router.js) so that the
// player in the bottom bar keeps playing; every behaviour that lives inside #main-content is a
// module that mounts on a page and unmounts before the next one:
//
//   Sonic.module('explorer', function mount() { ...; return function unmount() { ... }; });
//
// Sonic.catalog() is the derived catalogue (static/data/catalog.json), fetched once and shared.
// Sonic.playIndex() is its projection for the player, the track menu and the random button
// (static/data/play.json, scripts/catalog.py PLAY_FIELDS): the same tracks in the same shape with
// only what they read; the catalogue itself serves when it is already loaded.
// Sonic.emit(name, detail) / Sonic.on(name, fn) is a tiny event bus on document.
(function () {
  'use strict';
  var modules = [];
  var mounted = [];
  var catalogPromise = null;
  var playPromise = null;
  var body = document.body;

  function mountOne(entry) {
    try {
      var unmount = entry.mount();
      return { name: entry.name, unmount: typeof unmount === 'function' ? unmount : null };
    } catch (error) {
      console.error('module ' + entry.name + ' failed to mount', error);
      return { name: entry.name, unmount: null };
    }
  }

  /** @type {SonicApi} the t() and locale() members are added by i18n.js */
  var Sonic = /** @type {any} */ ({
    base: (body.getAttribute('data-base-url') || '').replace(/\/$/, ''),
    module: function (name, mount) {
      var entry = { name: name, mount: mount };
      modules.push(entry);
      mounted.push(mountOne(entry));
    },
    unmountAll: function () {
      mounted.forEach(function (m) {
        if (!m.unmount) return;
        try { m.unmount(); } catch (error) { console.error('module ' + m.name + ' failed to unmount', error); }
      });
      mounted = [];
    },
    mountAll: function () {
      mounted = modules.map(mountOne);
      Sonic.emit('sonic:page', { url: window.location.href });
    },
    catalog: function () {
      if (!catalogPromise) {
        catalogPromise = fetch(body.getAttribute('data-catalog')).then(function (r) {
          if (!r.ok) throw new Error('catalogue: HTTP ' + r.status);
          return r.json();
        });
      }
      return catalogPromise;
    },
    playIndex: function () {
      if (catalogPromise) return catalogPromise;
      if (!playPromise) {
        playPromise = fetch(body.getAttribute('data-play-index')).then(function (r) {
          if (!r.ok) throw new Error('play index: HTTP ' + r.status);
          return r.json();
        });
      }
      return playPromise;
    },
    emit: function (name, detail) { document.dispatchEvent(new CustomEvent(name, { detail: detail })); },
    on: function (name, fn) {
      document.addEventListener(name, fn);
      return function () { document.removeEventListener(name, fn); };
    },
    // Load a script once (the chart library, the YouTube API); resolves when it has run.
    script: (function () {
      var loading = {};
      return function (src) {
        if (!loading[src]) {
          loading[src] = new Promise(function (resolve, reject) {
            var el = document.createElement('script');
            el.src = src;
            el.async = true;
            el.onload = resolve;
            el.onerror = function () { reject(new Error('script failed: ' + src)); };
            document.head.appendChild(el);
          });
        }
        return loading[src];
      };
    })(),
  });
  window.Sonic = Sonic;
})();
