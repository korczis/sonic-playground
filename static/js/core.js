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
  /** @param {string | null} url @param {string} what */
  function json(url, what) {
    return fetch(url || '').then(function (r) {
      if (!r.ok) throw new Error(what + ': HTTP ' + r.status);
      return r.json();
    });
  }

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
    // The catalogue and the play index are each fetched once per page life. A failed fetch is
    // forgotten, so the next call asks again: a cached rejection (a host's 503) used to leave
    // Play, Queue and Random dead until a reload.
    catalog: function () {
      if (!catalogPromise) {
        catalogPromise = json(body.getAttribute('data-catalog'), 'catalogue');
        catalogPromise.catch(function () { catalogPromise = null; });
      }
      return catalogPromise;
    },
    // Every track's playable fields: the catalogue when it is already here (it carries them),
    // else the small play index; a catalogue that failed falls back to the play index.
    playIndex: function () {
      var index = function () {
        if (!playPromise) {
          playPromise = json(body.getAttribute('data-play-index'), 'play index');
          playPromise.catch(function () { playPromise = null; });
        }
        return playPromise;
      };
      return catalogPromise ? catalogPromise.catch(index) : index();
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
