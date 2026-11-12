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
    return true;
  }

  function go(url, push) {
    document.documentElement.dataset.navigatingState = 'true';
    return fetch(url.href, { headers: { Accept: 'text/html' } }).then(function (r) {
      if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (push) history.pushState({ sonic: true }, '', url.href);
      if (!swap(doc)) throw new Error('no #main-content');
      current = location.pathname;
      if (url.hash) {
        var target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
      } else {
        window.scrollTo(0, 0);
      }
      // No initFlowbite(): it re-initialises every component of the document (the navbar's
      // tooltips included) and Popper then measures detached elements. #main-content holds no
      // Flowbite component; anything that needs one belongs outside it.
      Sonic.mountAll();
      var main = document.getElementById('main');
      if (main) main.focus({ preventScroll: true });
      var live = document.getElementById('route-announcer');
      if (live) live.textContent = document.title;
      document.documentElement.dataset.navigatingState = '';
      Sonic.emit('sonic:navigated', { url: location.href });
    }).catch(function () {
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
    // The same page with other query parameters is the explorer's own history; it handles it.
    if (location.pathname === current) return;
    go(new URL(location.href), false);
  });
})();
