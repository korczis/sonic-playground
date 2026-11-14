// The owner's Spotify library, read off the rendered web player (ADR 0007, skill
// import-spotify-history). Runs inside the owner's logged-in tab at https://open.spotify.com/,
// injected by Claude in Chrome (javascript_tool) or pasted into DevTools. It reads only what
// the page renders: the library grid, every playlist's rows, the profile's top lists. It never
// reads the session's credentials and never calls Spotify's API.
//
//   1. In the tab: run this file, then `await SonicCrawl.run()` (minutes; progress in
//      SonicCrawl.progress). The result goes to localStorage key "sonicSnapshot".
//   2. Chrome allows one automatic download per tab, so in a fresh tab on the same origin
//      (https://open.spotify.com/robots.txt) run this file and `SonicCrawl.download()`. It saves
//      sonic-spotify-snapshot-<day>.json and clears the key.
//   3. python3 scripts/spotify_history.py ingest-snapshot ~/Downloads/sonic-spotify-snapshot-<day>.json
//      then `npm run spotify:build`.
//
// The lessons of the first crawl (2026-11-14), built in:
// - rows render as skeletons before they fill: a row is taken only once it has its links, and
//   a position still missing after a patient scroll is `unavailable`;
// - the app restores a playlist's scroll position, so the scan starts from the top;
// - a grid's aria-label may carry trailing spaces, so names are compared trimmed;
// - the top-tracks page renders no track links, so its title comes from the cell text;
// - an empty playlist has no grid, and is kept with no items;
// - a row that loads too slowly for the sweep is fetched by a targeted scroll to its position;
// - a playlist without a name of its own ("Playlist • <owner>") is kept; only the entries the
//   library marks "This playlist is not available" are skipped.
(function () {
  'use strict';
  const STORE = 'sonicSnapshot';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idOf = (href, kind) => {
    const m = (href || '').match(new RegExp('/' + kind + '/([A-Za-z0-9]+)'));
    return m ? m[1] : null;
  };
  const scroller = (el) => {
    let s = el;
    while (s && !(s.scrollHeight > s.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    return s;
  };
  const go = async (path) => {
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    await sleep(2500);
  };
  const heading = () => ((document.querySelector('main h1') || {}).textContent || '').trim();
  const mainGrid = async (tries = 40) => {
    for (let t = 0; t < tries; t++) {
      const g = document.querySelector('main [role="grid"]');
      if (g && g.querySelector('[role="row"][aria-rowindex]') && (g.getAttribute('aria-label') || '').trim() === heading()) return g;
      await sleep(250);
    }
    return null;
  };

  /** Scroll a grid from the top and collect every row through `read(row, cells, head)`. */
  async function scan(grid, read) {
    const head = [...grid.querySelectorAll('[role="columnheader"]')].map((c) => c.innerText.trim().toLowerCase());
    const total = +grid.getAttribute('aria-rowcount') - 1;
    const sc = scroller(grid);
    const rows = new Map();
    if (sc) { sc.scrollTop = 0; await sleep(1500); }
    let stall = 0;
    let last = -1;
    for (let k = 0; k < 6000 && rows.size < total && stall < 80; k++) {
      for (const r of grid.querySelectorAll('[role="row"][aria-rowindex]')) {
        const i = +r.getAttribute('aria-rowindex');
        if (i < 2 || rows.has(i)) continue;
        const item = read(r, [...r.querySelectorAll('[role="gridcell"]')], head);
        if (item) rows.set(i, { n: i - 1, ...item });
      }
      if (rows.size === last) {
        stall++;
        if (sc && stall % 10 === 0) { sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight * 2); await sleep(600); }
      } else stall = 0;
      last = rows.size;
      if (sc) sc.scrollTop += sc.clientHeight * 0.5;
      await sleep(450);
    }
    // Targeted top-up: a row that loaded too slowly for the sweep is scrolled to on its own and
    // read once it renders (the second crawl missed 160 liked songs without this).
    if (sc && rows.size < total) {
      // Measure data rows only (the header row is shorter), then seek until the row renders.
      const dataRows = () => [...grid.querySelectorAll('[role="row"][aria-rowindex]')].filter((r) => +r.getAttribute('aria-rowindex') > 1);
      const heights = dataRows().map((r) => r.getBoundingClientRect().height).sort((x, y) => x - y);
      const rowH = heights[Math.floor(heights.length / 2)] || 56;
      const seek = async (n) => {
        for (let t = 0; t < 8; t++) {
          const shown = dataRows().map((r) => +r.getAttribute('aria-rowindex'));
          const lo = Math.min(...shown);
          const hi = Math.max(...shown);
          if (n + 1 >= lo && n + 1 <= hi) return;
          sc.scrollTop += (n + 1 - (lo + hi) / 2) * rowH;
          await sleep(500);
        }
      };
      for (let pass = 0; pass < 3 && rows.size < total; pass++) {
        for (let n = 1; n <= total; n++) {
          if (rows.has(n + 1)) continue;
          await seek(n);
          await sleep(pass ? 900 : 300);
          const r = grid.querySelector(`[role="row"][aria-rowindex="${n + 1}"]`);
          const item = r && read(r, [...r.querySelectorAll('[role="gridcell"]')], head);
          if (item) rows.set(n + 1, { n, ...item });
        }
      }
    }
    for (let n = 1; n <= total; n++) if (!rows.has(n + 1)) rows.set(n + 1, { n, unavailable: true });
    return { expected: total, items: [...rows.values()].sort((a, b) => a.n - b.n) };
  }

  const artistsOf = (el) => [...el.querySelectorAll('a[href*="/artist/"]')]
    .map((a) => ({ name: a.textContent.trim(), id: idOf(a.getAttribute('href'), 'artist') }));
  const albumOf = (r) => {
    const al = r.querySelector('a[href*="/album/"]');
    return al ? { name: al.textContent.trim(), id: idOf(al.getAttribute('href'), 'album') } : null;
  };
  const explicitOf = (r) => !!r.querySelector('[aria-label="Explicit"],[title="Explicit"]');

  /** A playlist (or the liked songs) row: only once its track link has rendered. */
  function playlistRow(r, c, head) {
    const t = r.querySelector('a[href*="/track/"],a[href*="/episode/"]');
    if (!t) return null;
    const added = head.findIndex((h) => h.startsWith('date added'));
    return {
      title: t.textContent.trim(), track_id: idOf(t.getAttribute('href'), 'track'),
      episode_id: idOf(t.getAttribute('href'), 'episode'), artists: artistsOf(r), explicit: explicitOf(r),
      album: albumOf(r), added: added >= 0 && c[added] ? c[added].innerText.trim() : null,
      duration: c.length ? c[c.length - 1].innerText.trim() : null,
    };
  }

  /** A top-tracks row: no track link, so the title is the cell's first line. */
  function topRow(r, c) {
    if (c.length < 3) return null;
    const artists = artistsOf(c[1]);
    if (!artists.length) return null;
    return { title: c[1].innerText.split('\n')[0].trim(), track_id: null, artists, explicit: explicitOf(r),
      album: albumOf(r), duration: c[c.length - 1].innerText.trim() };
  }

  async function library() {
    const lib = document.querySelector('[role="grid"][aria-label="Your Library"]');
    if (!lib) throw new Error('the library grid is not on the page: open https://open.spotify.com/ logged in');
    const total = +lib.getAttribute('aria-rowcount');
    const sc = scroller(lib);
    const items = new Map();
    sc.scrollTop = 0;
    await sleep(600);
    let stall = 0;
    let last = -1;
    for (let k = 0; k < 600 && items.size < total - 1 && stall < 25; k++) {
      for (const r of lib.querySelectorAll('[role="row"][aria-rowindex]')) {
        const i = +r.getAttribute('aria-rowindex');
        if (items.has(i)) continue;
        const lab = r.querySelector('[aria-labelledby*="listrow-title-"]');
        const uri = lab ? lab.getAttribute('aria-labelledby').split(' ')[0].replace('listrow-title-', '') : null;
        const txt = /** @type {HTMLElement} */ (r).innerText.split('\n').map((s) => s.trim()).filter(Boolean);
        items.set(i, { i, uri, name: txt[0], sub: txt.slice(1).join(' ') });
      }
      stall = items.size === last ? stall + 1 : 0;
      last = items.size;
      sc.scrollTop += sc.clientHeight * 0.8;
      await sleep(300);
    }
    return [...items.values()].sort((a, b) => a.i - b.i);
  }

  async function playlist(target) {
    await go(target.path);
    const grid = await mainGrid();
    const owner = [...document.querySelectorAll('main a[href*="/user/"]')].slice(0, 1)
      .map((a) => ({ name: a.textContent.trim(), id: idOf(a.getAttribute('href'), 'user') }))[0] || null;
    const base = { uri: target.uri, name: heading() || target.name, library_subtitle: target.sub || null, owner,
      description: (/** @type {HTMLElement | null} */ (document.querySelector('main [data-testid="description"]'))?.innerText || '').slice(0, 500) };
    if (!grid) return { ...base, expected: 0, items: [], empty: true };
    return { ...base, ...(await scan(grid, playlistRow)) };
  }

  /** The owner's top lists, from the owner's own profile (the liked songs' owner). */
  async function top(ownerId) {
    if (!ownerId) return null;
    const user = '/user/' + ownerId;
    await go(user + '/top/artists');
    const seen = new Set();
    const artists = [];
    for (const a of artistsOf(document.querySelector('main'))) {
      if (a.name && !seen.has(a.id)) { seen.add(a.id); artists.push({ rank: artists.length + 1, ...a }); }
    }
    await go(user + '/top/tracks');
    const grid = await mainGrid();
    const tracks = grid ? (await scan(grid, topRow)).items.filter((x) => !x.unavailable) : [];
    return { range: 'short_term', label: 'this month', tracks, artists };
  }

  const crawl = {
    progress: 'idle',
    /** The whole snapshot: library, liked songs, every playlist, the top lists. */
    async run() {
      crawl.progress = 'library';
      const lib = await library();
      const targets = [{ uri: 'spotify:collection:tracks', name: 'Liked Songs', path: '/collection/tracks' }]
        .concat(lib.filter((x) => (x.uri || '').includes(':playlist:') && !/This playlist is not available/i.test((x.name || '') + ' ' + (x.sub || '')))
          .map((x) => ({ uri: x.uri, name: x.name, sub: x.sub, path: '/playlist/' + x.uri.split(':')[2] })));
      const playlists = [];
      for (const [k, t] of targets.entries()) {
        crawl.progress = `${k + 1}/${targets.length} ${t.name}`;
        playlists.push(await playlist(t));
      }
      crawl.progress = 'top lists';
      const snap = { schema: 'spotify-web-snapshot/v1', captured: new Date().toISOString().slice(0, 10),
        source: "open.spotify.com, the owner's logged-in web player, read off the rendered page (scripts/spotify-web-crawl.js)",
        library: lib, playlists };
      const liked = playlists.find((p) => p.uri === 'spotify:collection:tracks');
      const t = await top(liked && liked.owner ? liked.owner.id : null);
      if (t) snap.top = t;
      localStorage.setItem(STORE, JSON.stringify(snap));
      crawl.progress = 'done';
      const short = playlists.filter((p) => p.items.filter((x) => !x.unavailable).length < p.expected);
      return { playlists: playlists.length, rows: playlists.reduce((a, p) => a + p.items.length, 0),
        short: short.map((p) => `${p.name} ${p.items.filter((x) => !x.unavailable).length}/${p.expected}`),
        top: t ? { tracks: t.tracks.length, artists: t.artists.length } : null };
    },
    /** Save the stored snapshot as one download (in a fresh tab), then clear it. */
    download() {
      const s = localStorage.getItem(STORE);
      if (!s) return 'no snapshot stored: run SonicCrawl.run() first';
      const day = JSON.parse(s).captured;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([s], { type: 'application/json' }));
      a.download = `sonic-spotify-snapshot-${day}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => localStorage.removeItem(STORE), 2000);
      return `${a.download} (${s.length} bytes)`;
    },
  };
  // @ts-ignore: the crawl's handle for the injecting tool
  window.SonicCrawl = crawl;
})();
