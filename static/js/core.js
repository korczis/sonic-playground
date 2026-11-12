// The page-module core. The site navigates without reloading (static/js/router.js) so that the
// player in the bottom bar keeps playing; every behaviour that lives inside #main-content is a
// module that mounts on a page and unmounts before the next one:
//
//   Sonic.module('explorer', function mount() { ...; return function unmount() { ... }; });
//
// Sonic.catalog() is the derived catalogue (static/data/catalog.json), fetched once and shared.
// Sonic.emit(name, detail) / Sonic.on(name, fn) is a tiny event bus on document.
(function () {
  'use strict';
  var modules = [];
  var mounted = [];
  var catalogPromise = null;
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

  var Sonic = {
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
  };
  window.Sonic = Sonic;
})();
