// Charts over the derived catalogue (static/data/catalog.json). Every number comes from the
// catalogue; every mark links somewhere (a facet page, the explorer with filters, a month of the
// archive, a track). Each chart has a table view (the <details> under it), a tooltip on hover,
// light and dark palettes validated with the dataviz validator, and re-renders on theme change.
//
//   <div data-chart="months|genre|sentiment|heatmap|graph" data-limit="15" data-focus="<source>">
(function () {
  'use strict';
  var holders = Array.prototype.slice.call(document.querySelectorAll('[data-chart]'));
  if (!holders.length || !window.echarts || !window.fetch) return;
  var body = document.body;
  var base = (body.getAttribute('data-base-url') || '').replace(/\/$/, '');

  // Validated palettes (dataviz validator, 2026-11-12): categorical first three slots pass
  // all-pairs in both modes on white / gray-800; single-series violet >= 3:1 on both surfaces.
  var PALETTE = {
    light: {
      ink: '#111827', muted: '#6b7280', grid: '#e5e7eb', surface: '#ffffff',
      single: '#6d28d9', categorical: ['#2a78d6', '#eb6834', '#1baf7a'], other: '#9ca3af',
      ramp: ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95'],
    },
    dark: {
      ink: '#f9fafb', muted: '#9ca3af', grid: '#374151', surface: '#1f2937',
      single: '#8b5cf6', categorical: ['#3987e5', '#d95926', '#199e70'], other: '#6b7280',
      ramp: ['#2e1065', '#3b0764', '#4c1d95', '#5b21b6', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd'],
    },
  };
  function theme() {
    return document.documentElement.classList.contains('dark') ? PALETTE.dark : PALETTE.light;
  }
  function facetUrl(kind, slug) { return base + '/' + kind + '/' + slug + '/'; }
  function slugify(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function go(url) { window.location.href = url; }

  function axisStyle(p) {
    return {
      axisLine: { lineStyle: { color: p.grid } },
      axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: p.grid } },
    };
  }
  function tooltip(p) {
    return {
      backgroundColor: p.surface, borderColor: p.grid, borderWidth: 1,
      textStyle: { color: p.ink, fontSize: 13 }, extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12)',
    };
  }

  // --- The chart forms. Each returns {option, rows, onClick}. --------------------------------
  var FORMS = {
    months: function (c, p) {
      var months = c.months;
      return {
        rows: [['Month', 'Tracks']].concat(months.map(function (m) { return [m.month, m.count]; })),
        option: {
          grid: { left: 40, right: 16, top: 16, bottom: 32 },
          tooltip: Object.assign(tooltip(p), { trigger: 'axis', axisPointer: { type: 'shadow' } }),
          xAxis: Object.assign({ type: 'category', data: months.map(function (m) { return m.month; }) }, axisStyle(p), { splitLine: { show: false } }),
          yAxis: Object.assign({ type: 'value', minInterval: 1 }, axisStyle(p)),
          series: [{ type: 'bar', name: 'Tracks', data: months.map(function (m) { return m.count; }),
            barMaxWidth: 48, itemStyle: { color: p.single, borderRadius: [4, 4, 0, 0] } }],
        },
        onClick: function (e) { go(base + '/archive/#m-' + months[e.dataIndex].month); },
      };
    },
    facet: function (kind) {
      return function (c, p, el) {
        var limit = Number(el.getAttribute('data-limit') || 15);
        var items = c.facets[kind].slice(0, limit).reverse();
        return {
          rows: [['Term', 'Tracks']].concat(items.slice().reverse().map(function (f) { return [f.term, f.count]; })),
          option: {
            grid: { left: 8, right: 24, top: 8, bottom: 24, containLabel: true },
            tooltip: Object.assign(tooltip(p), { trigger: 'axis', axisPointer: { type: 'shadow' } }),
            xAxis: Object.assign({ type: 'value', minInterval: 1 }, axisStyle(p)),
            yAxis: Object.assign({ type: 'category', data: items.map(function (f) { return f.term; }) }, axisStyle(p), { splitLine: { show: false } }),
            series: [{ type: 'bar', name: 'Tracks', data: items.map(function (f) { return f.count; }),
              barMaxWidth: 18, itemStyle: { color: p.single, borderRadius: [0, 4, 4, 0] } }],
          },
          onClick: function (e) {
            // On the home page the chart drives the explorer; elsewhere it opens the facet page.
            var select = el.getAttribute('data-target') === 'explorer' && document.getElementById('explorer-' + kind);
            if (select) {
              select.value = items[e.dataIndex].term;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              document.getElementById('explorer-title').scrollIntoView({ behavior: 'smooth' });
            } else {
              go(facetUrl(kind, items[e.dataIndex].slug));
            }
          },
        };
      };
    },
    heatmap: function (c, p, el) {
      var n = Number(el.getAttribute('data-limit') || 10);
      var genres = c.facets.genre.slice(0, n).map(function (f) { return f.term; });
      var feelings = c.facets.sentiment.slice(0, n).map(function (f) { return f.term; });
      var data = [];
      var max = 1;
      genres.forEach(function (g, gi) {
        feelings.forEach(function (s, si) {
          var count = c.tracks.filter(function (t) {
            return t.facets.genre.indexOf(g) >= 0 && t.facets.sentiment.indexOf(s) >= 0;
          }).length;
          max = Math.max(max, count);
          data.push([si, gi, count]);
        });
      });
      return {
        rows: [['Genre \\ feeling'].concat(feelings)].concat(genres.map(function (g, gi) {
          return [g].concat(feelings.map(function (s, si) { return data[gi * feelings.length + si][2]; }));
        })),
        option: {
          grid: { left: 8, right: 8, top: 8, bottom: 64, containLabel: true },
          tooltip: Object.assign(tooltip(p), { formatter: function (e) {
            return '<b>' + genres[e.value[1]] + '</b> × <b>' + feelings[e.value[0]] + '</b><br>' + e.value[2] + ' track(s)';
          } }),
          xAxis: Object.assign({ type: 'category', data: feelings }, axisStyle(p), { axisLabel: { color: p.muted, rotate: 35, fontSize: 12 }, splitLine: { show: false } }),
          yAxis: Object.assign({ type: 'category', data: genres, inverse: true }, axisStyle(p), { splitLine: { show: false } }),
          visualMap: { min: 0, max: max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
            itemWidth: 12, itemHeight: 120, textStyle: { color: p.muted }, inRange: { color: p.ramp } },
          series: [{ type: 'heatmap', data: data, itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 4 },
            emphasis: { itemStyle: { borderColor: p.ink, borderWidth: 2 } } }],
        },
        onClick: function (e) {
          go(base + '/?genre=' + encodeURIComponent(genres[e.value[1]]) + '&sentiment=' + encodeURIComponent(feelings[e.value[0]]));
        },
      };
    },
    graph: function (c, p, el) {
      var focus = el.getAttribute('data-focus');
      var bySource = {};
      c.tracks.forEach(function (t) { bySource[t.source] = t; });
      // Which tracks: the whole catalogue, or the focus and two steps of its relations.
      var keep = {};
      if (focus && bySource[focus]) {
        keep[focus] = 0;
        bySource[focus].related.forEach(function (r) {
          keep[r.source] = 1;
          bySource[r.source].related.forEach(function (r2) { if (!(r2.source in keep)) keep[r2.source] = 2; });
        });
      } else {
        c.tracks.forEach(function (t) { keep[t.source] = 1; });
      }
      // Colour: the three most common first genres, the rest "other" (series cap, all-pairs).
      var firsts = {};
      Object.keys(keep).forEach(function (s) { var g = bySource[s].facets.genre[0]; firsts[g] = (firsts[g] || 0) + 1; });
      var top = Object.keys(firsts).sort(function (a, b) { return firsts[b] - firsts[a] || a.localeCompare(b); }).slice(0, 3);
      var categories = top.map(function (g, i) { return { name: g, itemStyle: { color: p.categorical[i] } }; })
        .concat([{ name: 'other genres', itemStyle: { color: p.other } }]);
      var degree = {};
      var links = [];
      var seen = {};
      Object.keys(keep).forEach(function (s) {
        bySource[s].related.forEach(function (r) {
          if (!(r.source in keep)) return;
          var key = s < r.source ? s + '|' + r.source : r.source + '|' + s;
          if (seen[key]) return;
          seen[key] = true;
          degree[s] = (degree[s] || 0) + 1;
          degree[r.source] = (degree[r.source] || 0) + 1;
          links.push({ source: s, target: r.source, value: r.score,
            lineStyle: { width: 0.5 + r.score * 3, opacity: 0.35 + r.score * 0.5 } });
        });
      });
      var nodes = Object.keys(keep).map(function (s) {
        var t = bySource[s];
        var cat = top.indexOf(t.facets.genre[0]);
        return { id: s, name: t.artist + ' – ' + t.track, category: cat < 0 ? top.length : cat,
          symbolSize: (s === focus ? 26 : 8 + Math.sqrt(degree[s] || 1) * 4),
          itemStyle: { borderColor: p.surface, borderWidth: s === focus ? 3 : 1.5 },
          label: { show: s === focus || (focus && keep[s] === 1), color: p.ink, fontSize: 12, position: 'right' },
          path: t.path, genre: t.facets.genre.join(', ') };
      });
      return {
        rows: [['Track', 'Genres', 'Related tracks shown']].concat(nodes.map(function (n) {
          return [n.name, n.genre, degree[n.id] || 0];
        })),
        option: {
          tooltip: Object.assign(tooltip(p), { formatter: function (e) {
            return e.dataType === 'edge' ? Math.round(e.data.value * 100) + ' % alike'
              : '<b>' + e.data.name + '</b><br>' + e.data.genre;
          } }),
          legend: [{ data: categories.map(function (k) { return k.name; }), textStyle: { color: p.ink }, top: 0, icon: 'circle' }],
          series: [{ type: 'graph', layout: 'force', roam: true, draggable: true, data: nodes, links: links,
            categories: categories, top: 36,
            force: { repulsion: focus ? 220 : 60, edgeLength: focus ? [60, 140] : [20, 70], gravity: 0.08 },
            lineStyle: { color: p.muted, curveness: 0.15 },
            emphasis: { focus: 'adjacency', label: { show: true, color: p.ink } } }],
        },
        onClick: function (e) { if (e.dataType === 'node' && e.data.path) go(base + '/' + e.data.path); },
      };
    },
  };
  FORMS.genre = FORMS.facet('genre');
  FORMS.sentiment = FORMS.facet('sentiment');

  function table(holder, rows) {
    var target = document.querySelector('[data-chart-table="' + holder.id + '"]');
    if (!target || target.dataset.filled) return;
    var t = document.createElement('table');
    t.className = 'w-full text-left text-sm text-gray-500 dark:text-gray-400';
    rows.forEach(function (row, i) {
      var tr = document.createElement('tr');
      tr.className = i ? 'border-b border-gray-200 dark:border-gray-700' : 'bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-400';
      row.forEach(function (cell) {
        var td = document.createElement(i ? 'td' : 'th');
        td.className = 'px-3 py-2';
        if (!i) td.scope = 'col';
        td.textContent = cell;
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    target.appendChild(t);
    target.dataset.filled = 'true';
  }

  var charts = [];
  function render(catalog) {
    var p = theme();
    charts.forEach(function (ch) { ch.instance.dispose(); });
    charts = [];
    holders.forEach(function (holder) {
      var form = FORMS[holder.getAttribute('data-chart')];
      if (!form) return;
      var built = form(catalog, p, holder);
      var instance = window.echarts.init(holder, null, { renderer: 'canvas' });
      built.option.aria = { enabled: true, label: { description: holder.getAttribute('aria-label') || '' } };
      built.option.backgroundColor = 'transparent';
      built.option.textStyle = { fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' };
      instance.setOption(built.option);
      instance.on('click', built.onClick);
      holder.style.cursor = 'pointer';
      table(holder, built.rows);
      charts.push({ instance: instance });
    });
    document.documentElement.dataset.charts = String(charts.length);
  }

  fetch(body.getAttribute('data-catalog')).then(function (r) { return r.json(); }).then(function (catalog) {
    render(catalog);
    document.addEventListener('dark-mode', function () { render(catalog); });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { charts.forEach(function (ch) { ch.instance.resize(); }); });
      holders.forEach(function (h) { ro.observe(h); });
    }
  }).catch(function () { document.documentElement.dataset.charts = 'failed'; });
})();
