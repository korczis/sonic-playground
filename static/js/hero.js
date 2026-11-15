// The landing hero's mosaic turns: every few seconds one tile crossfades to a track from the pool
// the template rendered (<template data-hero-pool>, the next newest reviews with a video, with
// the same markup, image variants and labels as the visible tiles), and the hero's backdrop
// blends to that track's still. Nothing turns for readers who ask for reduced motion, while the
// pointer or focus is on the mosaic (a tile never moves under a click), or while the hero is off
// screen or the tab hidden.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var EVERY = 5000;
  var FADE = 700;

  Sonic.module('hero', function mount() {
    var mosaic = document.getElementById('hero-mosaic');
    var pool = /** @type {HTMLTemplateElement | null} */ (document.querySelector('template[data-hero-pool]'));
    var backdrop = document.querySelector('[data-hero-backdrop]');
    if (!mosaic || !pool) return null;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    var waiting = /** @type {HTMLElement[]} */ (Array.prototype.slice.call(pool.content.children));
    if (!waiting.length) return null;

    var held = false;
    var visible = true;
    var turn = 0;
    var hold = function () { held = true; };
    var free = function () { held = mosaic.contains(document.activeElement); };
    mosaic.addEventListener('pointerenter', hold);
    mosaic.addEventListener('pointerleave', free);
    mosaic.addEventListener('focusin', hold);
    mosaic.addEventListener('focusout', function () { setTimeout(free, 0); });
    var seen = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
    }) : null;
    if (seen) seen.observe(mosaic);

    /** Blend the backdrop to a tile's still: the new layer fades in over the old, then replaces it. */
    function blend(tile) {
      if (!backdrop) return;
      var img = tile.querySelector('img');
      if (!img) return;
      var layer = /** @type {HTMLImageElement} */ (img.cloneNode(false));
      layer.removeAttribute('data-thumb');
      layer.alt = '';
      layer.className = 'absolute inset-0 h-full w-full scale-110 object-cover opacity-0 blur-2xl transition-opacity duration-1000';
      backdrop.appendChild(layer);
      requestAnimationFrame(function () { requestAnimationFrame(function () { layer.style.opacity = '1'; }); });
      setTimeout(function () {
        while (backdrop.children.length > 1) backdrop.removeChild(backdrop.firstElementChild);
      }, 1100);
    }

    function step() {
      if (held || !visible || document.hidden) return;
      var tiles = /** @type {HTMLElement[]} */ (Array.prototype.slice.call(mosaic.querySelectorAll(':scope > [data-track]')));
      if (!tiles.length) return;
      // Walk the tiles in a scattered order so the change wanders over the mosaic.
      var out = tiles[(turn * 4) % tiles.length];
      turn += 1;
      var incoming = waiting.shift();
      var leaving = /** @type {HTMLElement} */ (out.cloneNode(true));
      var next = /** @type {HTMLElement} */ (incoming.cloneNode(true));
      // The tile keeps its place in the grid (its offset and visibility classes).
      next.className = out.className;
      next.style.transition = 'opacity ' + FADE + 'ms ease';
      next.style.opacity = '0';
      out.replaceWith(next);
      requestAnimationFrame(function () { requestAnimationFrame(function () { next.style.opacity = '1'; }); });
      leaving.className = incoming.className;
      waiting.push(leaving);
      blend(next);
    }

    var timer = window.setInterval(step, EVERY);
    var first = mosaic.querySelector(':scope > [data-track]');
    if (first) blend(/** @type {HTMLElement} */ (first));
    return function unmount() {
      clearInterval(timer);
      if (seen) seen.disconnect();
    };
  });
})();
