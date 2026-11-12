// The site's languages (ADR 0006). Every page is built in one language, <html lang>, with its
// counterparts in the others as <link rel="alternate" hreflang data-locale-href>. This module
//   - gives the browser code the strings of that language (static/data/i18n.json, derived from
//     data/i18n/*.toml by scripts/i18n.py) and re-applies them to the persistent shell (navbar,
//     player) after a router navigation into another language;
//   - turns the language switch into a link to the counterpart, and remembers the choice;
//   - on a first visit to the default language's home page (the x-default entry of the site) with
//     no choice remembered, takes a browser that prefers another language of the site to that
//     language's home page. Any other URL is the reader's or a link's explicit choice and stays
//     as it is; a remembered choice always wins.
//
//   <span data-i18n="key" data-i18n-vars='{"n": 3}'>…</span>      text
//   data-i18n-placeholder / -aria-label / -title / -alt="key"        attributes
//   Sonic.t('key', {n: 3})                                            browser code
//   Sonic.on('sonic:locale', fn)                                      re-render when the language changes
(function () {
  'use strict';
  var Sonic = window.Sonic;
  if (!Sonic) return;
  var KEY = 'sonic-locale';
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  var bundle = null;
  var locale = document.documentElement.lang;

  function format(text, vars) {
    return String(text).replace(/\{([a-z_]+)\}/g, function (m, name) {
      return vars && name in vars ? vars[name] : m;
    });
  }
  function strings(code) {
    return bundle && bundle.locales[code] ? bundle.locales[code].strings : {};
  }
  Sonic.t = function (key, vars) {
    var own = strings(locale);
    var fallback = strings(bundle && bundle.default);
    var text = key in own ? own[key] : (key in fallback ? fallback[key] : key);
    return format(text, vars);
  };
  Sonic.locale = function () { return locale; };
  /** The label of a taxonomy term in the current language (term.<facet>.<term>). */
  Sonic.term = function (kind, term) {
    var key = 'term.' + kind + '.' + term;
    var own = strings(locale);
    return key in own ? own[key] : term;
  };
  /** A site path in the current language: "genre/house/" -> "cs/genre/house/" under Czech. */
  Sonic.localPath = function (path) {
    return !bundle || locale === bundle.default ? path : locale + '/' + path;
  };

  /** A review's path in the current language: its translation's, else the default language's. */
  Sonic.trackPath = function (t) {
    var own = t && t.i18n && t.i18n[locale];
    return own && own.path ? own.path : (t && t.path) || '';
  };
  /** A term page's path in the current language, or the default language's while the current
   *  one has no review with that term yet (catalog.lang_terms). */
  Sonic.termPath = function (kind, slug, term, catalog) {
    var has = catalog && catalog.lang_terms && catalog.lang_terms[locale];
    if (has && has[kind] && has[kind].indexOf(term) < 0) return kind + '/' + slug + '/';
    return Sonic.localPath(kind + '/' + slug + '/');
  };

  function vars(el) {
    try { return JSON.parse(el.getAttribute('data-i18n-vars') || '{}'); } catch (e) { return {}; }
  }
  function apply(root) {
    if (!bundle) return;
    // Under <body> only: state flags live on <html> as data-*-state and must never be matched.
    (root || document.body).querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = Sonic.t(el.getAttribute('data-i18n'), vars(el));
    });
    ATTRS.forEach(function (attr) {
      (root || document.body).querySelectorAll('[data-i18n-' + attr + ']').forEach(function (el) {
        el.setAttribute(attr, Sonic.t(el.getAttribute('data-i18n-' + attr), vars(el)));
      });
    });
    /** @type {NodeListOf<HTMLSelectElement>} */ (document.querySelectorAll('[data-locale-switch]')).forEach(function (select) { select.value = locale; });
  }
  /** The page in another language, from the alternates the build wrote into <head>. */
  function counterpart(code) {
    var link = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[data-locale-href="' + code + '"]'));
    return link ? link.href : null;
  }
  function remember(code) {
    try { localStorage.setItem(KEY, code); } catch (e) {}
  }
  function go(code) {
    var href = counterpart(code);
    if (!href) return;
    if (window.SonicRouter) window.SonicRouter.go(href + location.search + location.hash);
    else location.assign(href + location.search + location.hash);
  }
  /** The first language of the site the browser prefers, or null. */
  function preferred() {
    var tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    var wanted = Array.prototype.map.call(tags, function (tag) { return String(tag).toLowerCase().split('-')[0]; });
    for (var i = 0; i < wanted.length; i++) if (bundle && bundle.locales[wanted[i]]) return wanted[i];
    return null;
  }

  fetch(document.body.getAttribute('data-i18n-bundle')).then(function (r) { return r.json(); }).then(function (data) {
    bundle = data;
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var entry = location.pathname.replace(/\/?$/, '/') === new URL(Sonic.base + '/', location.href).pathname;
    if (!saved && entry) {
      var want = preferred();
      if (want) remember(want);
      var target = want && want !== locale ? counterpart(want) : null;
      if (target) {
        document.documentElement.dataset.i18nState = 'redirecting';
        location.replace(target + location.search + location.hash);
        return;
      }
    }
    apply();
    document.documentElement.dataset.i18nState = 'ready';
  }).catch(function () { document.documentElement.dataset.i18nState = 'failed'; });

  document.addEventListener('change', function (event) {
    var target = /** @type {HTMLSelectElement} */ (event.target);
    if (!target.matches || !target.matches('[data-locale-switch]') || target.value === locale) return;
    remember(target.value);
    go(target.value);
  });
  // A router navigation may enter another language: the page says which (router.js copies its
  // <html lang>), the shell follows.
  Sonic.on('sonic:navigated', function () {
    var next = document.documentElement.lang;
    if (next === locale) return;
    locale = next;
    apply();
    Sonic.emit('sonic:locale', { locale: locale });
  });
  Sonic.on('sonic:page', function () { apply(); });
})();
