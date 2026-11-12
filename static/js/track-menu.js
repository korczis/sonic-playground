// The track menu: one popover for every "⋯" trigger ([data-track-menu="<source>"]), with labelled
// actions (play now, play next, add to / remove from the queue, radio, open the review, copy the
// link). On a phone it is a bottom sheet. Its items get the player's data-play* attributes when it
// opens, so static/js/player.js performs them; this file only opens, places, and closes the menu.
// Keyboard: arrows, Home/End move; Escape and Tab close and return focus to the trigger.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  var menu = document.getElementById('track-menu');
  var backdrop = document.getElementById('track-menu-backdrop');
  if (!Sonic || !menu || !backdrop) return;
  /** @param {string} name @returns {HTMLElement} */
  var item = function (name) { return /** @type {HTMLElement} */ (menu.querySelector('[data-menu-item="' + name + '"]')); };
  var title = /** @type {HTMLElement} */ (menu.querySelector('[data-track-menu-title]'));
  var queueLabel = /** @type {HTMLElement} */ (menu.querySelector('[data-menu-queue-label]'));
  /** @type {HTMLElement | null} */
  var trigger = null;
  var url = '';

  function items() {
    return /** @type {HTMLElement[]} */ (Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')));
  }
  function place() {
    if (!trigger) return;
    if (window.matchMedia('(max-width: 639.98px)').matches) { menu.style.left = ''; menu.style.top = ''; return; }
    var r = trigger.getBoundingClientRect();
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var below = r.bottom + 6;
    var top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
  /** @param {HTMLElement} from @param {string} source */
  function open(from, source) {
    Sonic.catalog().then(function (c) {
      var t = c.tracks.find(function (x) { return x.source === source; });
      if (!t) return;
      close(false);
      trigger = from;
      url = Sonic.base + '/' + Sonic.trackPath(t);
      title.textContent = t.artist + ' – ' + t.track;
      var player = window.SonicPlayer;
      var s = player ? player.state() : { queue: [], index: -1 };
      var at = -1;
      s.queue.forEach(function (q, i) { if (q.source === source) at = i; });
      var queued = at > s.index;
      queueLabel.textContent = queued ? Sonic.t('trackmenu.queue_remove') : Sonic.t('trackmenu.queue_add');
      ['play', 'next', 'queue', 'radio'].forEach(function (n) { item(n).hidden = !t.youtube; });
      item('play').dataset.play = source;
      item('next').dataset.playNext = source;
      item('queue').dataset.queue = source;
      item('radio').dataset.playRadio = source;
      /** @type {HTMLAnchorElement} */ (item('open')).href = url;
      menu.hidden = false;
      backdrop.hidden = false;
      from.setAttribute('aria-expanded', 'true');
      place();
      var first = items().filter(function (e) { return !e.hidden; })[0];
      if (first) first.focus();
    });
  }
  /** @param {boolean} [refocus] */
  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    backdrop.hidden = true;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (refocus) trigger.focus();
    }
    trigger = null;
  }

  document.addEventListener('click', function (e) {
    var target = /** @type {Element} */ (e.target);
    var opener = /** @type {HTMLElement | null} */ (target.closest && target.closest('[data-track-menu]'));
    if (opener) {
      e.preventDefault();
      if (trigger === opener) { close(true); return; }
      open(opener, opener.dataset.trackMenu || '');
      return;
    }
    var chosen = /** @type {HTMLElement | null} */ (target.closest && target.closest('#track-menu [data-menu-item]'));
    if (chosen) {
      if (chosen.dataset.menuItem === 'copy') {
        e.preventDefault();
        var done = function () { if (window.SonicPlayer) window.SonicPlayer.notify(Sonic.t('trackmenu.copied')); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done); else done();
      }
      // The player's own listener has read the item's data-play* already (same event).
      setTimeout(function () { close(chosen.dataset.menuItem !== 'open'); }, 0);
      return;
    }
    if (target === backdrop) close(true);
  });
  menu.addEventListener('keydown', function (e) {
    var list = items().filter(function (x) { return !x.hidden; });
    var i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(true); }
  });
  window.addEventListener('resize', place);
  // The page scrolls inside #main-content: the menu follows its trigger instead of closing.
  document.addEventListener('scroll', function () { if (!menu.hidden) place(); }, true);
  Sonic.on('sonic:navigated', function () { close(false); });
})();
