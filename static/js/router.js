// Navigation without reloading, so the player in the bottom bar never stops. A click on a link of
// this site (or a GET form of this site) fetches the next page, swaps #main-content and the
// sidebar's navigation, updates the title, the description and the URL, then remounts the page
// modules (static/js/core.js). Anything unusual falls back to an ordinary page load: another
// origin, a file that is not a page, a modifier key, target, download, or a failed fetch.
(function () {
  'use strict';
  var Sonic = window.Sonic;
  if (!Sonic || !window.fetch || !window.DOMParser || !history.pushState) return;
  var base = Sonic.base;
  var current = location.pathname;
  var NOT_A_PAGE = /\.(xml|json|txt|png|jpe?g|webp|svg|ico|css|js|pdf|zip)$/i;

  function internal(url) {
    return url.origin === location.origin && (url.pathname + '/').indexOf(new URL(base + '/').pathname) === 0
      && !NOT_A_PAGE.test(url.pathname);
  }

  function swap(doc) {
    var next = doc.getElementById('main-content');
    var here = document.getElementById('main-content');
    if (!next || !here) return false;
    Sonic.unmountAll();
    here.innerHTML = next.innerHTML;
    var nextNav = doc.querySelector('#sidebar nav');
    var hereNav = document.querySelector('#sidebar nav');
    if (nextNav && hereNav) hereNav.innerHTML = nextNav.innerHTML;
    document.title = doc.title;
    ['description', 'og:title', 'og:description', 'og:url', 'og:image'].forEach(function (key) {
      var sel = key.indexOf('og:') === 0 ? 'meta[property="' + key + '"]' : 'meta[name="' + key + '"]';
      var a = document.querySelector(sel);
      var b = doc.querySelector(sel);
      if (a && b) a.setAttribute('content', b.getAttribute('content'));
    });
    var canonical = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel="canonical"]'));
    var nextCanonical = /** @type {HTMLLinkElement | null} */ (doc.querySelector('link[rel="canonical"]'));
    if (canonical && nextCanonical) canonical.href = nextCanonical.href;
    // The language of the page (ADR 0006) and its counterparts in every language: the persistent
    // shell (navbar, player) follows it, the language switch links the new counterparts.
    document.documentElement.lang = doc.documentElement.lang || document.documentElement.lang;
    // What <body> carries per page (the search index of the page's language): the new page's.
    Array.prototype.forEach.call(doc.body.attributes, function (a) {
      if (a.name.indexOf('data-') === 0) document.body.setAttribute(a.name, a.value);
    });
    document.querySelectorAll('link[data-locale-href]').forEach(function (link) { link.remove(); });
    doc.querySelectorAll('link[data-locale-href]').forEach(function (link) {
      document.head.appendChild(document.importNode(link, true));
    });
    // The persistent shell's destinations that depend on the page's language (data-follows-page:
    // the logo, the search form, the feed): the new page's, as a reload would render them.
    document.querySelectorAll('[data-follows-page]').forEach(function (el) {
      var twin = doc.querySelector('[data-follows-page="' + el.getAttribute('data-follows-page') + '"]');
      if (!twin) return;
      ['href', 'action'].forEach(function (name) {
        var value = twin.getAttribute(name);
        if (value !== null) el.setAttribute(name, value);
      });
    });
    return true;
  }

  // Only the latest navigation lands: an earlier click whose page arrives later (a slow
  // connection) is dropped and its request aborted, never committed over the newer page.
  var navigation = 0;
  // Back and Forward return the reader to where they were: each entry keeps its scroll position
  // (window and #main-content), saved when the page is left and restored after the page mounts.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  function scrollPosition() {
    var main = document.getElementById('main-content');
    return { x: window.scrollX, y: window.scrollY, main: main ? main.scrollTop : 0 };
  }
  function remember() {
    history.replaceState(Object.assign({}, history.state || {}, { sonic: true, scroll: scrollPosition() }), '');
  }
  // The position is kept in the current entry while the reader scrolls (debounced), not only when
  // a link is followed: Back and Forward leave a page through native history, with no moment to
  // save it, so Forward used to return to the top.
  // A pending save belongs to the entry it was scrolled in. Back and Forward switch the entry
  // before the router hears of it, so popstate drops the pending save (it would write the old
  // page's position into the new entry: Forward came back at 0 on CI, run 43669472966), and while
  // a page is being fetched the document on screen still belongs to the previous entry, so its
  // scrolling is not saved at all.
  var saving = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  var moving = false;
  function keep() {
    if (moving) return;
    clearTimeout(saving);
    saving = setTimeout(remember, 150);
  }
  window.addEventListener('scroll', keep, { passive: true });
  document.addEventListener('scroll', function (event) {
    if (event.target && /** @type {Element} */ (event.target).id === 'main-content') keep();
  }, { capture: true, passive: true });
  function restore(at) {
    var main = document.getElementById('main-content');
    if (main) main.scrollTop = at.main || 0;
    window.scrollTo(at.x || 0, at.y || 0);
  }
  var inflight = /** @type {AbortController | null} */ (null);
  function go(url, push) {
    var mine = ++navigation;
    clearTimeout(saving);
    if (push) remember();
    moving = true;
    if (inflight) inflight.abort();
    inflight = new AbortController();
    document.documentElement.dataset.navigatingState = 'true';
    return fetch(url.href, { headers: { Accept: 'text/html' }, signal: inflight.signal }).then(function (r) {
      if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      if (mine !== navigation) return;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (push) history.pushState({ sonic: true }, '', url.href);
      if (!swap(doc)) throw new Error('no #main-content');
      current = location.pathname;
      var saved = !push && history.state && history.state.scroll;
      if (saved) {
        // Restored after the page mounts (below): the explorer unfolds its results first.
      } else if (url.hash) {
        var target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
      } else {
        window.scrollTo(0, 0);
      }
      // No initFlowbite(): it re-initialises every component of the document (the navbar's
      // tooltips included) and Popper then measures detached elements. #main-content holds no
      // Flowbite component; anything that needs one belongs outside it.
      Sonic.mountAll();
      if (saved) restore(saved);
      moving = false;
      var main = document.getElementById('main');
      if (main) main.focus({ preventScroll: true });
      var live = document.getElementById('route-announcer');
      if (live) live.textContent = document.title;
      document.documentElement.dataset.navigatingState = '';
      Sonic.emit('sonic:navigated', { url: location.href });
    }).catch(function () {
      if (mine !== navigation) return; // superseded (aborted or late): the newer one decides
      moving = false;
      location.href = url.href; // anything unexpected: an ordinary page load
    });
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey) return;
    var origin = /** @type {Element} */ (event.target);
    var a = /** @type {HTMLAnchorElement | null} */ (origin.closest && origin.closest('a[href]'));
    if (!a || a.target || a.hasAttribute('download') || a.getAttribute('rel') === 'external') return;
    var url = new URL(a.href, location.href);
    if (!internal(url)) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    if (url.pathname === location.pathname && url.search === location.search) return;
    go(url, true);
  });

  document.addEventListener('submit', function (event) {
    var form = /** @type {HTMLFormElement} */ (event.target);
    if (event.defaultPrevented || (form.method || 'get').toLowerCase() !== 'get') return;
    var url = new URL(form.action || location.href, location.href);
    if (!internal(url)) return;
    event.preventDefault();
    var params = new URLSearchParams();
    new FormData(form).forEach(function (value, name) { params.append(name, String(value)); });
    url.search = params.toString();
    go(url, true);
  });

  window.SonicRouter = { go: function (href) { go(new URL(href, location.href), true); } };

  window.addEventListener('popstate', function () {
    clearTimeout(saving);
    // The same page with other query parameters is the explorer's own history; it handles it.
    if (location.pathname === current) return;
    go(new URL(location.href), false);
  });
})();
