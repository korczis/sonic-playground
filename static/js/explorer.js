// The explorer on the home page: faceted filtering, text search and sorting over the cards the
// build rendered (their data-* attributes mirror static/data/catalog.json). State lives in the
// URL (?q=&genre=&sentiment=&mood=&sort=), so every view is a link; without this script the
// form still submits and the page shows every track. A query ranks the matches by relevance
// unless the reader chose another order (the URL keeps only a sort that is not the default).
// A page module (static/js/core.js): mounts on every page that has the explorer, and unmounts
// the listeners it put outside #main-content when the router leaves the page.
window.Sonic.module('explorer', function mount() {
  'use strict';
  var form = /** @type {HTMLFormElement | null} */ (document.querySelector('form[data-explorer]'));
  var grid = /** @type {HTMLElement | null} */ (document.querySelector('div[data-explorer-grid]'));
  if (!form || !grid) return null;
  var cleanup = [];

  var cards = Array.prototype.slice.call(grid.querySelectorAll('[data-track]'));
  var status = /** @type {HTMLElement | null} */ (document.querySelector('[data-explorer-status]'));
  var empty = /** @type {HTMLElement | null} */ (document.querySelector('[data-explorer-empty]'));
  var reset = /** @type {HTMLElement | null} */ (document.querySelector('[data-explorer-reset]'));
  var submit = /** @type {HTMLElement | null} */ (document.querySelector('[data-explorer-submit]'));
  var query = /** @type {HTMLInputElement} */ (form.elements.namedItem('q'));
  var sort = /** @type {HTMLSelectElement} */ (form.elements.namedItem('sort'));
  var facets = Array.prototype.slice.call(form.querySelectorAll('[data-facet]'));
  var KEYS = ['q', 'sort'].concat(facets.map(function (s) { return s.name; }));
  // Matches beyond the first PAGE are rendered but folded ([data-overflow]) behind "Show more";
  // they stay matches, so "Play these" still queues every one of them.
  var PAGE = Number(grid.getAttribute('data-page') || 24);
  var limit = PAGE;
  var more = /** @type {HTMLElement | null} */ (document.querySelector('[data-explorer-more]'));
  // The order the reader chose ('' until then): with it unset, a query sorts by relevance and
  // no query sorts newest first.
  var chosen = '';

  // How a word is read (catalog.json `search`, derived by scripts/catalog.py from its fold
  // table and data/i18n/forms/<lang>.toml): the review index was cut with the same rules, so a
  // query word and a review word meet in one form ("synthesizers" is "synthesizer").
  var rules = /** @type {SonicSearchRules} */ (
    JSON.parse(form.getAttribute('data-search-rules') || '{}'));
  var FOLD = rules.fold || {};
  var SUFFIXES = (rules.forms && rules.forms.suffixes) || [];
  var MIN_STEM = (rules.forms && rules.forms.min_stem) || 0;

  // A word in its form: the first suffix that ends it decides, a stem shorter than MIN_STEM
  // leaves it as it is (scripts/catalog.py word_form).
  function wordForm(word) {
    for (var i = 0; i < SUFFIXES.length; i += 1) {
      var suffix = SUFFIXES[i][0];
      if (word.slice(-suffix.length) === suffix) {
        var stem = word.slice(0, word.length - suffix.length);
        return stem.length >= MIN_STEM ? stem + SUFFIXES[i][1] : word;
      }
    }
    return word;
  }

  // The tokens of a text exactly as scripts/catalog.py search_tokens cuts a review: lowercase,
  // the fold table's letters, no diacritics, split at everything but a-z and 0-9 (so
  // "four-on-the-floor" and "TB-303" are runs of tokens), every token kept, each in its form.
  function tokens(text) {
    return text.toLowerCase().replace(/[\u0080-\uffff]/g, function (c) { return FOLD[c] || c; })
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean).map(wordForm);
  }

  // A text as the matcher reads it: its tokens between spaces, so ' w ' is the whole word w and
  // ' w' a word that starts with w.
  function field(text) { return ' ' + tokens(text).join(' ') + ' '; }

  // Cards come in the catalogue's order (newest first, scripts/catalog.py publication_order):
  // `rank` keeps that order between reviews of the same day.
  var items = cards.map(function (el, rank) {
    var d = el.dataset;
    var terms = {};
    facets.forEach(function (s) {
      terms[s.name] = (d[s.name] || '').split('|').filter(Boolean);
    });
    return {
      el: el, source: d.source || '', title: d.title || '', artist: d.artist || '',
      date: d.date || '', rank: rank, terms: terms, hit: true, score: 0,
      words: {
        title: field(d.title || ''), artist: field(d.artist || ''), text: field(d.text || ''),
        review: '',
      },
    };
  });

  // The words of every review (static/data/search.json, derived by scripts/catalog.py), loaded
  // once, on the first query; until it arrives the query matches the card text only.
  var reviewIndex = 'idle';
  var alive = true;
  function loadReviews() {
    var url = document.body.getAttribute('data-search');
    if (reviewIndex !== 'idle' || !url || !window.fetch) return;
    reviewIndex = 'loading';
    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!alive) return; // the explorer was left: its late answer must not touch the next page
      if (!data || !data.tracks) { reviewIndex = 'failed'; return; }
      items.forEach(function (it) {
        it.words.review = ' ' + (data.tracks[it.source] || '') + ' ';
      });
      reviewIndex = 'ready';
      document.documentElement.dataset.reviewsState = 'ready';
      render(false);
    }).catch(function () { reviewIndex = 'failed'; });
  }

  function byDefault(q) { return q ? 'relevance' : 'new'; }

  function state() {
    var q = query.value.trim();
    var s = { q: q, sort: chosen || byDefault(q), units: parse(q) };
    facets.forEach(function (sel) { s[sel.name] = sel.value; });
    return s;
  }

  // The query as units that must all match, each a run of tokens side by side: a quoted
  // phrase ("basová linka", „…“ too), a word punctuation cuts into several tokens (tb-303),
  // or a plain word. The last of several unquoted words is the one being typed: it is open.
  function parse(q) {
    var units = [];
    q.replace(/["“”„]([^"“”„]*)["“”„]?|[^\s"“”„]+/g, function (m, phrase) {
      var t = tokens(phrase === undefined ? m : phrase);
      if (t.length) units.push({ tokens: t, quoted: phrase !== undefined, open: false });
      return m;
    });
    var last = units[units.length - 1];
    if (units.length > 1 && !last.quoted) last.open = true;
    return units;
  }

  // What each unit looks for: its whole words in a track's card text (artist, title,
  // description, terms) or review, so "art" is not "start" nor "artist". An open unit ("say yes
  // do"), or one no track has as whole words ("synthesiz"), is read as unfinished: its last
  // token matches the start of a word.
  function patterns(units) {
    return units.map(function (u) {
      var whole = ' ' + u.tokens.join(' ') + ' ';
      return !u.open && items.some(function (it) {
        return it.words.text.indexOf(whole) >= 0 || it.words.review.indexOf(whole) >= 0;
      }) ? whole : whole.slice(0, -1);
    });
  }

  function count(hay, p) {
    var n = 0;
    for (var i = hay.indexOf(p); i >= 0 && n < 4; i = hay.indexOf(p, i + 1)) n += 1;
    return n;
  }

  // Whether a field is the whole query: equal to it, or, when its last word is unfinished,
  // equal but for the rest of that word ("say yes do" is the artist "Say Yes Dog").
  function isAll(f, all) {
    return f === all || (all.slice(-1) !== ' ' && f.indexOf(all) === 0
      && f.indexOf(' ', all.length) === f.length - 1);
  }

  // Relevance: the whole query as the title or the artist first, then side by side in either,
  // then side by side in the card's text or the review; then each unit by where it stands: the
  // title or the artist, the card's text, the review (how often).
  function score(it, pats) {
    var w = it.words;
    var all = pats.join('').replace(/ {2}/g, ' ');
    var s = (isAll(w.title, all) || isAll(w.artist, all) ? 64 : 0)
      + (w.title.indexOf(all) >= 0 || w.artist.indexOf(all) >= 0 ? 16 : 0)
      + (w.text.indexOf(all) >= 0 || w.review.indexOf(all) >= 0 ? 12 : 0);
    pats.forEach(function (p) {
      s += (w.title.indexOf(p) >= 0 || w.artist.indexOf(p) >= 0 ? 8 : 0)
        + (w.text.indexOf(p) >= 0 ? 2 : 0) + count(w.review, p);
    });
    return s;
  }

  // A track matches when every unit of the query is in its text (it.hit, set by render) and it
  // carries every chosen facet term; `skip` leaves one facet out, to count what choosing
  // another term would give.
  function matches(it, s, skip) {
    for (var i = 0; i < facets.length; i += 1) {
      var name = facets[i].name;
      if (name !== skip && s[name] && it.terms[name].indexOf(s[name]) < 0) return false;
    }
    return it.hit;
  }

  var ORDER = {
    relevance: function (a, b) { return b.score - a.score || ORDER.new(a, b); },
    new: function (a, b) { return b.date.localeCompare(a.date) || a.rank - b.rank; },
    old: function (a, b) { return a.date.localeCompare(b.date) || b.rank - a.rank; },
    artist: function (a, b) { return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title); },
    title: function (a, b) { return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist); },
  };

  function render(push) {
    var s = state();
    if (s.q) loadReviews();
    sort.value = s.sort;
    var pats = patterns(s.units);
    items.forEach(function (it) {
      var w = it.words;
      it.hit = pats.every(function (p) {
        return w.text.indexOf(p) >= 0 || w.review.indexOf(p) >= 0;
      });
      it.score = it.hit && pats.length ? score(it, pats) : 0;
    });
    var shown = 0;
    var sorted = items.slice().sort(ORDER[s.sort] || ORDER.new);
    var frag = document.createDocumentFragment();
    sorted.forEach(function (it) {
      var ok = matches(it, s, null);
      it.el.hidden = !ok;
      if (ok) shown += 1;
      it.el.toggleAttribute('data-overflow', ok && shown > limit);
      frag.appendChild(it.el);
    });
    if (more) {
      more.hidden = shown <= limit;
      more.textContent = window.Sonic.t('explorer.more', { page: Math.min(PAGE, shown - limit), left: shown - limit });
    }
    grid.appendChild(frag);

    // Facet counts follow the other filters; a term that would give nothing is disabled.
    facets.forEach(function (sel) {
      var counts = {};
      items.forEach(function (it) {
        if (!matches(it, s, sel.name)) return;
        it.terms[sel.name].forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      });
      Array.prototype.forEach.call(sel.options, function (opt) {
        if (!opt.value) return;
        var n = counts[opt.value] || 0;
        opt.textContent = (opt.getAttribute('data-label') || opt.value) + ' (' + n + ')';
        opt.disabled = n === 0 && opt.value !== sel.value;
      });
    });

    if (status) {
      status.textContent = shown === items.length
        ? window.Sonic.t('explorer.status_all', { n: items.length })
        : window.Sonic.t('explorer.status_some', { shown: shown, n: items.length });
    }
    if (empty) empty.hidden = shown !== 0;
    grid.hidden = shown === 0;

    // The explorer owns its KEYS only; every other component's state in the URL (the
    // visualiser's viz keys, the player's play and t) is kept, or a deep link to it would be
    // erased on the home page's first render.
    var params = new URLSearchParams(window.location.search);
    KEYS.forEach(function (k) { params.delete(k); });
    KEYS.forEach(function (k) {
      var v = k === 'q' ? s.q : k === 'sort' ? (s.sort === byDefault(s.q) ? '' : s.sort)
        : /** @type {HTMLSelectElement} */ (form.elements.namedItem(k)).value;
      if (v) params.set(k, v);
    });
    var url = window.location.pathname + (params.toString() ? '?' + params : '');
    if (url !== window.location.pathname + window.location.search) {
      window.history[push ? 'pushState' : 'replaceState'](null, '', url);
    }
    /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-search-input]')).forEach(function (el) {
      if (el !== document.activeElement) el.value = query.value;
    });
  }

  function load() {
    limit = (history.state && history.state.explorerLimit) || PAGE;
    var params = new URLSearchParams(window.location.search);
    query.value = params.get('q') || '';
    // A sort the select does not offer leaves its value empty: the default for the query.
    sort.value = params.get('sort') || '';
    chosen = sort.value;
    facets.forEach(function (sel) {
      var v = params.get(sel.name) || '';
      sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === v; })
        ? v : '';
    });
    render(false);
  }

  var timer = null;
  query.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { limit = PAGE; render(false); }, 120);
  });
  // The sort's own listener runs first: the reader's choice, kept until a reset.
  sort.addEventListener('change', function () { chosen = sort.value; });
  form.addEventListener('change', function () { limit = PAGE; render(true); });
  form.addEventListener('submit', function (event) { event.preventDefault(); limit = PAGE; render(true); });
  if (more) {
    more.addEventListener('click', function () {
      limit += PAGE;
      render(false);
      // Kept in this history entry: Back from a review shows as many results as were open.
      history.replaceState(Object.assign({}, history.state || {}, { explorerLimit: limit }), '');
    });
  }
  if (reset) {
    reset.addEventListener('click', function (event) {
      event.preventDefault();
      form.reset();
      chosen = '';
      limit = PAGE;
      render(true);
      query.focus();
    });
  }
  if (submit) submit.classList.add('sm:hidden');
  window.addEventListener('popstate', load);
  cleanup.push(function () { window.removeEventListener('popstate', load); });

  // The navbar search on this page drives the explorer instead of reloading it.
  /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-search-input]')).forEach(function (el) {
    function onInput() {
      query.value = el.value;
      clearTimeout(timer);
      timer = setTimeout(function () { render(false); }, 120);
    }
    function onSubmit(event) {
      event.preventDefault();
      query.value = el.value;
      render(true);
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    el.addEventListener('input', onInput);
    if (el.form) el.form.addEventListener('submit', onSubmit);
    cleanup.push(function () {
      el.removeEventListener('input', onInput);
      if (el.form) el.form.removeEventListener('submit', onSubmit);
    });
  });

  // The interface language can change under the explorer: re-render its own strings.
  cleanup.push(window.Sonic.on('sonic:locale', function () { render(false); }));
  load();
  document.documentElement.dataset.explorerState = 'ready';
  return function unmount() {
    alive = false;
    clearTimeout(timer);
    cleanup.forEach(function (fn) { fn(); });
    document.documentElement.dataset.explorerState = '';
  };
});
