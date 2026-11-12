// Switchable interface language. The build renders the default locale; this switches the page to
// any locale of static/data/i18n.json (derived from data/i18n/*.toml by scripts/i18n.py) without
// a reload, remembers the choice, and re-applies it after every router navigation.
//
//   <span data-i18n="key" data-i18n-vars='{"n": 3}'>…</span>      text
//   data-i18n-placeholder / -aria-label / -title / -alt="key"        attributes
//   Sonic.t('key', {n: 3})                                            browser code
//   Sonic.on('sonic:locale', fn)                                      re-render on a switch
//   <span data-locale-group><span data-locale-text="en">…</span><span data-locale-text="cs" hidden>…</span></span>
//                                                                     localised data (concepts)
(function () {
  'use strict';
  var Sonic = window.Sonic;
  if (!Sonic) return;
  var KEY = 'sonic-locale';
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  var bundle = null;
  var locale = null;

  function format(text, vars) {
    return String(text).replace(/\{([a-z_]+)\}/g, function (m, name) {
      return vars && name in vars ? vars[name] : m;
    });
  }
  function strings(code) {
    return bundle && bundle.locales[code] ? bundle.locales[code].strings : {};
  }
  Sonic.t = function (key, vars) {
    var own = strings(locale || (bundle && bundle.default));
    var fallback = strings(bundle && bundle.default);
    var text = key in own ? own[key] : (key in fallback ? fallback[key] : key);
    return format(text, vars);
  };
  Sonic.locale = function () { return locale || (bundle && bundle.default) || document.documentElement.lang; };

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
    document.documentElement.lang = Sonic.locale();
    /** @type {NodeListOf<HTMLSelectElement>} */ (document.querySelectorAll('[data-locale-switch]')).forEach(function (select) { select.value = Sonic.locale(); });
    // Localised data (a concept's definition in every locale): the one of the current locale
    // shows, the default one when the current has none.
    var code = Sonic.locale();
    /** @type {NodeListOf<HTMLElement>} */ ((root || document.body).querySelectorAll('[data-locale-group]')).forEach(function (group) {
      var parts = /** @type {HTMLElement[]} */ (Array.prototype.slice.call(group.querySelectorAll('[data-locale-text]')));
      var has = parts.some(function (p) { return p.dataset.localeText === code; });
      var show = has ? code : (bundle && bundle.default);
      parts.forEach(function (p) { p.hidden = p.dataset.localeText !== show; });
    });
    var note = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-locale-note]'));
    note.forEach(function (el) { el.hidden = !Sonic.t('locale.content_note'); });
  }
  function use(code, announce) {
    if (!bundle || !bundle.locales[code]) return;
    locale = code;
    try { localStorage.setItem(KEY, code); } catch (e) {}
    apply();
    if (announce) Sonic.emit('sonic:locale', { locale: code });
  }

  fetch(document.body.getAttribute('data-i18n-bundle')).then(function (r) { return r.json(); }).then(function (data) {
    bundle = data;
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var wanted = new URLSearchParams(location.search).get('lang') || saved;
    use(wanted && data.locales[wanted] ? wanted : data.default, true);
    document.documentElement.dataset.i18nState = 'ready';
  }).catch(function () { document.documentElement.dataset.i18nState = 'failed'; });

  document.addEventListener('change', function (event) {
    var target = /** @type {HTMLSelectElement} */ (event.target);
    if (target.matches && target.matches('[data-locale-switch]')) use(target.value, true);
  });
  Sonic.on('sonic:page', function () { apply(); });
})();
