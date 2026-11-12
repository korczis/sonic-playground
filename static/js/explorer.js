// The explorer on the home page: faceted filtering, text search and sorting over the cards the
// build rendered (their data-* attributes mirror static/data/catalog.json). State lives in the
// URL (?q=&genre=&sentiment=&mood=&sort=), so every view is a link; without this script the
// form still submits and the page shows every track.
// A page module (static/js/core.js): mounts on every page that has the explorer, and unmounts
// the listeners it put outside #main-content when the router leaves the page.
window.Sonic.module('explorer', function mount() {
  'use strict';
  var form = document.querySelector('form[data-explorer]');
  var grid = document.querySelector('div[data-explorer-grid]');
  if (!form || !grid) return null;
  var cleanup = [];

  var cards = Array.prototype.slice.call(grid.querySelectorAll('[data-track]'));
  var status = document.querySelector('[data-explorer-status]');
  var empty = document.querySelector('[data-explorer-empty]');
  var reset = document.querySelector('[data-explorer-reset]');
  var submit = document.querySelector('[data-explorer-submit]');
  var query = form.elements.q;
  var sort = form.elements.sort;
  var facets = Array.prototype.slice.call(form.querySelectorAll('[data-facet]'));
  var KEYS = ['q', 'sort'].concat(facets.map(function (s) { return s.name; }));

  var items = cards.map(function (el) {
    var d = el.dataset;
    var terms = {};
    facets.forEach(function (s) {
      terms[s.name] = (d[s.name] || '').split('|').filter(Boolean);
    });
    return {
      el: el, source: d.source || '', title: d.title || '', artist: d.artist || '',
      date: d.date || '', text: (d.text || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''),
      review: '', terms: terms,
    };
  });

  // The words of every review (static/data/search.json, derived by scripts/catalog.py), loaded
  // once, on the first query; until it arrives the query matches the card text only.
  var reviewIndex = 'idle';
  function loadReviews() {
    var url = document.body.getAttribute('data-search');
    if (reviewIndex !== 'idle' || !url || !window.fetch) return;
    reviewIndex = 'loading';
    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.tracks) { reviewIndex = 'failed'; return; }
      items.forEach(function (it) { it.review = data.tracks[it.source] || ''; });
      reviewIndex = 'ready';
      document.documentElement.dataset.reviews = 'ready';
      render(false);
    }).catch(function () { reviewIndex = 'failed'; });
  }

  function fold(s) {
    return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  }

  function state() {
    var s = { q: fold(query.value), sort: sort.value || 'new' };
    facets.forEach(function (sel) { s[sel.name] = sel.value; });
    return s;
  }

  // A track matches when every word of the query is in its text and it carries every chosen
  // facet term; `skip` leaves one facet out, to count what choosing another term would give.
  function matches(it, s, skip) {
    for (var i = 0; i < facets.length; i += 1) {
      var name = facets[i].name;
      if (name !== skip && s[name] && it.terms[name].indexOf(s[name]) < 0) return false;
    }
    if (!s.q) return true;
    // The query is tokenised exactly as scripts/catalog.py tokenises the reviews (letters and
    // digits; punctuation splits), so "four-on-the-floor" finds a review that says it. The
    // review index keeps words of 3+ letters; shorter tokens match the card text only.
    var words = s.q.split(/[^a-z0-9]+/).filter(Boolean);
    for (var w = 0; w < words.length; w += 1) {
      var word = words[w];
      var inCard = it.text.indexOf(word) >= 0;
      var inReview = word.length > 2 && it.review.indexOf(word) >= 0;
      if (!inCard && !inReview) return false;
    }
    return true;
  }

  var ORDER = {
    new: function (a, b) { return b.date.localeCompare(a.date) || a.title.localeCompare(b.title); },
    old: function (a, b) { return a.date.localeCompare(b.date) || a.title.localeCompare(b.title); },
    artist: function (a, b) { return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title); },
    title: function (a, b) { return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist); },
  };

  function render(push) {
    var s = state();
    if (s.q) loadReviews();
    var shown = 0;
    var sorted = items.slice().sort(ORDER[s.sort] || ORDER.new);
    var frag = document.createDocumentFragment();
    sorted.forEach(function (it) {
      var ok = matches(it, s, null);
      it.el.hidden = !ok;
      if (ok) shown += 1;
      frag.appendChild(it.el);
    });
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
        opt.textContent = opt.value + ' (' + n + ')';
        opt.disabled = n === 0 && opt.value !== sel.value;
      });
    });

    if (status) {
      status.textContent = shown === items.length
        ? items.length + ' tracks'
        : shown + ' of ' + items.length + ' tracks';
    }
    if (empty) empty.hidden = shown !== 0;
    grid.hidden = shown === 0;

    var params = new URLSearchParams();
    KEYS.forEach(function (k) {
      var v = k === 'q' ? query.value.trim() : form.elements[k].value;
      if (v && !(k === 'sort' && v === 'new')) params.set(k, v);
    });
    var url = window.location.pathname + (params.toString() ? '?' + params : '');
    if (url !== window.location.pathname + window.location.search) {
      window.history[push ? 'pushState' : 'replaceState'](null, '', url);
    }
    document.querySelectorAll('[data-search-input]').forEach(function (el) {
      if (el !== document.activeElement) el.value = query.value;
    });
  }

  function load() {
    var params = new URLSearchParams(window.location.search);
    query.value = params.get('q') || '';
    sort.value = params.get('sort') || 'new';
    if (!sort.value) sort.value = 'new';
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
    timer = setTimeout(function () { render(false); }, 120);
  });
  form.addEventListener('change', function () { render(true); });
  form.addEventListener('submit', function (event) { event.preventDefault(); render(true); });
  if (reset) {
    reset.addEventListener('click', function (event) {
      event.preventDefault();
      form.reset();
      sort.value = 'new';
      render(true);
      query.focus();
    });
  }
  if (submit) submit.classList.add('sm:hidden');
  window.addEventListener('popstate', load);
  cleanup.push(function () { window.removeEventListener('popstate', load); });

  // The navbar search on this page drives the explorer instead of reloading it.
  document.querySelectorAll('[data-search-input]').forEach(function (el) {
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

  load();
  document.documentElement.dataset.explorer = 'ready';
  return function unmount() {
    clearTimeout(timer);
    cleanup.forEach(function (fn) { fn(); });
    document.documentElement.dataset.explorer = '';
  };
});
