// majordomus-skill: fleet-flowbite-pro
// E2E smoke test of the built site in a real browser (scripts/verify.sh runs it after
// `zola build`; CI runs it on the very artefact it deploys, and again against production).
//
//   node test/e2e/smoke.cjs --artifact <public dir> --as <base url>
//        the browser asks for <base url> (the production URL, sub-path included) and every
//        such request is answered from <public dir>: the bytes that will be deployed, tested
//        under the path they will be served from
//   node test/e2e/smoke.cjs --url <base url>          test the deployed site
//        REVISION=<sha> adds ?v=<sha> to every page and data request, past the Pages CDN cache
//
// Asserts:
//   - every page class renders with no console error and no failed same-origin request;
//   - the home explorer: one card per catalogue track, faceted filter + text search + sort,
//     URL state, the empty state, reset;
//   - a track page: the video still turns into a youtube-nocookie player, related tracks exist;
//   - the theme toggle flips and persists the Pro `color-theme` key;
//   - phone width (390 px): no horizontal overflow, the sidebar drawer opens;
//   - (local only) every catalogue path is a built page.
// SCREENSHOT_DIR=<dir> also saves screenshots (desktop/phone, light/dark).
// CHROME_PATH=<binary> uses that browser instead of Playwright's chromium.
// Exit 0 pass, 1 fail, 2 usage, 3 skipped (playwright-core not installed).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { retryAfter } = require('./retry.cjs');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.log('smoke: playwright-core not installed (npm ci); skipped');
  process.exit(3);
}

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let base;
let root = null;
if (flag('--artifact') && flag('--as')) {
  root = path.resolve(flag('--artifact'));
  base = flag('--as').replace(/\/?$/, '/');
} else if (flag('--url')) {
  base = flag('--url').replace(/\/?$/, '/');
} else {
  console.error('usage: node test/e2e/smoke.cjs --artifact <dir> --as <base url> | --url <base url>');
  process.exit(2);
}
const revision = !root && process.env.REVISION ? process.env.REVISION : '';

// In the page: every chart holder with the number of series ECharts built for it. A series type
// the custom build (data/echarts.json) lacks is dropped silently, so 0 means a missing module.
function seriesBuilt() {
  return [...document.querySelectorAll('[data-chart]')].map((el) => {
    const chart = window.echarts && window.echarts.getInstanceByDom(el);
    return { id: el.id, built: chart ? chart.getModel().getSeriesCount() : -1 };
  }).filter((c) => c.built !== -1);
}

// A URL of the site, past the CDN cache when a revision is known (production only).
function at(rel) {
  const url = new URL(rel, base);
  if (revision) url.searchParams.set('v', revision);
  return url.toString();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.txt': 'text/plain',
};

// Answer a request for the site from the artefact, as GitHub Pages would.
async function fromArtifact(route) {
  const url = new URL(route.request().url());
  let rel = decodeURIComponent(url.pathname).slice(new URL(base).pathname.length);
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return route.fulfill({ status: 403, body: '' });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    return route.fulfill({ status: 404, contentType: TYPES['.html'],
      body: fs.readFileSync(path.join(root, '404.html')) });
  }
  return route.fulfill({ status: 200, body: fs.readFileSync(file),
    contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
}

const failures = [];
const notices = new Set();
let last = 'start';
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
  last = what;
}

// Every step has a deadline (a production run once hung for 45 minutes in the sweep: a
// page.evaluate and fetch have none of their own). The watchdog ends a stuck run with the last
// check that passed and the pages still in flight, so the cause is in the log.
const inFlight = new Set();
const WATCHDOG = Number(process.env.SMOKE_TIMEOUT_MS || 15 * 60 * 1000);
setTimeout(() => {
  console.error(`smoke: watchdog: no result after ${WATCHDOG / 1000} s; last check: ${last}; ` +
    `in flight: ${[...inFlight].join(', ') || 'none'}`);
  process.exit(1);
}, WATCHDOG).unref();
/** Resolve with p, or reject after ms with what. */
function within(ms, what, p) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s: ${what}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
const get = (url) => fetch(url, { signal: AbortSignal.timeout(30000) });

// A deterministic YouTube for the player suites: they test the queue, not YouTube, and a real
// video that errors or ends on a CI machine moved the queue on its own (2026-11-12, CI of
// 0f909ff). The fake IFrame API records every call; window.__yt.fire(state) and
// window.__yt.error() play the parts of a video ending or failing. The track page keeps the real
// player as the integration test.
const FAKE_IFRAME_API = `
window.__yt = { calls: [], player: null,
  fire: function (s) { var p = window.__yt.player; p._state = s; p._events.onStateChange({ data: s, target: p }); },
  error: function () { var p = window.__yt.player; p._events.onError({ data: 150, target: p }); } };
window.YT = { Player: function (frame, opts) {
  var self = this; self._events = opts.events || {}; self._state = -1; self._time = 0;
  self._video = decodeURIComponent(((frame.src || '').split('/embed/')[1] || '').split('?')[0]);
  window.__yt.player = self;
  function log(n, a) { window.__yt.calls.push([n, a === undefined ? null : a]); }
  self.playVideo = function () { log('play'); self._state = 1; self._events.onStateChange && self._events.onStateChange({ data: 1, target: self }); };
  self.pauseVideo = function () { log('pause'); self._state = 2; self._events.onStateChange && self._events.onStateChange({ data: 2, target: self }); };
  self.stopVideo = function () { log('stop'); self._state = 5; };
  self.loadVideoById = function (o) { log('load', o.videoId); self._video = o.videoId; self._time = 0; self.playVideo(); };
  self.cueVideoById = function (o) { log('cue', o.videoId); self._video = o.videoId; self._state = 5; };
  self.seekTo = function (t) { log('seek', t); self._time = t; };
  self.getPlayerState = function () { return self._state; };
  self.getCurrentTime = function () { return self._time; };
  self.getDuration = function () { return 240; };
  self.getVideoData = function () { return { video_id: self._video }; };
  setTimeout(function () { self._events.onReady && self._events.onReady({ target: self }); }, 0);
} };
if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
`;
async function fakeYouTube(context) {
  await context.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ status: 200,
    contentType: 'text/javascript', body: FAKE_IFRAME_API }));
  await context.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200,
    contentType: 'text/html', body: '<!doctype html><title>fake player</title>' }));
}

async function open(browser, url, viewport, colorScheme = 'light', options = {}, fake = false) {
  const context = await browser.newContext({ viewport, colorScheme, ...options });
  if (root) await context.route(`${base}**`, fromArtifact);
  if (fake) await fakeYouTube(context);
  const page = await context.newPage();
  const errors = watch(page);
  const response = await page.goto(url, { waitUntil: 'load' });
  return { context, page, errors, response };
}

function watch(page) {
  const errors = [];
  const origin = new URL(base).origin;
  // Zero tolerance for what the site itself causes (knowledge: console-clean-by-construction):
  //   - every console error AND warning of the page's own frame;
  //   - every uncaught exception;
  //   - every failed request of the site, and every failed YouTube still (i.ytimg.com), which the
  //     site requests itself: a 404 there means data/videos.json is stale (probe-videos.py).
  // Only what the YouTube player logs inside its own iframe after a click is a notice: the site
  // cannot change it. The browser's 'Failed to load resource' line carries no URL; the request
  // is judged by the response listener instead, so it is not counted twice.
  const ownRequest = (u) => u.startsWith(origin) || u.startsWith('https://i.ytimg.com/');
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (m.text().startsWith('Failed to load resource')) return;
    const from = (m.location() && m.location().url) || '';
    const own = !from || from.startsWith(origin);
    (own ? errors : null)?.push(`console ${m.type()}: ${m.text()}`);
    if (!own) notices.add(`third-party console ${m.type()} (${from}): ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${String(e)}`));
  // Only what the page's own document requests is the site's; the YouTube player's frame makes
  // and cancels its own requests (ERR_ABORTED is a cancellation, not a failure).
  const mine = (r) => ownRequest(r.url()) && r.frame() === page.mainFrame();
  page.on('requestfailed', (r) => {
    const why = r.failure() && r.failure().errorText;
    if (mine(r) && why !== 'net::ERR_ABORTED') errors.push(`request failed: ${r.url()} (${why})`);
  });
  page.on('response', (r) => {
    if (r.status() < 400 || r.url().includes('/nope-')) return;
    if (mine(r.request())) errors.push(`HTTP ${r.status()}: ${r.url()}`);
    else notices.add(`third-party HTTP ${r.status()}: ${r.url()}`);
  });
  return errors;
}

// Every page the site has (its sitemap), each loaded and scrolled to the end so lazy images load,
// must produce zero errors. Six pages at a time, one context per worker.
async function visit(context, rel) {
  const page = await context.newPage();
  const errors = watch(page);
  let stalled = false;
  inFlight.add(rel || '/');
  try {
    await within(60000, `page /${rel}`, (async () => {
      await page.goto(at(rel), { waitUntil: 'load', timeout: 30000 });
      await page.evaluate(async () => {
        for (let y = 0, i = 0; y < document.body.scrollHeight && i < 100; y += 800, i++) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
      });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    })());
  } catch (e) {
    stalled = /timed out|Timeout/i.test(e.message) && !errors.length;
    errors.push(`navigation: ${e.message}`);
  }
  inFlight.delete(rel || '/');
  await within(10000, `close /${rel}`, page.close()).catch(() => {});
  return { errors, stalled };
}

// The sweep's parallel pages: SMOKE_WORKERS, else the machine's cores less two, never fewer than the
// six the CI runner always had and never more than sixteen (each is a browser context). Every page
// is still visited, scrolled and waited for; only more of them at once.
const SWEEP_WORKERS = Number(process.env.SMOKE_WORKERS)
  || Math.min(16, Math.max(6, require('node:os').cpus().length - 2));

// Every page of the site (its sitemap), as absolute URLs.
async function sitemap() {
  const xml = root ? fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8')
    : await (await get(at('sitemap.xml'))).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

// The kind of a page from its path: the language, then home, a review (reviews: the catalogue's
// paths), a top-level page, or a taxonomy's index, term or term page (cs/genre/house/page/2/ ->
// cs:genre:page).
function pageKind(rel, reviews) {
  const parts = rel.split('/').filter(Boolean);
  const lang = parts[0] === 'cs' ? parts.shift() : 'en';
  if (!parts.length) return `${lang}:home`;
  if (parts.length === 1) return reviews.has(parts[0] + '/') ? `${lang}:review` : `${lang}:${parts[0]}`;
  return `${lang}:${parts[0]}:${parts.includes('page') ? 'page' : parts.length === 2 ? 'term' : 'deep'}`;
}

// WCAG 2.2 A and AA (rule project.wcag-aa): axe-core's rules of those levels, colour contrast
// included, report nothing on one page of every kind the sitemap has, in light and in dark.
// The site's own checks cover names and target size; this is the independent instrument.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function wcag(browser, viewport, reviews) {
  const axe = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const kinds = new Map();
  for (const loc of await sitemap()) {
    const rel = loc.startsWith(base) ? loc.slice(base.length) : loc;
    if (!kinds.has(pageKind(rel, reviews))) kinds.set(pageKind(rel, reviews), rel);
  }
  const jobs = [];
  for (const scheme of ['light', 'dark']) for (const rel of kinds.values()) jobs.push({ scheme, rel });
  const found = [];
  let next = 0;
  async function worker() {
    const contexts = {};
    while (next < jobs.length) {
      const { scheme, rel } = jobs[next++];
      if (!contexts[scheme]) {
        contexts[scheme] = await browser.newContext({ viewport, colorScheme: scheme });
        if (root) await contexts[scheme].route(`${base}**`, fromArtifact);
        await contexts[scheme].addInitScript((s) => { try { localStorage.setItem('color-theme', s); } catch (e) { /* private mode */ } }, scheme);
      }
      const page = await contexts[scheme].newPage();
      await page.goto(at(rel), { waitUntil: 'load' });
      await page.addScriptTag({ content: axe });
      const violations = await page.evaluate(async (tags) => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
        return r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')} — ${(v.nodes[0].failureSummary || '').split('\n')[1] || v.help}`);
      }, WCAG_TAGS);
      for (const v of violations) found.push(`${scheme} /${rel}: ${v}`);
      await page.close();
    }
    for (const c of Object.values(contexts)) await c.close();
  }
  await Promise.all(Array.from({ length: Math.min(SWEEP_WORKERS, jobs.length) }, worker));
  check(kinds.size > 10 && found.length === 0,
    `wcag: axe-core ${WCAG_TAGS.join('/')} finds nothing on ${kinds.size} kinds of page, light and dark` +
    (found.length ? `\n     ${found.slice(0, 12).join('\n     ')}` : ''));
}

async function sweep(browser) {
  const urls = await sitemap();
  const failed = [];
  let next = 0;
  async function worker() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (root) await context.route(`${base}**`, fromArtifact);
    while (next < urls.length) {
      const loc = urls[next++];
      const rel = loc.startsWith(base) ? loc.slice(base.length) : loc;
      // A stalled page is loaded once more, a live host's transient answer up to three times with
      // growing pauses (test/e2e/retry.cjs); a page that still fails fails, and a console message
      // or a 404 is never retried.
      let result = await visit(context, rel);
      const first = result.stalled ? 'stalled' : (result.errors[0] || '').split(':')[0];
      for (let attempt = 1; ; attempt++) {
        const pause = retryAfter(result, !root, attempt);
        if (pause === null) break;
        await new Promise((r) => setTimeout(r, pause));
        result = await visit(context, rel);
        if (!result.stalled && !result.errors.length) {
          notices.add(`site: ${first === 'stalled' ? 'stalled' : 'host answered ' + first}, passed on retry ${attempt}: /${rel}`);
          break;
        }
      }
      if (result.errors.length) failed.push(`${rel || '/'}: ${result.errors.join(' | ')}`);
    }
    await context.close();
  }
  await Promise.all(Array.from({ length: SWEEP_WORKERS }, worker));
  check(urls.length > 0 && failed.length === 0,
    `sweep: ${urls.length} sitemap pages (${SWEEP_WORKERS} at a time), every one free of console errors, warnings and failed requests` +
    (failed.length ? `\n     ${failed.slice(0, 20).join('\n     ')}` : ''));
}

async function shot(page, name) {
  if (!process.env.SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

(async () => {
  const catalog = root
    ? JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'))
    : await (await get(at('data/catalog.json'))).json();
  check(catalog.schema === 'sonic-catalog/v1' && catalog.tracks.length > 0,
    `catalogue served (${catalog.tracks.length} tracks)`);
  if (root) {
    const missing = catalog.tracks.filter((t) => !fs.existsSync(path.join(root, t.path, 'index.html')));
    check(missing.length === 0, `every catalogue path is a built page${missing.length ? ': ' + missing.map((t) => t.path).join(', ') : ''}`);
  }

  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launch);
  const desktop = { width: 1440, height: 900 };
  const phone = { width: 390, height: 844 };

  // Every page class: renders, has its H1, no console error, no failed request.
  const sample = catalog.tracks.find((t) => t.youtube && t.related.length) || catalog.tracks[0];
  const genre = catalog.facets.genre[0];
  const pages = [
    ['home', ''], ['track', sample.path], ['archive', 'archive/'], ['insights', 'insights/'],
    ['welcome', 'welcome/'], ['author', 'author/'], ['genres', 'genre/'],
    ['genre term', `genre/${genre.slug}/`], ['feelings', 'sentiment/'],
  ];
  for (const [name, rel] of pages) {
    const { context, page, errors, response } = await open(browser, at(rel), desktop);
    const h1 = await page.locator('h1').first().textContent().catch(() => '');
    check(response && response.status() === 200 && h1.trim().length > 0, `${name}: 200 with an H1 ("${h1.trim().slice(0, 40)}")`);
    check(errors.length === 0, `${name}: no console or request errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  {
    const { context, response, page } = await open(browser, at(`nope-${Date.now()}/`), desktop);
    check(response.status() === 404 && (await page.locator('h1').textContent()).includes('skipped'), '404 page served for an unknown path');
    await context.close();
  }

  // Explorer.
  {
    const { context, page, errors } = await open(browser, at(''), desktop);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const visible = () => page.locator('#explorer-grid [data-track]:not([hidden])').count();
    check((await page.locator('#explorer-grid [data-track]').count()) === catalog.tracks.length, 'home renders one card per catalogue track');
    // Landing sections derived from the catalogue: the newest reviews after the featured one, and
    // the most used terms of every facet with more than two terms, each linking to its term page.
    const recent = await page.locator('#home-recent-grid [data-track]').evaluateAll((els) => els.map((e) => e.dataset.source));
    const featured = await page.locator('#featured').getAttribute('data-featured');
    const expected = catalog.tracks.map((t) => t.source).filter((s) => s !== featured).slice(0, 4);
    check(recent.join() === expected.join(), 'home lists the four newest reviews after the featured one');
    const kinds = catalog.facet_names.filter((k) => catalog.facets[k].length > 2);
    const sound = await page.locator('section[aria-labelledby="home-sound"] a[href]').count();
    check(sound >= kinds.length * 2, `home explores by sound over ${kinds.join(', ')}`);
    await shot(page, 'home-desktop-light');
    await page.selectOption('#explorer-genre', genre.term);
    check((await visible()) === genre.count, `genre filter "${genre.term}" leaves ${genre.count} cards`);
    check(new URL(page.url()).searchParams.get('genre') === genre.term, 'filter is in the URL');
    const artist = catalog.tracks[catalog.tracks.length - 1].artist;
    await page.selectOption('#explorer-genre', '');
    await page.fill('#explorer-q', artist);
    await page.waitForTimeout(400);
    const hits = catalog.tracks.filter((t) => `${t.artist} ${t.track} ${t.description}`.toLowerCase().includes(artist.toLowerCase())).length;
    check((await visible()) >= 1 && (await visible()) <= hits + 2, `search "${artist}" finds the artist (${await visible()} cards)`);
    await page.fill('#explorer-q', 'zzzz-no-such-track');
    await page.waitForTimeout(400);
    check(await page.locator('[data-explorer-empty]').isVisible(), 'empty state when nothing matches');
    await page.click('[data-explorer-reset]');
    check((await visible()) === catalog.tracks.length, 'reset shows every track again');
    const unfolded = () => page.locator('#explorer-grid [data-track]:not([hidden]):not([data-overflow])').count();
    const before = await unfolded();
    check(before === Math.min(24, catalog.tracks.length), `explorer shows the first page (${before} cards)`);
    await page.click('[data-explorer-more]');
    check((await unfolded()) === Math.min(48, catalog.tracks.length), 'Show more unfolds the next page');
    await page.selectOption('#explorer-sort', 'old');
    const first = await page.locator('#explorer-grid [data-track]:not([hidden])').first().getAttribute('data-date');
    check(first === catalog.stats.first, `sort oldest first starts at ${catalog.stats.first}`);
    const deep = await open(browser, at(`?genre=${encodeURIComponent(genre.term)}&sort=artist`), desktop);
    await deep.page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    check((await deep.page.locator('#explorer-grid [data-track]:not([hidden])').count()) === genre.count, 'a filtered URL opens filtered');
    await deep.context.close();
    check(errors.length === 0, `explorer: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);

    // Theme toggle persists the Pro key.
    await page.click('#theme-toggle');
    const dark = await page.evaluate(() => [document.documentElement.classList.contains('dark'), localStorage.getItem('color-theme')]);
    check(dark[0] === true && dark[1] === 'dark', 'theme toggle switches to dark and stores color-theme');
    await shot(page, 'home-desktop-dark');
    await context.close();
  }

  // Charts load when they come near the viewport, never before: a track page read from the top
  // does not request ECharts or the catalogue (static/js/charts.js NEAR); scrolled to its graph,
  // it does, and builds the graph.
  {
    // The listener is in place before the page loads: an eager request at load must be seen.
    const { context, page } = await open(browser, 'about:blank', desktop);
    const asked = [];
    page.on('request', (r) => { if (/vendor\/echarts|data\/catalog\.json/.test(r.url())) asked.push(new URL(r.url()).pathname.split('/').pop()); });
    await page.goto(at(sample.path), { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    check(asked.length === 0, `track: read from the top, no chart code or catalogue is fetched (${asked.join(', ') || 'none'})`);
    await page.locator('#chart-neighbourhood').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => Number(document.documentElement.dataset.chartsState) > 0, null, { timeout: 15000 }).catch(() => {});
    const graph = await page.evaluate(seriesBuilt);
    check(asked.length >= 2 && graph.length === 1 && graph[0].built > 0,
      `track: scrolled to the graph, ECharts and the catalogue load and the graph is built (${asked.join(', ')})`);
    await context.close();
  }

  // The first play reads the player's index (static/data/play.json, a projection of the
  // catalogue), never the catalogue: on a page without charts, Play fetches play.json only.
  {
    const { context, page } = await open(browser, 'about:blank', desktop, 'light', {}, true);
    const data = [];
    page.on('request', (r) => { if (/data\/(catalog|play)\.json/.test(r.url())) data.push(new URL(r.url()).pathname.split('/').pop()); });
    await page.goto(at(`genre/${catalog.facets.genre[0].slug}/`), { waitUntil: 'load' });
    await page.locator('#term-grid [data-track] [data-play]').first().click();
    const started = await page.waitForFunction(() => window.SonicPlayer && window.SonicPlayer.state().queue.length > 0, null, { timeout: 15000 })
      .then(() => true, () => false);
    check(started && data.includes('play.json') && !data.includes('catalog.json'),
      `player: the first play on a genre page reads play.json, not the catalogue (${data.join(', ') || 'nothing'})`);
    await context.close();
  }

  // A failed index is forgotten: the first play.json answers 503 (GitHub Pages does, 2026-11-14),
  // the first Play fails, the second plays. A cached rejection left Play dead until a reload.
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    await fakeYouTube(context);
    let answered = 0;
    await context.route(/\/data\/play\.json/, (route) => (answered++ === 0
      ? route.fulfill({ status: 503, body: '' }) : route.fallback()));
    const page = await context.newPage();
    await page.goto(at(`genre/${catalog.facets.genre[0].slug}/`), { waitUntil: 'load' });
    const play = page.locator('#term-grid [data-track] [data-play]').first();
    const queued = () => page.waitForFunction(() => window.SonicPlayer && window.SonicPlayer.state().queue.length > 0,
      null, { timeout: 5000 }).then(() => true, () => false);
    await play.click();
    const first = await queued();
    await play.click();
    const second = await queued();
    check(!first && second && answered >= 2,
      `player: after a failed play index the next Play asks again and plays (first ${first}, then ${second}, ${answered} requests)`);
    await context.close();
  }

  // Close before the YouTube API arrives: nothing plays afterwards (an independent review,
  // 2026-11-14: the API's arrival used to build the player and start the closed track hidden).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    let release;
    const gate = new Promise((r) => { release = r; });
    let asked;
    const requested = new Promise((r) => { asked = r; });
    await context.route('https://www.youtube.com/iframe_api', async (r) => {
      asked();
      await gate;
      await r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_IFRAME_API });
    });
    await context.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'text/html', body: '<!doctype html><title>fake player</title>' }));
    const page = await context.newPage();
    await page.goto(at(sample.path), { waitUntil: 'load' });
    await page.click('[data-video] [data-play]');
    await Promise.race([requested, new Promise((r) => setTimeout(r, 10000))]);
    await page.evaluate(() => { const b = document.querySelector('[data-player-close]'); if (b) b.click(); });
    release();
    await page.waitForFunction(() => window.YT && window.YT.Player, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const played = await page.evaluate(() => (window.__yt ? window.__yt.calls.filter((c) => c[0] === 'play' || c[0] === 'load').length : 0));
    const frame = await page.locator('iframe#player-video').count();
    check(played === 0 && frame === 0, `player: closed before the YouTube API arrives, nothing plays afterwards (${played} play calls, ${frame} frame)`);
    await context.close();
  }

  // A script that failed to load is asked for again: the first YouTube API request fails (the
  // player opens the video on YouTube instead), the next Play loads the API and plays here. A
  // cached rejection used to leave the player dead until a reload.
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    let asked = 0;
    await context.route('https://www.youtube.com/iframe_api', (r) => (asked++ === 0 ? r.abort()
      : r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_IFRAME_API })));
    await context.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200,
      contentType: 'text/html', body: '<!doctype html><title>fake player</title>' }));
    await context.route('https://www.youtube.com/watch**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '' }));
    const page = await context.newPage();
    await page.goto(at(sample.path), { waitUntil: 'load' });
    await page.click('[data-video] [data-play]');
    await page.waitForTimeout(800);
    await page.locator('[aria-labelledby="related-title"] [data-play]').first().click();
    const recovered = await page.waitForFunction(() => window.__yt && window.__yt.calls.some((c) => c[0] === 'play' || c[0] === 'load'),
      null, { timeout: 10000 }).then(() => true, () => false);
    check(recovered && asked >= 2, `player: after the YouTube API failed to load once, the next Play loads it and plays (${asked} requests)`);
    await context.close();
  }

  // Back keeps the reader's place: on home, "Show more" twice and a scroll down, a review, Back;
  // as many results are open and the page is where it was (it used to reset to 24, at the top).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    const page = await context.newPage();
    await page.goto(at(''), { waitUntil: 'load' });
    const open = () => page.evaluate(() => document.querySelectorAll('#explorer-grid [data-track]:not([data-overflow]):not([hidden])').length);
    for (let i = 0; i < 2; i++) await page.click('[data-explorer-more]');
    const where = () => page.evaluate(() => ({ y: Math.round(window.scrollY), main: Math.round((document.getElementById('main-content') || {}).scrollTop || 0) }));
    const card = page.locator('#explorer-grid [data-track]:not([data-overflow]) h3 a').nth(40);
    await card.scrollIntoViewIfNeeded();
    const before = { open: await open(), at: await where() };
    await card.click();
    await page.waitForFunction(() => document.documentElement.dataset.navigatingState === '' && !document.getElementById('explorer-grid'), null, { timeout: 10000 }).catch(() => {});
    await page.goBack();
    await page.waitForFunction(() => !!document.getElementById('explorer-grid') && document.documentElement.dataset.navigatingState === '', null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    const after = { open: await open(), at: await where() };
    const near = Math.abs(after.at.y - before.at.y) <= 40 && Math.abs(after.at.main - before.at.main) <= 40;
    check(before.open > 48 && after.open === before.open && (before.at.y + before.at.main) > 400 && near,
      `router: Back keeps the reader's place (${after.open} of ${before.open} results open, at ${JSON.stringify(after.at)} of ${JSON.stringify(before.at)})`);
    await context.close();
  }

  // Forward keeps the reader's place too: home, a review read down to 900 px, Back, Forward; the
  // review returns where it was left (only pushed navigations used to save, so it came back at 0).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    const page = await context.newPage();
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate((href) => window.SonicRouter.go(href), new URL(sample.path, base).href);
    await page.waitForFunction((p) => location.pathname.endsWith('/' + p) && document.documentElement.dataset.navigatingState === '', sample.path, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(400);
    const left = await page.evaluate(() => Math.round(window.scrollY));
    await page.goBack();
    await page.waitForFunction(() => !!document.getElementById('explorer-grid') && document.documentElement.dataset.navigatingState === '', null, { timeout: 10000 }).catch(() => {});
    await page.goForward();
    await page.waitForFunction((p) => location.pathname.endsWith('/' + p) && document.documentElement.dataset.navigatingState === '', sample.path, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => Math.round(window.scrollY));
    check(left >= 850 && Math.abs(back - left) <= 40, `router: Forward returns to where the page was left (${back} of ${left})`);
    await context.close();
  }

  // Close beats a command still waiting for the play index: Play, then Close before play.json
  // arrives; nothing plays and YouTube is never asked (the late index used to reopen the player).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    let api = 0;
    await context.route('https://www.youtube.com/iframe_api', (r) => { api++; return r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_IFRAME_API }); });
    await context.route(/\/data\/play\.json/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback().catch(() => {});
    });
    const page = await context.newPage();
    await page.goto(at(`genre/${catalog.facets.genre[0].slug}/`), { waitUntil: 'load' });
    await page.locator('#term-grid [data-track] [data-play]').first().click();
    await page.evaluate(() => { const b = document.querySelector('[data-player-close]'); if (b) b.click(); });
    await page.waitForTimeout(2500);
    const queue = await page.evaluate(() => (window.SonicPlayer ? window.SonicPlayer.state().queue.length : -1));
    check(queue === 0 && api === 0, `player: Close before the play index arrives keeps the player closed (queue ${queue}, ${api} API requests)`);
    await context.close();
  }

  // Only the latest navigation lands: the archive is clicked first and answers slowly, a genre page
  // second and fast; the genre page stays (the slower, older page used to be committed over it).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    await context.route(/\/archive\/(\?.*)?$/, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fallback().catch(() => {});
    });
    const page = await context.newPage();
    await page.goto(at(sample.path), { waitUntil: 'load' });
    const genre = `genre/${catalog.facets.genre[0].slug}/`;
    await page.evaluate(([a, b]) => {
      for (const href of [a, b]) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = href;
        document.getElementById('main-content').appendChild(link);
      }
      const [first, second] = document.querySelectorAll('#main-content > a:nth-last-of-type(-n+2)');
      first.click();
      setTimeout(() => second.click(), 100);
    }, [new URL('archive/', base).href, new URL(genre, base).href]);
    await page.waitForTimeout(3000);
    const landed = await page.evaluate(() => ({ path: location.pathname, canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '' }));
    check(landed.path.endsWith('/' + genre) && landed.canonical.endsWith('/' + genre),
      `router: a slower, earlier navigation never lands over the latest one (${landed.path})`);
    await context.close();
  }

  // A left explorer's late answer never touches the next page: the review index of a search on
  // home arrives after the reader went to the archive (it used to write ?q= into the archive URL).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    let released = false;
    await context.route(/\/data\/search\.json/, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      released = true;
      await route.fallback().catch(() => {});
    });
    const page = await context.newPage();
    await page.goto(at('?q=syncopation'), { waitUntil: 'load' });
    await page.evaluate((href) => window.SonicRouter.go(href), new URL('archive/', base).href);
    await page.waitForFunction(() => location.pathname.endsWith('/archive/'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2600);
    const after = await page.evaluate(() => ({ path: location.pathname, search: location.search }));
    check(released && after.path.endsWith('/archive/') && !after.search.includes('q='),
      `explorer: a search answered after leaving home leaves the next page's URL alone (${after.path}${after.search})`);
    await context.close();
  }

  // Strings rendered before the language bundle arrives render again when it does: no raw key
  // (explorer.more, explorer.status_all) stays on a page whose bundle was slow.
  {
    const strings = (root ? JSON.parse(fs.readFileSync(path.join(root, 'data/i18n.json'), 'utf8'))
      : await (await get(at('data/i18n.json'))).json()).locales;
    const keys = [...new Set(Object.values(strings).flatMap((loc) => Object.keys(loc.strings)))].filter((k) => k.includes('.'));
    for (const rel of ['', 'cs/']) {
      const context = await browser.newContext({ viewport: desktop });
      if (root) await context.route(`${base}**`, fromArtifact);
      await context.route(/\/data\/i18n\.json/, async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.fallback().catch(() => {});
      });
      const page = await context.newPage();
      await page.goto(at(rel), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.dataset.i18nState === 'ready', null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
      const raw = await page.evaluate((ks) => {
        const text = document.body.innerText;
        return ks.filter((k) => new RegExp('(^|[^\\w.])' + k.replace(/\./g, '\\.') + '($|[^\\w.])').test(text));
      }, keys);
      check(raw.length === 0, `i18n: with a slow bundle no raw key stays on /${rel} (${raw.slice(0, 4).join(', ') || 'none'})`);
      await context.close();
    }
  }

  // A chart is navigation like a link: through the router, so the player keeps playing, and into
  // the page's language (a chart click used to reload the page and open the English archive).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    await fakeYouTube(context);
    const page = await context.newPage();
    const czech = sample.i18n && sample.i18n.cs ? sample.i18n.cs.path : 'cs/' + sample.path;
    await page.goto(at(czech), { waitUntil: 'load' });
    await page.click('[data-video] [data-play]');
    await page.waitForSelector('iframe#player-video', { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { window.__notReloaded = true; });
    await page.evaluate((href) => window.SonicRouter.go(href), new URL('cs/insights/', base).href);
    await page.waitForFunction(() => location.pathname.endsWith('/cs/insights/'), null, { timeout: 10000 }).catch(() => {});
    // Centred, so the fixed player bar (playing here) never covers the bar the click aims at.
    await page.evaluate(() => document.getElementById('chart-months').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => {
      const el = document.getElementById('chart-months');
      return el && window.echarts && window.echarts.getInstanceByDom(el);
    }, null, { timeout: 20000 }).catch(() => {});
    const point = await page.evaluate(() => {
      const el = document.getElementById('chart-months');
      const chart = window.echarts.getInstanceByDom(el);
      const data = chart.getOption().series[0].data;
      const i = data.length - 1;
      const [x, top] = chart.convertToPixel({ seriesIndex: 0 }, [i, data[i]]);
      const [, bottom] = chart.convertToPixel({ seriesIndex: 0 }, [i, 0]);
      const box = el.getBoundingClientRect();
      return { x: box.left + x, y: box.top + (top + bottom) / 2 };
    }).catch(() => null);
    if (point) await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => location.pathname.endsWith('/archive/'), null, { timeout: 10000 }).catch(() => {});
    const after = await page.evaluate(() => ({ path: location.pathname, hash: location.hash, kept: window.__notReloaded === true,
      frame: !!document.querySelector('iframe#player-video') }));
    check(!!point && after.path.endsWith('/cs/archive/') && after.hash.startsWith('#m-') && after.kept && after.frame,
      `charts: a bar opens the month in the page's language without a reload, the player playing on (${after.path}${after.hash}, reload ${!after.kept})`);
    await context.close();
  }

  // Track page: video and related tracks.
  {
    const { context, page, errors } = await open(browser, at(sample.path), desktop);
    check((await page.locator('[aria-labelledby="related-title"] article').count()) === sample.related.length, `track: ${sample.related.length} related tracks listed`);
    await shot(page, 'track-desktop-light');
    // The still plays this one track, nothing else (owner finding 2026-11-12: it used to queue
    // the track's radio); the radio is its own labelled control.
    await page.click('[data-video] [data-play]');
    await page.waitForFunction(() => window.SonicPlayer && window.SonicPlayer.state().queue.length > 0);
    const single = await page.evaluate(() => window.SonicPlayer.state().queue.map((t) => t.source));
    check(single.length === 1 && single[0] === sample.source, `track: the still plays this one track only (queued ${single.length})`);
    const src = await page.waitForSelector('#player-panel iframe', { timeout: 30000 })
      .then((el) => el.getAttribute('src')).catch(() => '');
    check(src.startsWith('https://www.youtube-nocookie.com/embed/' + sample.youtube), 'track: the player uses youtube-nocookie');
    check(await page.locator('[data-video] iframe').count() === 0, 'track: no inline iframe in the page');
    await page.click('[data-track-actions] [data-play-radio]');
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length > 1, null, { timeout: 10000 }).catch(() => {});
    const radio = await page.evaluate(() => window.SonicPlayer.state().queue.map((t) => t.source));
    const playable = sample.related.filter((r) => (catalog.tracks.find((t) => t.source === r.source) || {}).youtube);
    check(radio[0] === sample.source && playable.every((r) => radio.indexOf(r.source) > 0)
      && new Set(radio).size === radio.length,
      `track: Radio replaces the queue with the track and its related, each once (${radio.length})`);
    check((await page.getAttribute('#player-toast', 'data-shown')) === 'true' && (await page.textContent('[data-player-toast-text]')).trim() !== '',
      'track: replacing the queue is announced');
    await page.waitForTimeout(1500);
    // The neighbourhood graph draws with the custom ECharts build (data/echarts.json). A series
    // whose module the build lacks is dropped in silence (no console error, the canvas still
    // there), so the proof is the series ECharts actually built (seriesBuilt).
    await page.locator('#chart-neighbourhood').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => Number(document.documentElement.dataset.chartsState) > 0, null, { timeout: 15000 }).catch(() => {});
    const graph = await page.evaluate(seriesBuilt);
    check(graph.length === 1 && graph[0].built > 0, `track: the neighbourhood graph is built (${JSON.stringify(graph)})`);
    check(errors.length === 0, `track: no console errors after the player loads${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Phone width. Every control a finger has to hit is at least TARGET px each way (WCAG 2.2
  // 2.5.8 Target Size, AA); a link inside running text is exempt, as the criterion says.
  const TARGET = 24;
  const term = catalog.facets.genre[0];
  for (const [name, rel] of [['home', ''], ['track', sample.path], ['insights', 'insights/'], ['genre term', `genre/${term.slug}/`],
    ['genres', 'genre/'], ['archive', 'archive/'], ['concepts', 'concept/'], ['concept', `concept/${(catalog.concepts.find((c) => (c.tracks || []).length) || {}).slug}/`],
    ['author', 'author/'], ['welcome', 'welcome/'], ['cs track', (sample.i18n && sample.i18n.cs && sample.i18n.cs.path) || 'cs/']]) {
    const { context, page } = await open(browser, at(rel), phone, name === 'track' ? 'dark' : 'light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `${name} @390px: no horizontal overflow (${overflow}px)`);
    const small = await page.evaluate((min) => [...document.querySelectorAll('button, a[href], [role=button], select, input')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        if (!el.offsetParent || box.width <= 1) return false;  // not shown, or visually hidden (sr-only)
        if (getComputedStyle(el).display === 'inline') return false;  // in a sentence or a heading's line
        return box.width < min || box.height < min;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`), TARGET);
    check(small.length === 0, `${name} @390px: every control is at least ${TARGET}x${TARGET}px (${small.length}${small.length ? ': ' + [...new Set(small)].slice(0, 4).join(' | ') : ''})`);
    if (name === 'home') {
      await page.waitForFunction(() => window.FlowbiteInstances);
      await page.click('#toggleSidebarMobile');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => !document.getElementById('sidebar').classList.contains('-translate-x-full'));
      check(open, 'home @390px: the sidebar drawer opens');
      check(await page.evaluate(() => document.getElementById('main-content').hasAttribute('inert')),
        'home @390px: the open drawer makes the page behind it inert');
      await shot(page, 'home-phone-drawer');
      // review round 2: widening past 1024 px with the drawer open left the content inert
      await page.setViewportSize(desktop);
      await page.waitForTimeout(300);
      check(!(await page.evaluate(() => document.getElementById('main-content').hasAttribute('inert'))),
        'home: widening to desktop with the drawer open frees the content');
    } else {
      await shot(page, `${name}-phone`);
    }
    await context.close();
  }

  // Without JavaScript the phone still reaches the navigation (review round 2).
  {
    const { context, page } = await open(browser, at(''), phone, 'light', { javaScriptEnabled: false });
    const box = await page.locator('#sidebar').boundingBox();
    check(box && box.x >= 0 && box.width > 300, `no-JS @390px: the sidebar is on screen (x=${box && box.x})`);
    await context.close();
  }

  // Full-text search over the reviews uses the same tokens as the index (review round 2).
  {
    const term = 'four-on-the-floor';
    const expected = Object.entries(JSON.parse(root
      ? fs.readFileSync(path.join(root, 'data/search.json'), 'utf8')
      : await (await get(at('data/search.json'))).text()).tracks)
      .filter(([, words]) => ['four', 'floor'].every((w) => words.split(' ').includes(w))).length;
    const { context, page } = await open(browser, at(''), desktop);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    await page.fill('#explorer-q', term);
    await page.waitForFunction(() => document.documentElement.dataset.reviewsState === 'ready');
    await page.waitForTimeout(300);
    const shown = await page.locator('#explorer-grid [data-track]:not([hidden])').count();
    check(expected > 0 && shown >= expected, `search "${term}" finds the reviews that say it (${shown} ≥ ${expected})`);
    await context.close();
  }

  // A video YouTube removed (data/videos.json) shows a note, and its still is never requested.
  {
    const gone = catalog.tracks.find((t) => t.video_gone);
    if (gone) {
      const { context, page, errors } = await open(browser, at(gone.path), desktop);
      check(await page.locator('[role="note"]').count() === 1 && await page.locator('[data-video]').count() === 0,
        `gone video (${gone.source}): a note, no player`);
      check(errors.length === 0, `gone video: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
      await context.close();
    }
  }

  // The player: one control, one effect, no duplicates (owner findings 2026-11-12), and it keeps
  // playing across navigation (the router swaps pages, the bar and its frame survive).
  {
    const { context, page, errors } = await open(browser, at(''), desktop, 'light', {}, true);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    await page.evaluate(() => { window.__noReload = true; });
    const cards = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') });
    const S = [];
    for (let i = 0; i < 5; i++) S.push(await cards.nth(i).getAttribute('data-source'));
    const S5 = await cards.nth(5).getAttribute('data-source');
    const S6 = await cards.nth(6).getAttribute('data-source');
    const bundleStrings = (root ? JSON.parse(fs.readFileSync(path.join(root, 'data/i18n.json'), 'utf8'))
      : await (await get(at('data/i18n.json'))).json()).locales.en.strings;
    const card = (i, sel) => cards.nth(i).locator(sel);
    const queue = () => page.evaluate(() => window.SonicPlayer.state());
    const until = (expected, what) => page.waitForFunction((e) => {
      const s = window.SonicPlayer.state();
      return JSON.stringify(s.queue.map((t) => t.source)) === JSON.stringify(e.q) && (e.i === undefined || s.index === e.i);
    }, expected, { timeout: 10000 }).then(() => check(true, what)).catch(async () => {
      const s = await queue();
      check(false, `${what} (queue ${JSON.stringify(s.queue.map((t) => t.source))}, index ${s.index})`);
    });
    const pressed = (i) => card(i, '[data-queue]').getAttribute('aria-pressed');
    // The track menu ("⋯"): every action, labelled.
    const fromMenu = async (i, which) => {
      await card(i, '[data-track-menu]').click();
      await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
      await page.click(`#track-menu [data-menu-item="${which}"]`);
      await page.waitForSelector('#track-menu', { state: 'hidden', timeout: 5000 });
    };

    await card(0, '[data-play]').click();
    await until({ q: [S[0]], i: 0 }, 'player: play on a card plays that one track, nothing else');
    await page.waitForFunction(() => !document.getElementById('player').hidden, null, { timeout: 10000 });
    const frame = await page.waitForSelector('#player-panel iframe', { timeout: 30000 }).then(() => true).catch(() => false);
    check(frame, 'player: the YouTube player loads in the docked panel');

    await card(1, '[data-queue]').click();
    await until({ q: [S[0], S[1]] }, 'player: the queue button adds the track at the end');
    check(await pressed(1) === 'true', 'player: the queue button shows the track is queued (aria-pressed)');
    check((await page.getAttribute('#player-toast', 'data-shown')) === 'true', 'player: adding to the queue is announced');
    await card(1, '[data-queue]').click();
    await until({ q: [S[0]] }, 'player: the queue button again takes the track out (no duplicates)');
    check(await pressed(1) === 'false', 'player: the queue button shows the track is no longer queued');
    await card(1, '[data-queue]').click();
    await until({ q: [S[0], S[1]] }, 'player: queued again');
    await card(2, '[data-queue]').click();
    await until({ q: [S[0], S[1], S[2]] }, 'player: a second track queued after the first');
    await fromMenu(3, 'next');
    await until({ q: [S[0], S[3], S[1], S[2]], i: 0 }, 'player: play next (from the track menu) puts the track right after the current one');
    await card(2, '[data-play]').click();
    await until({ q: [S[0], S[2], S[3], S[1]], i: 1 }, 'player: play on a queued track plays it now, moved, not duplicated');
    await page.click('[data-player-next]');
    await until({ q: [S[0], S[2], S[3], S[1]], i: 2 }, 'player: next skips to the following track');

    const video = () => page.evaluate(() => window.__yt.player && window.__yt.player._video);
    const sample3 = catalog.tracks.find((t) => t.source === S[3]);
    check(await video() === sample3.youtube, 'player: the frame plays the current track\'s video');

    await page.click('[data-player-queue]');
    check(await page.isVisible('#player-queue'), 'player: the queue panel opens');
    const rows = async (kind) => page.locator(`#player-queue [data-queue-row="${kind}"]`).evaluateAll((els) => els.map((e) => e.dataset.source));
    check(JSON.stringify(await rows('now')) === JSON.stringify([S[3]]) && JSON.stringify(await rows('next')) === JSON.stringify([S[1]])
      && JSON.stringify(await rows('played')) === JSON.stringify([S[2], S[0]]),
      'player: the queue panel shows now playing, up next and played');
    await card(4, '[data-queue]').click();
    await until({ q: [S[0], S[2], S[3], S[1], S[4]] }, 'player: queued while the panel is open');
    await page.click(`#player-queue [data-queue-row="next"][data-source="${S[1]}"] [data-player-down]`);
    await until({ q: [S[0], S[2], S[3], S[4], S[1]] }, 'player: a queued track moves down');
    check(await page.evaluate((src) => { const r = document.activeElement && document.activeElement.closest('[data-queue-row]');
      return !!r && r.dataset.source === src; }, S[1]), 'player: keyboard focus stays on the moved track');
    await page.click(`#player-queue [data-queue-row="next"][data-source="${S[1]}"] [data-player-up]`);
    await until({ q: [S[0], S[2], S[3], S[1], S[4]] }, 'player: and up');
    // Drag to reorder (pointer events, so mouse and touch alike): the grip of S[4] dropped on the
    // upper half of S[1] puts S[4] first in up next.
    const grip = page.locator(`#player-queue [data-queue-row="next"][data-source="${S[4]}"] [data-player-grip]`);
    const onto = await page.locator(`#player-queue [data-queue-row="next"][data-source="${S[1]}"]`).boundingBox();
    const from = await grip.boundingBox();
    if (from && onto) {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, onto.y + onto.height / 4, { steps: 8 });
      await page.mouse.up();
    }
    await until({ q: [S[0], S[2], S[3], S[4], S[1]] }, 'player: dragging a queued track by its grip reorders up next');
    check(await page.locator('#player-queue [data-player-grip]').first().getAttribute('aria-hidden') === 'true',
      'player: the grip is pointer-only; keyboard users reorder with the up and down buttons');
    await page.click(`#player-queue [data-queue-row="next"][data-source="${S[4]}"] [data-player-remove]`);
    await until({ q: [S[0], S[2], S[3], S[1]] }, 'player: a queued track is removed from the panel');
    check(await pressed(4) === 'false', 'player: the card follows a removal made in the panel');
    // What YouTube does on its own: a track ends (the next plays), a video fails (it is skipped),
    // the queue runs out (it stops on the last track), repeat one (the track plays again).
    await page.evaluate(() => window.__yt.fire(0));
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: a track that ends plays the next one');
    // Autoplay is on by default: past the last track a random track that has not played follows.
    await page.evaluate(() => window.__yt.fire(0));
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length === 5, null, { timeout: 5000 }).catch(() => {});
    const auto = await queue();
    check(auto.queue.length === 5 && auto.index === 4 && auto.queue[4].auto === true && !S.slice(0, 4).includes(auto.queue[4].source)
      && (await page.getAttribute('#player-toast', 'data-shown')) === 'true',
      `player: autoplay (default) plays a random new track when the queue ends (${auto.queue[4] && auto.queue[4].source})`);
    await page.evaluate(() => window.SonicPlayer.remove(4));
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: the autoplayed track is removed again');
    await page.click('#player-queue label:has([data-player-autoplay])');
    check((await queue()).autoplay === false, 'player: the autoplay switch turns it off (and it is remembered)');
    await page.evaluate(() => window.__yt.fire(0));
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: without autoplay the queue stops at its end, nothing loops');
    check(await page.evaluate(() => document.documentElement.dataset.playerState) === 'paused'
      && await page.isDisabled('[data-player-next]'), 'player: at the end it shows paused and next is disabled');
    await page.click('#player-queue [data-queue-row="played"] [data-player-jump]');
    await until({ q: [S[0], S[2], S[3], S[1]], i: 2 }, 'player: a played track can be played again from the panel');
    await page.evaluate(() => window.__yt.error());
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: a video that cannot play is skipped');
    await page.click('[data-player-repeat]');
    await page.click('[data-player-repeat]');
    const loads = await page.evaluate(() => window.__yt.calls.filter((c) => c[0] === 'load').length);
    await page.evaluate(() => window.__yt.fire(0));
    await page.waitForFunction((n) => window.__yt.calls.filter((c) => c[0] === 'load').length > n, loads, { timeout: 5000 })
      .then(() => check(true, 'player: repeat one plays the ended track again')).catch(() => check(false, 'player: repeat one plays the ended track again'));
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: repeat one stays on the track');
    await page.click('[data-player-repeat]');
    await page.click('[data-player-prev]');
    await until({ q: [S[0], S[2], S[3], S[1]], i: 2 }, 'player: previous at the start of a track goes to the previous track');
    await page.evaluate(() => { window.__yt.player._time = 42; });
    await page.click('[data-player-prev]');
    check(await page.evaluate(() => { const c = window.__yt.calls; const l = c[c.length - 1]; return l[0] === 'seek' && l[1] === 0; })
      && (await queue()).index === 2, 'player: previous past 3 s restarts the track');
    await page.click('[data-player-toggle]');
    check(await page.evaluate(() => window.__yt.player._state) === 2, 'player: the toggle pauses');
    await page.click('[data-player-toggle]');
    check(await page.evaluate(() => window.__yt.player._state) === 1, 'player: and plays again');
    await page.click(`#player-queue [data-queue-row="next"][data-source="${S[1]}"] [data-player-jump]`);
    await until({ q: [S[0], S[2], S[3], S[1]], i: 3 }, 'player: an up-next track plays from the panel');
    await fromMenu(3, 'next');
    await until({ q: [S[0], S[2], S[1], S[3]], i: 2 }, 'player: play next on a played track moves it after the current one');
    await page.click('[data-player-clear]');
    await until({ q: [S[1]], i: 0 }, 'player: clear flushes the queue, the current track plays on');
    check(await page.isVisible('[data-player-undo]'), 'player: clear offers undo');
    await page.click('[data-player-undo]');
    await until({ q: [S[0], S[2], S[1], S[3]], i: 2 }, 'player: undo brings the cleared queue back');
    await page.click('[data-player-clear]');
    await until({ q: [S[1]], i: 0 }, 'player: cleared again');

    // The playing track's card shows pause and pauses; the keyboard drives the player.
    const icon = (which) => card(1, `[data-play] [data-icon-${which}]`).evaluate((e) => getComputedStyle(e).display);
    await page.evaluate(() => window.__yt.player.playVideo());
    check(await icon('pause') !== 'none' && await icon('play') === 'none', 'player: the playing track\'s card shows pause');
    await card(1, '[data-play]').click();
    check(await page.evaluate(() => window.__yt.player._state) === 2 && await icon('play') !== 'none',
      'player: pause on the card pauses, and the card shows play again');
    await page.keyboard.press('k');
    check(await page.evaluate(() => window.__yt.player._state) === 1, 'player: K plays');
    await page.keyboard.press('k');
    check(await page.evaluate(() => window.__yt.player._state) === 2, 'player: K pauses');
    await page.evaluate(() => { window.__yt.player._time = 120; });
    await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('[data-player-progress]').style.width) - 50) < 0.5, null, { timeout: 3000 })
      .then(() => check(true, 'player: the progress line follows the track (phones have no seek bar)'))
      .catch(() => check(false, 'player: the progress line follows the track (phones have no seek bar)'));
    check(await page.evaluate(() => { const t = document.getElementById('player-toast');
      return !!t && t.getAttribute('role') === 'status' && !t.hidden; }), 'player: the toast is a live region that is always present');
    check(await page.isHidden('[data-player-count]'), 'player: no badge when nothing is queued');
    check(await page.isVisible('#player-queue [data-queue-empty]'), 'player: the empty queue says how to add tracks');
    await page.keyboard.press('Escape');
    check(await page.isHidden('#player-queue'), 'player: Escape closes the queue panel');

    const repeats = [];
    for (let i = 0; i < 3; i++) { await page.click('[data-player-repeat]'); repeats.push((await queue()).repeat); }
    check(repeats.join() === 'all,one,off', `player: repeat cycles all, one, off (${repeats.join()})`);

    const width = () => page.evaluate(() => document.getElementById('player-panel').getBoundingClientRect().width);
    const before = await width();
    await page.click('[data-player-size]');
    const after = await width();
    const [small, large] = [Math.min(before, after), Math.max(before, after)];
    check(before < 250 && small >= 200 && large > 300,
      `player: the video starts small and toggles larger (${Math.round(small)} ↔ ${Math.round(large)} px), never hidden`);
    await page.click('[data-player-size]');
    await page.click('[data-player-minimise]');
    const mini = await page.evaluate(() => ({ view: document.documentElement.dataset.playerViewState,
      bar: document.getElementById('player').getBoundingClientRect().width }));
    check(mini.view === 'mini' && mini.bar <= 360 && await page.isVisible('[data-player-expand]') && await page.isHidden('[data-player-queue]'),
      `player: minimise turns the bar into a pill (${Math.round(mini.bar)} px)`);
    await page.click('[data-player-expand]');
    check(await page.evaluate(() => document.documentElement.dataset.playerViewState === 'full'), 'player: expand restores the bar');

    await page.evaluate(() => { window.__frame = document.querySelector('#player-panel iframe'); });
    await page.locator('#sidebar a[href$="/insights/"]').click();
    await page.waitForFunction(() => /Insights/.test(document.title) && Number(document.documentElement.dataset.chartsState) > 0, null, { timeout: 20000 });
    const kept = await page.evaluate(() => window.__noReload === true && !document.getElementById('player').hidden
      && document.querySelector('#player-panel iframe') === window.__frame);
    check(kept, 'router: navigating keeps the page, the bar and the playing frame (no reload)');
    const insights = await page.evaluate(seriesBuilt);
    check(insights.length > 0 && insights.every((c) => c.built > 0),
      `insights: every chart's series is built by the shipped ECharts (${insights.map((c) => c.id + ':' + c.built).join(', ')})`);
    check(new URL(page.url()).pathname.endsWith('/insights/'), 'router: the URL follows the navigation');
    await page.goBack();
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready', null, { timeout: 15000 })
      .then(() => check(true, 'router: back remounts the explorer'))
      .catch(() => check(false, 'router: back remounts the explorer'));

    const visible = await page.locator('#explorer-grid [data-track]:not([hidden]) [data-play]').count();
    await page.click('[data-play-all="explorer-grid"]');
    await page.waitForFunction((n) => window.SonicPlayer.state().queue.length === n, visible, { timeout: 10000 })
      .then(() => check(true, `player: Play all replaces the queue with the ${visible} tracks shown`))
      .catch(() => check(false, `player: Play all replaces the queue with the ${visible} tracks shown`));
    await shot(page, 'player-home');

    await page.evaluate(() => { window.__yt.player._time = 120; });
    await page.waitForFunction(() => window.SonicPlayer.state().time >= 100, null, { timeout: 5000 }).catch(() => {});
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('player').hidden, null, { timeout: 10000 }).catch(() => {});
    const resumed = await page.evaluate(() => ({ n: window.SonicPlayer.state().queue.length,
      panel: document.getElementById('player-panel').hidden, frame: !!document.querySelector('#player-panel iframe') }));
    check(resumed.n === visible && resumed.panel && !resumed.frame,
      'player: a reload keeps the queue, paused, with no third-party request until play');
    const other = await page.evaluate(() => { const s = window.SonicPlayer.state(); return s.queue[s.index].source; });
    const another = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') })
      .filter({ hasNot: page.locator(`[data-source="${other}"]`) }).nth(4);
    await page.locator(`#explorer-grid [data-track][data-source="${await another.getAttribute('data-source')}"] [data-play]`).click();
    const src = await page.waitForSelector('#player-panel iframe', { timeout: 10000 }).then((e) => e.getAttribute('src')).catch(() => '');
    check(/[?&]start=0(&|$)/.test(src), 'player: after a reload another track starts at 0, not at the saved time of the last one');
    await page.click('[data-player-close]');
    check(await page.isHidden('#player') && (await queue()).queue.length === 0, 'player: close stops and empties the player');
    await page.click('[data-player-undo]');
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length > 0 && !document.getElementById('player').hidden, null, { timeout: 5000 })
      .then(() => check(true, 'player: undo after close brings the player and its queue back'))
      .catch(() => check(false, 'player: undo after close brings the player and its queue back'));
    await page.click('[data-player-close]');

    // The track menu: opens beside its trigger, labelled, driven by the keyboard.
    const trigger = card(5, '[data-track-menu]');
    await trigger.click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    const title5 = catalog.tracks.find((t) => t.source === S5);
    check((await page.textContent('[data-track-menu-title]')).includes(title5.track)
      && await trigger.getAttribute('aria-expanded') === 'true'
      && await page.evaluate(() => document.activeElement && document.activeElement.dataset.menuItem === 'play'),
      'track menu: opens with the track named, aria-expanded, focus on its first action');
    await shot(page, 'track-menu-desktop');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.dataset.menuItem) === 'next', 'track menu: arrows move between actions');
    await page.keyboard.press('Escape');
    check(await page.isHidden('#track-menu') && await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-track-menu'))
      && await trigger.getAttribute('aria-expanded') === 'false', 'track menu: Escape closes it and returns focus to its trigger');
    await fromMenu(5, 'play');
    await until({ q: [S5], i: 0 }, 'track menu: Play now plays that one track');
    await fromMenu(6, 'queue');
    await until({ q: [S5, S6] }, 'track menu: Add to queue adds the track');
    await card(6, '[data-track-menu]').click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    check(await page.textContent('[data-menu-queue-label]') === bundleStrings['trackmenu.queue_remove'],
      'track menu: a queued track offers Remove from queue');
    await page.click('#track-menu [data-menu-item="queue"]');
    await until({ q: [S5] }, 'track menu: Remove from queue takes it out');
    await fromMenu(5, 'copy');
    check((await page.textContent('[data-player-toast-text]')) === bundleStrings['trackmenu.copied'], 'track menu: Copy link says the link is copied');
    await page.click('[data-player-close]');
    check(errors.length === 0, `player and router: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // The player at phone width: everything reachable, nothing overlapping, nothing overflowing.
  {
    const { context, page, errors } = await open(browser, at(''), phone, 'light', {}, true);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const cards = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') });
    await cards.nth(0).locator('[data-play]').click();
    await cards.nth(1).locator('[data-queue]').click();
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length === 2, null, { timeout: 10000 });
    await page.waitForSelector('#player-panel iframe', { timeout: 30000 }).catch(() => {});
    const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, sel);
    const fits = await page.evaluate(() => [...document.querySelectorAll('#player button')]
      .filter((b) => b.offsetParent !== null).every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
    check(fits, 'player (phone): every visible bar control is on screen');
    await page.click('[data-player-queue]');
    const q = await box('#player-queue');
    const v = await box('#player-panel');
    const overlap = !(q.r <= v.l || v.r <= q.l || q.b <= v.t || v.b <= q.t);
    check(!overlap, 'player (phone): the open queue and the video do not overlap');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'player (phone): no horizontal overflow');
    await shot(page, 'player-phone-queue');
    await page.keyboard.press('Escape');
    await cards.nth(2).locator('[data-track-menu]').click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    const sheet = await box('#track-menu');
    check(Math.round(sheet.l) === 0 && Math.round(sheet.r) === 390 && Math.abs(sheet.b - 844) < 2,
      'track menu (phone): a bottom sheet across the screen');
    await shot(page, 'track-menu-phone');
    await page.keyboard.press('Escape');
    await page.click('[data-player-minimise]');
    const pill = await box('#player');
    check(pill.r <= 390 && pill.l >= 0 && pill.b - pill.t < 70, 'player (phone): minimised to a pill');
    check(errors.length === 0, `player (phone): no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Both languages (ADR 0006): every page is built in English at the root and in Czech under /cs/.
  // The default home page takes a browser that prefers Czech to /cs/ on a first visit; any other
  // URL stays in its language; the switch moves to the counterpart under the persistent player and
  // is remembered; the shell (navbar, player) follows the language of the page shown.
  {
    const bundle = root ? JSON.parse(fs.readFileSync(path.join(root, 'data/i18n.json'), 'utf8'))
      : await (await get(at('data/i18n.json'))).json();
    const other = Object.keys(bundle.locales).find((c) => c !== bundle.default);
    const both = catalog.tracks.find((t) => (t.langs || []).includes(other));
    if (other && !both) check(false, `i18n: at least one review is translated into ${other} (catalog.tracks[].langs)`);
    if (other && both) {
      const s = bundle.locales[other].strings;
      const d = bundle.locales[bundle.default].strings;
      // A browser that prefers the other language, on its first visit to the root.
      {
        const { context, page, errors } = await open(browser, at(''), desktop, 'light', { locale: other === 'cs' ? 'cs-CZ' : other });
        await page.waitForFunction((code) => document.documentElement.lang === code && document.documentElement.dataset.i18nState === 'ready', other, { timeout: 15000 })
          .then(() => check(true, `i18n: a browser preferring ${other} is taken from the root to /${other}/`))
          .catch(() => check(false, `i18n: a browser preferring ${other} is taken from the root to /${other}/ (at ${page.url()})`));
        check(new URL(page.url()).pathname.endsWith(`/${other}/`) && await page.getAttribute('#topbar-search', 'placeholder') === s['nav.search_placeholder'],
          `i18n: the /${other}/ home is in ${other}, its interface strings too`);
        check(errors.length === 0, `i18n: no console errors (${other} home)${errors.length ? ' — ' + errors.join(' | ') : ''}`);
        await context.close();
      }
      // The other language's URL stays in it for a browser of the default language.
      {
        const { context, page, errors } = await open(browser, at(both.i18n[other].path), desktop);
        await page.waitForFunction(() => document.documentElement.dataset.i18nState === 'ready');
        check(await page.evaluate(() => document.documentElement.lang) === other && new URL(page.url()).pathname.endsWith('/' + both.i18n[other].path),
          `i18n: /${both.i18n[other].path} stays in ${other} (no redirect away from a link)`);
        const h1 = (await page.textContent('h1') || '').trim();
        check(h1 === both.track, `i18n: the ${other} review shows its track (${h1})`);
        const hreflang = await page.locator('link[rel="alternate"][hreflang]').evaluateAll((els) => els.map((e) => e.getAttribute('hreflang')).sort().join());
        check(hreflang.includes(bundle.default) && hreflang.includes(other) && hreflang.includes('x-default'),
          `i18n: the page names its counterparts (hreflang ${hreflang})`);
        // Switch to the default language: the counterpart, under the persistent player.
        await page.evaluate(() => { window.__notReloaded = true; });
        await page.selectOption('#locale-switch', bundle.default);
        await page.waitForFunction((code) => document.documentElement.lang === code, bundle.default, { timeout: 15000 }).catch(() => {});
        check(await page.evaluate(() => window.__notReloaded === true) && new URL(page.url()).pathname.endsWith('/' + both.path)
          && await page.getAttribute('#topbar-search', 'placeholder') === d['nav.search_placeholder'],
          `i18n: the switch opens the ${bundle.default} counterpart without a reload, the navbar follows`);
        // The shell after the switch is the shell a reload renders: every link and form outside the
        // page's content points where it would (the logo, search and feed stayed in the old
        // language, found by an independent review on 2026-11-14).
        const shell = () => page.evaluate(() => [...document.querySelectorAll('[href], [action]')]
          .filter((el) => !el.closest('#main-content') && !el.closest('#player'))
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${el.getAttribute('href') || el.getAttribute('action')}`)
          .sort());
        const switched = await shell();
        await page.reload({ waitUntil: 'load' });
        const reloaded = await shell();
        // Compared as multisets: the sidebar's home link must not hide a stale logo with the same URL.
        const left = switched.slice();
        const stale = reloaded.filter((x) => { const i = left.indexOf(x); if (i < 0) return true; left.splice(i, 1); return false; });
        check(reloaded.length > 5 && stale.length === 0,
          `i18n: after the switch every link and form of the shell points where a reload points it (${reloaded.length})` +
          (stale.length ? ' — a reload has ' + stale.slice(0, 4).join(' | ') : ''));
        // Every term the page shows is its label in the page's language: a term page's and a concept
        // page's heading, the cards of a facet's list, the archive's genre notes.
        const term = (catalog.lang_terms[other].genre || []).find((g) => s['term.genre.' + g] && s['term.genre.' + g] !== g);
        if (term) {
          await page.goto(at(`${other}/genre/${term.replace(/[^a-z0-9]+/g, '-')}/`), { waitUntil: 'load' });
          check((await page.textContent('h1') || '').trim() === s['term.genre.' + term],
            `i18n: the ${other} term page is headed by its label (${term} → ${s['term.genre.' + term]})`);
        }
        const concept = catalog.concepts.find((c) => (catalog.lang_terms[other].concept || []).includes(c.term) && s['term.concept.' + c.term] !== c.term);
        if (concept) {
          await page.goto(at(`${other}/concept/${concept.slug}/`), { waitUntil: 'load' });
          check((await page.textContent('h1') || '').trim() === s['term.concept.' + concept.term],
            `i18n: the ${other} concept page is headed by its label (${concept.term} → ${s['term.concept.' + concept.term]})`);
        }
        await page.goto(at(`${other}/genre/`), { waitUntil: 'load' });
        const labels = new Set(Object.keys(s).filter((k) => k.startsWith('term.genre.')).map((k) => s[k]));
        const cards = await page.locator('main a span.truncate').allTextContents();
        const raw = cards.map((c) => c.trim()).filter((c) => !labels.has(c));
        check(cards.length > 0 && raw.length === 0, `i18n: every ${other} genre card shows its label (${cards.length} cards${raw.length ? ', raw: ' + raw.slice(0, 3).join(', ') : ''})`);
        await page.goto(at(`${other}/archive/`), { waitUntil: 'load' });
        const notes = await page.locator('[data-queue-row], main li[data-track] span.text-xs').allTextContents();
        const english = notes.flatMap((n) => n.split(' · ').map((x) => x.trim())).filter((x) => x && !labels.has(x));
        check(notes.length > 0 && english.length === 0, `i18n: the ${other} archive names genres by their labels${english.length ? ' (raw: ' + english.slice(0, 3).join(', ') + ')' : ''}`);
        // Remembered: the root no longer redirects, whatever the browser prefers.
        await page.goto(at(''), { waitUntil: 'load' });
        await page.waitForFunction(() => document.documentElement.dataset.i18nState === 'ready');
        check(await page.evaluate(() => document.documentElement.lang) === bundle.default, 'i18n: the choice is remembered');
        const untranslated = await page.evaluate((def) => [...document.querySelectorAll('[data-i18n]')]
          .filter((el) => el.offsetParent !== null && el.textContent.trim() === '' && def[el.dataset.i18n]).length, d);
        check(untranslated === 0, `i18n: no interface string left empty (${untranslated})`);
        check(errors.length === 0, `i18n: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
        await context.close();
      }
      // Plurals: the browser (Sonic.t) picks the form the build (`tr`) picked, for every count
      // string of a page in the other language, and each of that locale's forms for its integers.
      {
        const terms = ((catalog.lang_terms || {})[other] || {}).genre || [];
        const term = catalog.facets.genre.find((f) => terms.includes(f.term)) || catalog.facets.genre[0];
        const { context, page, errors } = await open(browser, at(`${other}/genre/${term.slug}/`), desktop);
        await page.waitForFunction(() => document.documentElement.dataset.i18nState === 'ready');
        const diff = await page.evaluate(async (strings) => {
          const built = new DOMParser().parseFromString(await (await fetch(location.href)).text(), 'text/html');
          const sel = '[data-i18n][data-i18n-vars]';
          const live = [...document.querySelectorAll(sel)];
          const plural = (el) => strings[el.getAttribute('data-i18n')] && typeof strings[el.getAttribute('data-i18n')] === 'object';
          const was = [...built.querySelectorAll(sel)].filter(plural).map((el) => el.textContent.trim());
          const now = live.filter(plural).map((el) => el.textContent.trim());
          return { count: now.length, differ: now.filter((t, i) => t !== was[i]) };
        }, s);
        check(diff.count >= 2 && diff.differ.length === 0,
          `i18n: ${diff.count} count strings of /${other}/genre/${term.slug}/ read the same in the build and the browser${diff.differ.length ? ' — ' + diff.differ.join(' | ') : ''}`);
        const rule = s['locale.plural'];
        for (const [cat, ns] of Object.entries(rule)) {
          const n = ns[0];
          const got = await page.evaluate(([n]) => window.Sonic.t('tax.count', { n }), [n]);
          check(got === s['tax.count'][cat].replace('{n}', String(n)), `i18n: Sonic.t picks the ${other} '${cat}' form for ${n} (${got})`);
        }
        check(errors.length === 0, `i18n: no console errors (plurals)${errors.length ? ' — ' + errors.join(' | ') : ''}`);
        await context.close();
      }
    }
  }

  // The card format: data/media.toml [social], carried by static/data/images.json.
  const social = (root ? JSON.parse(fs.readFileSync(path.join(root, 'data/images.json'), 'utf8'))
    : await (await get(at('data/images.json'))).json()).social;
  // Every page's social card is served as an image (Open Graph / X); checked on the home page and
  // a track, here and against production (rule project.social-preview).
  {
    const { context, page } = await open(browser, at(''), desktop);
    for (const rel of ['', sample.path]) {
      await page.goto(at(rel), { waitUntil: 'domcontentloaded' });
      const og = await page.getAttribute('meta[property="og:image"]', 'content');
      const tw = await page.getAttribute('meta[name="twitter:image"]', 'content');
      // The artefact is checked on disk (API requests bypass the route to it); production by HTTP.
      let body = null;
      let how = '';
      if (root) {
        const file = path.join(root, new URL(og).pathname.slice(new URL(base).pathname.length));
        body = fs.existsSync(file) ? fs.readFileSync(file) : null;
        how = body ? 'in the artefact' : 'missing from the artefact';
      } else {
        const res = await page.request.get(og + (revision ? '?v=' + revision : ''));
        body = res.status() === 200 && (res.headers()['content-type'] || '').startsWith('image/' + social.format) ? await res.body() : null;
        how = `HTTP ${res.status()}`;
      }
      // The bytes are the format data/media.toml [social] names: JPEG FF D8 FF, PNG 89 'PNG', WebP 'RIFF'.
      const magic = { jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, png: (b) => b.slice(1, 4).toString() === 'PNG',
        webp: (b) => b.slice(0, 4).toString() === 'RIFF' }[social.format];
      const ok = !!body && body.length > 10000 && !!magic && magic(body);
      check(ok && og === tw, `social card of /${rel}: ${og.split('/').pop()} is a ${social.format.toUpperCase()} (${how})`);
    }
    await context.close();
  }

  // YouTube stills (rule project.media-budget): a row offers the stills of data/media.toml
  // [youtube] as a srcset and the browser takes the smallest sharp one, never the 4:3 hqdefault
  // with its bars for a 64 px row. A still that fails (a video removed from YouTube) becomes the
  // placeholder with its srcset dropped as well, so no other still of the lost video is tried.
  {
    const still = '[data-track] img[data-thumb][srcset]';
    const { context, page } = await open(browser, at('archive/'), desktop);
    const row = page.locator(still).first();
    await row.evaluate((img) => img.decode().catch(() => {}));
    const picked = await row.evaluate((img) => img.currentSrc.split('/').pop());
    check(picked === 'mqdefault.jpg', `stills: a 64 px archive row loads mqdefault.jpg (${picked})`);
    await context.close();

    const lost = await browser.newContext({ viewport: desktop });
    if (root) await lost.route(`${base}**`, fromArtifact);
    await lost.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    const gone = await lost.newPage();
    await gone.goto(at('archive/'), { waitUntil: 'load' });
    const placeholder = await gone.waitForFunction((sel) => {
      const img = document.querySelector(sel.replace('[srcset]', ''));
      return img && img.dataset.thumbFailed === 'true' && !img.hasAttribute('srcset') && !img.hasAttribute('src');
    }, still, { timeout: 5000 }).then(() => true, () => false);
    check(placeholder, 'stills: a lost still becomes the placeholder, its src and srcset both dropped');
    await lost.close();
  }

  // The educational layer (ADR 0004): a review that teaches shows its guide, concepts, sources
  // and connections from the front matter; its structured data is an Article and a
  // LearningResource; concepts link to their pages; the glossary lists every concept; a
  // concept's definition follows the locale; the listening guide seeks the player.
  {
    const teacher = catalog.tracks.find((t) => (t.edu || []).includes('learning') && (t.edu || []).includes('concept'));
    if (!teacher) {
      check(false, 'education: at least one review teaches (catalog.tracks[].edu)');
    } else {
      const { context, page, errors } = await open(browser, at(teacher.path), desktop, 'light', {}, true);
      check(await page.isVisible('#learn-title') && (await page.locator('[data-listening-guide] li').count()) >= 3,
        `education (${teacher.source}): the learning guide with at least three listening points`);
      check((await page.locator('#refs-title + ol li').count()) >= 2, 'education: at least two cited sources');
      check(await page.locator('#concepts-title').isVisible() && (await page.locator('[data-concept-card]').count()) >= 1,
        'education: the concepts the review teaches, as cards');
      const ld = await page.evaluate(() => JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent));
      const article = (ld['@graph'] || []).find((n) => Array.isArray(n['@type']) && n['@type'].includes('LearningResource'));
      const recording = (ld['@graph'] || []).find((n) => n['@type'] === 'MusicRecording');
      check(!!article && !!recording && (article.teaches || []).length >= 1 && article.about['@id'] === recording['@id'],
        'education: structured data is an Article + LearningResource about the MusicRecording, with what it teaches');
      const link = page.locator('.format a.concept-link').first();
      const href = await link.getAttribute('href');
      check(/\/concept\/[a-z0-9-]+\/$/.test(href || '') && (await link.getAttribute('title') || '').length > 40,
        'education: a concept named in the prose links to its page, its definition as the tooltip');
      // The listening guide's seek: the player starts the track at the time asked.
      await page.evaluate((src) => window.Sonic.catalog().then((c) => window.SonicPlayer.seek(c.tracks.find((t) => t.source === src), '1:05')), teacher.source);
      const src = await page.waitForSelector('#player-panel iframe', { timeout: 10000 }).then((e) => e.getAttribute('src')).catch(() => '');
      check(/[?&]start=65(&|$)/.test(src), 'education: the listening guide seeks the player to its time (1:05 = 65 s)');
      await link.click();
      await page.waitForFunction(() => /\/concept\//.test(location.pathname) && !!document.querySelector('main p[lang]'), null, { timeout: 15000 })
        .then(() => check(true, 'education: the concept link opens the concept page (router)'))
        .catch(() => check(false, 'education: the concept link opens the concept page (router)'));
      const shownLang = () => page.evaluate(() => (document.querySelector('main p[lang]') || {}).lang || '');
      check(await shownLang() === 'en', 'education: a concept shows its definition in the page language (en)');
      // A concept the Czech corpus has a page for (catalog.lang_terms; every one, once translated).
      const csTerm = ((catalog.lang_terms || {}).cs || {}).concept || [];
      const csConcept = catalog.concepts.find((c) => csTerm.includes(c.term));
      await page.goto(at('cs/concept/' + (csConcept ? csConcept.slug : '') + '/'), { waitUntil: 'load' });
      check(await shownLang() === 'cs', 'education: the Czech concept page shows the Czech definition');
      await page.goto(at('concept/'), { waitUntil: 'load' });
      check((await page.locator('[data-concept-card]').count()) === catalog.concepts.length,
        `education: the glossary lists all ${catalog.concepts.length} concepts`);
      check(errors.length === 0, `education: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
      await context.close();
    }
  }

  // Yearbooks (ADR 0005): when the corpus has any, the list and each year serve, every reviewed
  // item links to its review, and the counts are the catalogue's.
  if (catalog.yearbooks && catalog.yearbooks.length) {
    const { context, page, errors } = await open(browser, at('yearbook/'), desktop);
    check((await page.locator('[data-yearbook]').count()) === catalog.yearbooks.length, `yearbooks: the list shows all ${catalog.yearbooks.length}`);
    for (const b of catalog.yearbooks) {
      await page.goto(at(`yearbook/${b.year}/`), { waitUntil: 'load' });
      const rows = await page.locator('#yearbook-list > li').count();
      const playable = await page.locator('#yearbook-list [data-track]').count();
      check(rows === b.items && playable === b.present, `yearbook ${b.year}: ${b.items} items in order, ${b.present} playable reviews`);
    }
    check(errors.length === 0, `yearbooks: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  await wcag(browser, desktop, new Set(catalog.tracks.map((t) => t.path)));
  if (process.env.SMOKE_SWEEP !== '0') await sweep(browser);

  await browser.close();
  for (const n of notices) console.log(`note ${n}`);
  console.log(failures.length ? `smoke: ${failures.length} failure(s)` : 'smoke: all checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
