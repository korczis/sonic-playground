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
//   - its full-text search: relevance first, whole words, short tokens, word forms, phrases,
//     English and Czech, each checked against the index as served;
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
const { retryAfter, HOST_PAUSES_MS } = require('./retry.cjs');
const v8lines = require('./v8lines.cjs');

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
// the custom build (data/echarts.json) lacks is dropped silently, so 0 means a missing module,
// and -1 a holder no chart was made for (a form renamed away): it stays in the list, so a check
// of every chart fails on it (it was filtered out, which let a lost chart pass; a review, 2026-11-14).
function seriesBuilt() {
  return [...document.querySelectorAll('[data-chart]')].map((el) => {
    const chart = window.echarts && window.echarts.getInstanceByDom(el);
    return { id: el.id, built: chart ? chart.getModel().getSeriesCount() : -1 };
  });
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
// check that passed and the pages still in flight, so the cause is in the log. 35 minutes: the
// sweep of every sitemap page (3,300+ at 717 reviews) outgrew 15 on CI's runner (run 44584448724),
// and the CI and production jobs that run it allow 50 and 55.
const inFlight = new Set();
const WATCHDOG = Number(process.env.SMOKE_TIMEOUT_MS || 35 * 60 * 1000);
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
    // A headless browser composites in software, so it reads every WebGL frame back itself and
    // ANGLE reports that stall; a real Chrome composites on the GPU and never does (knowledge
    // console-clean-by-construction). A notice, never a pass: any other warning still fails.
    if (/^\[\.WebGL-[0-9a-fx]+\]GL Driver Message \([^)]*Performance[^)]*\): GPU stall due to ReadPixels/.test(m.text())) {
      notices.add(`headless compositing (not the site): ${m.text()}`);
      return;
    }
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

// The sweep's parallel pages: SMOKE_WORKERS, else on CI the machine's cores less two, never fewer
// than the six the CI runner always had and never more than sixteen (each is a browser context).
// Off CI the default is six: sixteen contexts beside a desktop ran a workstation out of memory.
// Every page is still visited, scrolled and waited for; only more of them at once.
const SWEEP_WORKERS = Number(process.env.SMOKE_WORKERS)
  || (process.env.CI ? Math.min(16, Math.max(6, require('node:os').cpus().length - 2)) : 6);

// SMOKE_SHARD=k/n: the sweep visits only every n-th sitemap page from the k-th, so n jobs share
// it (CI: .github/workflows/ci.yml and pages.yml). SMOKE_SWEEP=only skips the feature checks: a
// shard whose job is the sweep alone. Unset, one run checks everything.
const SHARD = (() => {
  const m = /^(\d+)\/(\d+)$/.exec(process.env.SMOKE_SHARD || '1/1');
  const [k, n] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!(n >= 1 && k >= 1 && k <= n)) {
    console.error(`smoke: SMOKE_SHARD must be k/n with 1 <= k <= n, not "${process.env.SMOKE_SHARD}"`);
    process.exit(2);
  }
  return { k, n };
})();
const SWEEP_ONLY = process.env.SMOKE_SWEEP === 'only';

// SMOKE_PATHS_FILE=<file>: the sweep visits only these site paths (one per line, relative to the
// base URL, '/' the home page; scripts/verify.sh writes the pages a local change can affect). A
// listed path the sitemap lacks fails. The feature checks, one page of each kind, are unchanged.
const PATHS = process.env.SMOKE_PATHS_FILE
  ? new Set(fs.readFileSync(process.env.SMOKE_PATHS_FILE, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\//, '')))
  : null;

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
      // A live host can answer a page deployed seconds ago with its own 404 page (run 44733721568:
      // GitHub's 404 for /mood/positive/ failed axe on lang, alt and link names). Not this site's
      // page, so it is loaded again after the host's pauses; a page still not served fails as such.
      let response = await page.goto(at(rel), { waitUntil: 'load' });
      for (let attempt = 0; !root && response && response.status() !== 200 && attempt < HOST_PAUSES_MS.length; attempt++) {
        await new Promise((r) => setTimeout(r, HOST_PAUSES_MS[attempt]));
        response = await page.goto(at(rel), { waitUntil: 'load' });
      }
      if (!response || response.status() !== 200) {
        found.push(`${scheme} /${rel}: HTTP ${response ? response.status() : 'no response'}, not checked`);
        await page.close();
        continue;
      }
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

// Coverage of the site's own scripts (rule project.new-code-tested): with SMOKE_COVERAGE=<file>
// every page the feature checks open records V8's block coverage from its first byte (the page is
// instrumented before it navigates), each page's painting is merged per script when its context
// closes, and the lines that ran and never ran are written for scripts/coverage.mjs. The sitemap
// sweep is not recorded: it repeats the same code on every page and only costs time.
const COVERAGE = process.env.SMOKE_COVERAGE || '';
let recording = !!COVERAGE;
const painted = new Map(); // static/js/<name>.js -> { source, state }
const instrumented = new Set();
async function collect(page) {
  if (!instrumented.has(page)) return;
  instrumented.delete(page);
  let entries = [];
  try { entries = await page.coverage.stopJSCoverage(); } catch (e) { return; } // a page already gone
  absorb(entries);
}
// Chrome drops a document's script coverage when the page loads another document, so the
// coverage is taken before every navigation the test asks for, and recording starts again.
async function snapshot(page) {
  if (!instrumented.has(page)) return;
  try {
    absorb(await page.coverage.stopJSCoverage());
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  } catch (e) { instrumented.delete(page); }
}
function absorb(entries) {
  for (const entry of entries) {
    // Only the site's own scripts, served under its base: a /js/<name>.js of any other origin
    // would be counted as the site's (a review, 2026-11-22).
    const url = entry.url || '';
    const m = /^js\/([a-z0-9-]+\.js)(?:\?|$)/.exec(url.startsWith(at('')) ? url.slice(at('').length) : '');
    if (!m || !entry.source) continue;
    const file = `static/js/${m[1]}`;
    const state = v8lines.paint(entry.source, entry.functions);
    const was = painted.get(file);
    if (!was) painted.set(file, { source: entry.source, state });
    else if (was.source === entry.source) v8lines.merge(was.state, state);
    else check(false, `coverage: ${file} was served with two different sources; the reading would be wrong`);
  }
}
function instrument(browser) {
  if (!COVERAGE) return;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      // A context with JavaScript off (the no-JS checks) has nothing to record.
      if (recording && args[0] && args[0].javaScriptEnabled !== false) {
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        instrumented.add(page);
        for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
          const go = page[name].bind(page);
          page[name] = async (...a) => { await snapshot(page); return go(...a); };
        }
      }
      return page;
    };
    const close = context.close.bind(context);
    context.close = async (...a) => {
      for (const page of context.pages()) await collect(page);
      return close(...a);
    };
    return context;
  };
}
async function writeCoverage() {
  if (!COVERAGE) return;
  for (const page of [...instrumented]) await collect(page);
  const out = {};
  for (const [file, { source, state }] of painted) out[file] = v8lines.lines(source, state);
  fs.writeFileSync(COVERAGE, JSON.stringify(out));
  console.log(`coverage: ${painted.size} script(s) recorded -> ${COVERAGE}`);
}

async function done(browser) {
  await writeCoverage();
  await browser.close();
  for (const n of notices) console.log(`note ${n}`);
  console.log(failures.length ? `smoke: ${failures.length} failure(s)` : 'smoke: all checks passed');
  process.exit(failures.length ? 1 : 0);
}

async function sweep(browser) {
  recording = false;
  let all = await sitemap();
  if (PATHS) {
    const rels = new Set(all.map((loc) => (loc.startsWith(base) ? loc.slice(base.length) : loc)));
    const unknown = [...PATHS].filter((rel) => !rels.has(rel));
    check(unknown.length === 0, `sweep: every path of SMOKE_PATHS_FILE is a sitemap page` +
      (unknown.length ? ` (not: /${unknown.slice(0, 10).join(', /')})` : ''));
    const total = all.length;
    all = all.filter((loc) => PATHS.has(loc.startsWith(base) ? loc.slice(base.length) : loc));
    console.log(`sweep: ${all.length} of ${total} sitemap pages, those listed in SMOKE_PATHS_FILE`);
  }
  const urls = all.filter((_, i) => i % SHARD.n === SHARD.k - 1);
  const part = SHARD.n > 1 ? `shard ${SHARD.k}/${SHARD.n}: ${urls.length} of ${all.length}` : `${urls.length}`;
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
    `sweep: ${part} sitemap pages (${SWEEP_WORKERS} at a time), every one free of console errors, warnings and failed requests` +
    (failed.length ? `\n     ${failed.slice(0, 20).join('\n     ')}` : ''));
}

// How much of a canvas is lit: the share of a 64x36 sample brighter than near-black. A picture
// that draws nothing (a mode that throws, p5 never loaded) is 0.
function litShare(selector) {
  const c = document.querySelector(selector);
  if (!c) return -1;
  const g = document.createElement('canvas');
  g.width = 64;
  g.height = 36;
  const x = g.getContext('2d');
  x.drawImage(c, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  return lit / (64 * 36);
}

// The visualiser's cluster (settings, full screen, close) is on top of everything at its own
// centre; the open queue used to lie over Close on phones and at 1280x720 (a review, 2026-11-15).
// The visualiser's controls fade while the pointer rests and let clicks through; a pointer move
// shows them, as it does for a reader, before a test clicks one.
async function showViz(page) {
  await page.mouse.move(31, 31);
  await page.mouse.move(40, 40);
  await page.waitForFunction(() => document.getElementById('visualizer-full').getAttribute('data-controls') === 'shown', null, { timeout: 3000 }).catch(() => {});
}

async function vizControlsOnTop(page, what) {
  // The cluster shows on a pointer move (it fades, and lets clicks through, while the pointer rests).
  await page.mouse.move(40, 40);
  await page.mouse.move(48, 44);
  await page.waitForFunction(() => document.getElementById('visualizer-full').getAttribute('data-controls') === 'shown');
  const covered = await page.evaluate(() => [...document.querySelectorAll('#visualizer-full [data-viz-settings], #visualizer-full [data-viz-fullscreen], #visualizer-full [data-viz-close]')]
    .map((b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return e && b.contains(e) ? null : (e ? e.id || e.tagName.toLowerCase() : 'nothing'); }).filter(Boolean));
  check(covered.length === 0, `${what}: the visualiser's controls are on top${covered.length ? ' (under ' + [...new Set(covered)].join(', ') + ')' : ''}`);
}

// YouTube's terms: the playing video is never hidden. A 5x5 grid over its box, edges included
// (3 % in), must each hit the video itself, not a panel, sheet, backdrop or toast stacked over
// it, and the box must be on screen; a covered video passed every earlier check because they
// compared boxes of two panels, not what is on top (2026-11-15: the open queue covered the
// default small video on every desktop; then a review found a 3 % strip the corners missed).
async function videoSeen(page, what) {
  const hits = await page.evaluate(() => {
    // The video's own box: in cinema the panel fills the screen and only its child is the video.
    const panel = document.getElementById('player-panel');
    const r = (panel.firstElementChild || panel).getBoundingClientRect();
    if (r.width < 100 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) {
      return [`off screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`];
    }
    const at = [0.03, 0.25, 0.5, 0.75, 0.97];
    const out = [];
    for (const x of at) for (const y of at) {
      const e = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
      if (!(e && panel.contains(e))) out.push(e ? e.id || e.tagName.toLowerCase() : 'nothing');
    }
    return out;
  });
  check(hits.length === 0, `${what}: the playing video is not covered${hits.length ? ' (under ' + [...new Set(hits)].join(', ') + ')' : ''}`);
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

  // SwiftShader stands in for a GPU where there is none (CI), so the visualiser's WebGL modes
  // are tested on their own engine rather than on their p5 fallbacks; Chrome asks for this flag
  // since it stopped falling back to SwiftShader by itself.
  // A fake microphone (a beeping tone) and auto-accepted permission prompts let the visualiser's
  // "Follow the music" run its real listening path and analysis.
  const launch = { headless: true, args: ['--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] };
  // On a Mac, WebGL on Metal, as Chrome itself runs it (headless defaults to ANGLE on OpenGL).
  if (process.platform === 'darwin') launch.args.push('--use-angle=metal');
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launch);
  instrument(browser);
  const desktop = { width: 1440, height: 900 };
  const phone = { width: 390, height: 844 };
  if (SWEEP_ONLY) {
    await sweep(browser);
    return done(browser);
  }

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

  // The landing hero: the visualiser draws behind it, the mosaic turns a tile within a few
  // seconds while nobody points at it, and "Play the newest" still names the nine newest.
  {
    const { context, page, errors } = await open(browser, at(''), desktop);
    const tiles = () => page.evaluate(() => [...document.querySelectorAll('#hero-mosaic > [data-track]')].map((t) => t.dataset.source).join(','));
    const before = await tiles();
    await page.waitForFunction(() => Number(document.querySelector('#main [data-visualizer]')?.getAttribute('data-visualizer-frame') || 0) > 30, null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(litShare, '#main [data-visualizer] canvas') > 0, 'hero: the visualiser draws behind the hero');
    await page.waitForFunction((b) => [...document.querySelectorAll('#hero-mosaic > [data-track]')].map((t) => t.dataset.source).join(',') !== b, before, { timeout: 12000 }).catch(() => {});
    check(await tiles() !== before, 'hero: the mosaic turns a tile while nobody points at it');
    const newest = catalog.tracks.filter((t) => t.youtube).slice(0, 9).map((t) => t.source).join(',');
    check(await page.evaluate(() => [...document.querySelectorAll('#hero-newest [data-track]')].map((t) => t.dataset.source).join(',')) === newest,
      'hero: "Play the newest" plays the nine newest, whatever the mosaic shows');
    check(errors.length === 0, `hero: no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // Reduced motion: the hero draws nothing, and the full-screen picture is a calm mode that does
  // not change by itself (it used to run Warp at full pace with the 40 s cycle on).
  {
    const { context, page } = await open(browser, at(''), desktop, 'light', { reducedMotion: 'reduce' });
    await page.waitForTimeout(2000);
    check(await page.evaluate(() => !document.querySelector('#main [data-visualizer] canvas')), 'visualiser (reduced motion): the hero draws nothing');
    await page.evaluate(() => window.SonicVisualizer.open());
    check(await page.evaluate(() => window.SonicVisualizer.mode() === 'veil' && !document.querySelector('#visualizer-full [data-viz-cycle]').checked),
      'visualiser (reduced motion): a calm mode that does not change by itself');
    await context.close();
  }
  // A shared link (everything in the URL): the song cued at its time, paused, with no request to
  // YouTube until play is pressed; the picture, its live control and cinema as the sender had
  // them; the old mode names still open their successors.
  {
    const t = catalog.tracks.find((x) => x.youtube && !x.video_gone);
    const key = t.source.replace(/\.md$/, '');
    const { context, page, errors } = await open(browser, at(`?play=${key}&t=42&viz=prism&viz.warp=1.5&viz.video=cinema`), phone, 'light', {}, true);
    await page.waitForFunction(() => window.SonicPlayer && window.SonicPlayer.state().index >= 0, null, { timeout: 10000 }).catch(() => {});
    const st = await page.evaluate(() => ({ s: window.SonicPlayer.state(), mode: window.SonicVisualizer.mode(),
      params: window.SonicVisualizer.params(), cinema: window.SonicVisualizer.cinema(), calls: window.__yt ? window.__yt.calls.length : 0, api: !!window.YT,
      toast: document.querySelector('[data-player-toast-text]').textContent }));
    const now = st.s.queue[st.s.index] || {};
    check(now.source === t.source && Math.round(st.s.time) === 42 && !(await page.isHidden('#player')),
      `shared link: the song is cued at its time (${now.source} at ${st.s.time})`);
    check(st.calls === 0 && !st.api && st.toast.length > 0, 'shared link: paused, the YouTube API not even loaded, and the toast says so');
    check(st.mode === 'prism' && st.params && st.params.warp === 1.5 && st.cinema === true, 'shared link: the picture, its live control and cinema');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => document.querySelector('#visualizer-full [data-visualizer-engine]').getAttribute('data-visualizer-engine') !== 'gl'
      || /^hsl\(\d+ 85% 62% \/ 0\.55\)$/.test(document.getElementById('player-panel').style.getPropertyValue('--viz-glow'))),
    'shared link: a WebGL picture glows in its hue, no frame read back from the GPU');
    // A p5 picture draws in 2D: its glow is the colour of its own pixels.
    await page.evaluate(() => window.SonicVisualizer.set('kaleido'));
    await page.waitForFunction(() => document.querySelector('#visualizer-full [data-visualizer-engine]').getAttribute('data-visualizer-engine') === 'p5'
      && /^rgb\(\d+ \d+ \d+ \/ 0\.55\)$/.test(document.getElementById('player-panel').style.getPropertyValue('--viz-glow')), null, { timeout: 10000 }).catch(() => {});
    check(await page.evaluate(() => /^rgb\(\d+ \d+ \d+ \/ 0\.55\)$/.test(document.getElementById('player-panel').style.getPropertyValue('--viz-glow'))),
      'shared link: a 2D (p5) picture glows in the colour of its own pixels');
    check(new URL(page.url()).searchParams.get('play') === key && new URL(page.url()).searchParams.get('t') === '42',
      'shared link: the URL keeps naming the song and its time');
    await page.click('#player [data-player-toggle]');
    await page.waitForFunction(() => !!document.querySelector('iframe#player-video'), null, { timeout: 10000 }).catch(() => {});
    check(await page.evaluate(() => /[?&]start=42\b/.test((document.querySelector('iframe#player-video') || {}).src || '')),
      'shared link: play starts the song at the shared time');
    await page.waitForTimeout(400);
    await videoSeen(page, 'visualiser (cinema, phone, shared link)');
    await page.evaluate(() => window.SonicVisualizer.set('tunnel'));
    check(await page.evaluate(() => window.SonicVisualizer.mode() === 'liquid'), 'visualiser: an old mode name (?viz=tunnel) opens its successor');
    check(errors.length === 0, `shared link: no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The rest of an independent review's findings (2026-11-22), each checked end to end on a phone.
  {
    const t = catalog.tracks.find((x) => x.youtube && !x.video_gone);
    const key = t.source.replace(/\.md$/, '');
    const { context, page, errors } = await open(browser, at(''), phone, 'light', {}, true);
    // A shared link shows the sender's picture: the mode's defaults and the link's controls, not
    // the reader's saved values or the reader's cinema; and h:m:s times are understood.
    await page.evaluate(() => localStorage.setItem('sonic.visualizer', JSON.stringify({ cinema: true, params: { prism: { warp: 1.9, hue: 200 } } })));
    await page.goto(at(`?play=${key}&t=1:02:03&viz=prism&viz.hue=40`), { waitUntil: 'load' });
    await page.waitForFunction(() => window.SonicVisualizer && window.SonicVisualizer.mode() === 'prism' && window.SonicPlayer.state().index >= 0, null, { timeout: 10000 }).catch(() => {});
    const st = await page.evaluate(() => ({ p: window.SonicVisualizer.params(), cinema: window.SonicVisualizer.cinema(), time: window.SonicPlayer.state().time }));
    check(st.p && st.p.hue === 40 && st.p.warp === 1 && st.cinema === false, `shared link: the sender's picture, not the reader's saved one (${JSON.stringify(st)})`);
    check(Math.round(st.time) === 3723, `shared link: t=1:02:03 is 3723 s (${st.time})`);
    check(!new URL(page.url()).searchParams.has('viz.warp') && !new URL(page.url()).searchParams.has('viz.video'),
      'shared link: the URL keeps exactly the sender\'s controls');
    // The toast keeps below the visualiser's controls on a phone.
    await page.evaluate(() => window.SonicPlayer.notify('A toast over the picture'));
    await page.waitForTimeout(100);
    check(await page.evaluate(() => {
      const toast = document.getElementById('player-toast').getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-viz-cluster] > :not(#visualizer-settings)')].map((r) => r.getBoundingClientRect().bottom);
      return toast.top >= Math.max(...rows);
    }), 'visualiser (phone): the toast keeps below the visualiser\'s controls');
    // Cinema with the settings open on a phone: the video returns to its corner and the sheet
    // ends above it. Play first, so there is a video to measure.
    await page.click('#player [data-player-toggle]');
    await page.waitForFunction(() => !!document.querySelector('iframe#player-video') && !document.getElementById('player-panel').hidden, null, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.SonicVisualizer.cinema(true));
    await page.mouse.move(30, 30);
    await showViz(page); await page.click('#visualizer-full [data-viz-settings]');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => {
      const v = document.querySelector('#player-panel > div').getBoundingClientRect();
      const s = document.getElementById('visualizer-settings').getBoundingClientRect();
      return v.width > 0 && (s.right <= v.left || s.left >= v.right || s.bottom <= v.top || s.top >= v.bottom);
    }), 'visualiser (cinema, phone, settings open): the sheet and the video do not overlap');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // A loose video in Czech: the toast and the bar are in Czech, never a key, and no key is
    // saved; 1m5s is 65 s.
    await page.goto(at(`cs/?play=yt:${t.youtube}&t=1m5s`), { waitUntil: 'load' });
    await page.waitForFunction(() => window.SonicPlayer.state().index >= 0 && document.querySelector('[data-player-toast-text]').textContent, null, { timeout: 10000 }).catch(() => {});
    const yt = await page.evaluate(() => ({ toast: document.querySelector('[data-player-toast-text]').textContent,
      title: document.querySelector('[data-player-title]').textContent, s: window.SonicPlayer.state(),
      saved: JSON.parse(localStorage.getItem('sonic-player') || '{}') }));
    const loose = yt.s.queue[yt.s.index] || {};
    check(yt.toast && !/^player\./.test(yt.toast) && yt.title && !/^player\./.test(yt.title),
      `shared link (cs, loose video): the toast and the bar are words, not keys ("${yt.toast}", "${yt.title}")`);
    check(loose.youtube === t.youtube && Math.round(yt.s.time) === 65 && (yt.saved.queue || []).every((q) => !/^player\./.test(q.track || '')),
      'shared link (cs, loose video): cued at 1m5s, and no interface key is saved');
    check(errors.length === 0, `review findings (phone): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The interface strings fail to load: a shared link is still cued (quietly, no raw key in a
  // toast), and the URL follows the next song instead of freezing on the shared one.
  {
    const S0 = catalog.tracks.find((x) => x.youtube && !x.video_gone);
    const S1 = catalog.tracks.find((x) => x.youtube && !x.video_gone && x.source !== S0.source);
    const { context, page } = await open(browser, at('404.html'), desktop, 'light', {}, true);
    await context.route('**/data/i18n.json*', (route) => route.fulfill({ status: 503, body: 'down' }));
    await page.goto(at(`?play=${S0.source.replace(/\.md$/, '')}&t=30`), { waitUntil: 'load' });
    await page.waitForFunction(() => window.SonicPlayer.state().index >= 0, null, { timeout: 10000 }).catch(() => {});
    const cued = await page.evaluate(() => ({ s: window.SonicPlayer.state(), toast: document.querySelector('[data-player-toast-text]').textContent }));
    check((cued.s.queue[cued.s.index] || {}).source === S0.source && !/^player\./.test(cued.toast),
      'shared link (strings failed): the song is cued, and no key is shown');
    await page.evaluate((src) => Sonic.playIndex().then((c) => window.SonicPlayer.playNow(c.tracks.find((t) => t.source === src))), S1.source);
    await page.waitForFunction((k) => new URL(location.href).searchParams.get('play') === k, S1.source.replace(/\.md$/, ''), { timeout: 10000 }).catch(() => {});
    check(new URL(page.url()).searchParams.get('play') === S1.source.replace(/\.md$/, ''), 'shared link (strings failed): the URL follows the next song');
    await context.close();
  }
  // An anchor on the page on screen that is already in the URL scrolls to its target again, as
  // the browser does (the skip link used twice), and the player's keys stay in the URL.
  {
    const { context, page } = await open(browser, at(''), desktop);
    await page.evaluate(() => {
      const main = document.getElementById('main-content');
      const target = document.createElement('div');
      target.id = 'anchor-probe-target';
      target.style.marginTop = '4000px';
      target.textContent = 'target';
      main.append(target);
      const a = document.createElement('a');
      a.href = '#anchor-probe-target';
      a.id = 'anchor-probe';
      a.textContent = 'to the target';
      main.prepend(a);
      history.replaceState(history.state, '', location.pathname + '?play=probe-song');
    });
    const near = () => page.evaluate(() => { const r = document.getElementById('anchor-probe-target').getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight; });
    await page.click('#anchor-probe');
    await page.waitForTimeout(300);
    check(await near() && new URL(page.url()).hash === '#anchor-probe-target' && new URL(page.url()).searchParams.get('play') === 'probe-song',
      'router: an anchor on the page scrolls there and keeps the player\'s keys');
    await page.evaluate(() => { window.scrollTo(0, 0); const m = document.getElementById('main-content'); if (m) m.scrollTop = 0; });
    await page.evaluate(() => document.getElementById('anchor-probe').click());
    await page.waitForTimeout(300);
    check(await near() && await page.evaluate(() => document.activeElement && document.activeElement.id === 'anchor-probe-target'),
      'router: the same anchor again scrolls there again and moves focus');
    await context.close();
  }
  // The 40 s change, on Playwright's clock rather than a 40 s wait: the picture moves on to the
  // next mode by itself, and the URL follows.
  {
    const { context, page } = await open(browser, at('404.html'), desktop);
    await page.clock.install();
    await page.goto(at('?viz=veil'), { waitUntil: 'load' });
    await page.waitForFunction(() => Number(document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-frame') || 0) > 3, null, { timeout: 15000 }).catch(() => {});
    const before = await page.evaluate(() => window.SonicVisualizer.mode());
    await page.clock.fastForward(41000);
    await page.waitForFunction((m) => window.SonicVisualizer.mode() !== m, before, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => ({ mode: window.SonicVisualizer.mode(), modes: window.SonicVisualizer.modes() }));
    check(before === 'veil' && after.mode === after.modes[(after.modes.indexOf('veil') + 1) % after.modes.length]
      && new URL(page.url()).searchParams.get('viz') === after.mode,
      `visualiser: after 40 s the picture moves on to the next mode by itself (${before} -> ${after.mode})`);
    await context.close();
  }
  // A shared link that resolves after play was pressed queues its song next and never swaps it
  // under the playing video.
  {
    const S0 = catalog.tracks.find((x) => x.youtube && !x.video_gone);
    const S1 = catalog.tracks.find((x) => x.youtube && !x.video_gone && x.source !== S0.source);
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'light', {}, true);
    await page.evaluate((q) => localStorage.setItem('sonic-player', JSON.stringify({ queue: [q], index: 0, time: 0 })),
      { source: S0.source, path: S0.path, i18n: {}, artist: S0.artist, track: S0.track, youtube: S0.youtube, thumbnail: '' });
    await context.route('**/data/play.json*', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    await page.goto(at(`?play=${S1.source.replace(/\.md$/, '')}&t=30`), { waitUntil: 'load' });
    await page.click('#player [data-player-toggle]');
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length === 2, null, { timeout: 15000 }).catch(() => {});
    const r = await page.evaluate(() => window.SonicPlayer.state());
    check(r.index === 0 && r.queue[0].source === S0.source && r.queue[1] && r.queue[1].source === S1.source,
      `shared link after play: the shared song is queued next, the playing one stays (${r.queue.map((q) => q.source).join(', ')} at ${r.index})`);
    check(errors.length === 0, `shared link after play: no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // "Follow the music" listens for real (Chrome's fake microphone, a beeping tone). The tab is
  // asked first on a Chromium computer; a shared tab without its audio (here a video-only stream,
  // deterministic where headless Chrome would otherwise pick a source itself) falls back to the
  // microphone. The analysis follows the sound, the button steps aside, "Don't listen" returns to
  // the clock. A refused microphone is said beside the buttons.
  {
    const { context, page, errors } = await open(browser, at('404.html'), phone, 'dark');
    await context.grantPermissions(['microphone', 'camera']);
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (md) md.getDisplayMedia = () => md.getUserMedia({ video: true });
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await page.mouse.move(30, 30);
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    // Two devices start in turn (the fake camera behind the silent tab, then the microphone):
    // on a loaded machine that took over 10 s, so the wait is long and bounded.
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => window.SonicVisualizer.analysis().level > 0.01, null, { timeout: 10000 }).catch(() => {});
    const a = await page.evaluate(() => window.SonicVisualizer.analysis());
    check(a.source === 'mic' && a.level > 0.01, `visualiser: "Follow the music" falls back from a silent tab to the microphone and follows it (${a.source}, level ${a.level.toFixed(3)})`);
    check(await page.isHidden('#visualizer-full [data-viz-source="connect"]'), 'visualiser: listening, "Follow the music" steps aside');
    await page.waitForTimeout(1500);
    // The controls fade while the pointer rests; a move shows them, as it does for a reader.
    await page.mouse.move(31, 31);
    await page.mouse.move(40, 40);
    await showViz(page); await page.click('#visualizer-full [data-viz-settings]');
    await page.click('#visualizer-full [data-viz-source="clock"]');
    check(await page.evaluate(() => window.SonicVisualizer.source()) === 'clock', 'visualiser: "Don\'t listen" returns to the clock');
    check(errors.length === 0, `visualiser (microphone): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  {
    const { context, page } = await open(browser, at('404.html'), phone);
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      md.getDisplayMedia = undefined; // a browser that cannot share a tab: the microphone is asked
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await page.mouse.move(30, 30);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => document.querySelector('#visualizer-full [data-viz-status]').getAttribute('data-i18n') === 'viz.denied', null, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate(() => document.querySelector('#visualizer-full [data-viz-status]').getAttribute('data-i18n') === 'viz.denied'
      && window.SonicVisualizer.source() === 'clock'), 'visualiser: a refused microphone is said, and the picture stays on the clock');
    await context.close();
  }
  // The sound straight from the computer, with no microphone on: a loopback device (here a fake
  // "BlackHole 2ch" beside a fake microphone, both WebAudio streams; getUserMedia records what it
  // is asked; a third is unplugged before it is chosen) is listed first with its badge, starts when it is chosen (its exact deviceId, every
  // processing flag off), is remembered, and starts again after a reload with the reader's first
  // click while the browser reports the microphone allowed. The whole computer (systemAudio), this
  // tab and the microphone are asked as they should be, and each says what it hears. A plain
  // microphone chosen as a device never starts by itself; with the permission not yet given
  // nothing starts, the browser names no device, and the hint on a loopback device is shown.
  // Nothing is ever asked on load.
  {
    const inputs = (context, perm, labels) => context.addInitScript(([perm, labels]) => {
      const md = navigator.mediaDevices;
      if (!md) return;
      const w = /** @type {any} */ (window);
      w.__asked = [];
      const list = [
        { deviceId: 'default', kind: 'audioinput', label: 'Default - MacBook Pro Microphone', groupId: 'g1' },
        { deviceId: 'mic-1', kind: 'audioinput', label: 'MacBook Pro Microphone', groupId: 'g1' },
        { deviceId: 'bh-2ch', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'g2' },
        { deviceId: 'usb-9', kind: 'audioinput', label: 'USB Audio CODEC', groupId: 'g3' },
        { deviceId: 'spk-1', kind: 'audiooutput', label: 'MacBook Pro Speakers', groupId: 'g1' },
      ];
      // Without the permission the browser lists its inputs without ids or labels.
      md.enumerateDevices = async () => list.map((d) => (labels ? { ...d } : { ...d, deviceId: '', label: '' }));
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (d) => (d && d.name === 'microphone' ? Promise.resolve(/** @type {any} */ ({ state: perm })) : query(d));
      const sound = async (label) => {
        const ac = new AudioContext();
        await ac.resume();
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 110;
        const out = ac.createMediaStreamDestination();
        osc.connect(out);
        osc.start();
        Object.defineProperty(out.stream.getAudioTracks()[0], 'label', { value: label });
        return out.stream;
      };
      md.getUserMedia = async (c) => {
        w.__asked.push({ how: 'user', c: JSON.parse(JSON.stringify(c)) });
        // Unplugged between the list and the click.
        if (c.audio && c.audio.deviceId && c.audio.deviceId.exact === 'usb-9') throw new DOMException('gone', 'OverconstrainedError');
        return sound(c.audio && c.audio.deviceId ? '' : 'MacBook Pro Microphone');
      };
      md.getDisplayMedia = async (c) => {
        w.__asked.push({ how: 'display', c: JSON.parse(JSON.stringify(c)) });
        return sound('');
      };
    }, [perm, labels]);
    const asked = (page) => page.evaluate(() => /** @type {any} */ (window).__asked);
    const raw = (a) => a.echoCancellation === false && a.noiseSuppression === false && a.autoGainControl === false;
    const status = (page) => page.evaluate(() => {
      const el = document.querySelector('#visualizer-full [data-viz-status]');
      return { key: el.getAttribute('data-i18n'), text: el.textContent };
    });
    const sheet = async (page) => {
      await showViz(page);
      if (await page.isHidden('#visualizer-settings')) await page.click('#visualizer-full [data-viz-settings]');
    };
    const heard = (page, source) => page.waitForFunction((s) => window.SonicVisualizer.source() === s
      && window.SonicVisualizer.analysis().level > 0, source, { timeout: 15000 }).catch(() => {});

    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await inputs(context, 'granted', true);
    await page.goto(at(''), { waitUntil: 'load' });
    check((await asked(page)).length === 0, 'visualiser sources: nothing is asked on load');
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await sheet(page);
    await page.waitForFunction(() => document.querySelectorAll('#visualizer-full [data-viz-device]').length === 3, null, { timeout: 5000 }).catch(() => {});
    const listed = await page.evaluate(() => ({
      chips: Array.from(document.querySelectorAll('#visualizer-full [data-viz-device]')).map((b) => ({
        id: b.getAttribute('data-viz-device'), label: b.querySelector('[data-viz-device-label]').textContent,
        badge: !b.querySelector('[data-viz-device-badge]').hidden })),
      hint: document.querySelector('#visualizer-full [data-viz-loopback-hint]').hidden,
      system: document.querySelector('#visualizer-full [data-viz-source="system"]').hidden,
    }));
    check(listed.chips.length === 3 && listed.chips[0].id === 'bh-2ch' && listed.chips[0].badge
      && listed.chips[1].id === 'mic-1' && !listed.chips[1].badge && listed.chips[2].id === 'usb-9'
      && listed.hint && !listed.system,
      `visualiser sources: the inputs are listed, the loopback first with its badge, no alias; the whole computer is offered (${JSON.stringify(listed)})`);
    await page.click('#visualizer-full [data-viz-device="bh-2ch"]');
    await heard(page, 'device');
    let ask = (await asked(page)).pop();
    let said = await status(page);
    check(ask && ask.how === 'user' && ask.c.audio.deviceId.exact === 'bh-2ch' && raw(ask.c.audio)
      && await page.evaluate(() => window.SonicVisualizer.analysis().level > 0),
      `visualiser sources: the chosen loopback device is asked by its exact id, every processing flag off, and heard (${JSON.stringify(ask)})`);
    check(said.key === 'viz.status_device' && said.text.includes('BlackHole 2ch')
      && await page.getAttribute('#visualizer-full [data-viz-device="bh-2ch"]', 'aria-checked') === 'true',
      `visualiser sources: the status names the device heard ("${said.text}")`);
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer')).device) === 'bh-2ch',
      'visualiser sources: the chosen device is remembered');

    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    check((await asked(page)).length === 0 && await page.evaluate(() => window.SonicVisualizer.source()) === 'clock',
      'visualiser sources: after a reload nothing is asked before the reader acts');
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await page.click('#visualizer-full [data-visualizer-stage]');
    await heard(page, 'device');
    ask = (await asked(page))[0];
    check(ask && ask.c.audio.deviceId.exact === 'bh-2ch' && await page.evaluate(() => window.SonicVisualizer.source()) === 'device',
      `visualiser sources: the remembered loopback starts again by itself, without a prompt (${JSON.stringify(ask)})`);

    await sheet(page);
    await page.click('#visualizer-full [data-viz-source="system"]');
    await heard(page, 'system');
    ask = (await asked(page)).pop();
    said = await status(page);
    check(ask && ask.how === 'display' && ask.c.systemAudio === 'include' && ask.c.video.displaySurface === 'monitor'
      && raw(ask.c.audio) && said.key === 'viz.status_system'
      && await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer')).device) === '',
      `visualiser sources: the whole computer is asked with its sound, said, and replaces the remembered device (${JSON.stringify(ask)})`);
    await sheet(page);
    await page.click('#visualizer-full [data-viz-source="tab"]');
    await heard(page, 'tab');
    ask = (await asked(page)).pop();
    check(ask && ask.how === 'display' && ask.c.preferCurrentTab === true && (await status(page)).key === 'viz.status_tab',
      `visualiser sources: this tab is asked and said (${JSON.stringify(ask)})`);
    await sheet(page);
    await page.click('#visualizer-full [data-viz-source="mic"]');
    await heard(page, 'mic');
    ask = (await asked(page)).pop();
    said = await status(page);
    check(ask && ask.how === 'user' && !ask.c.audio.deviceId && raw(ask.c.audio)
      && said.key === 'viz.status_mic_named' && said.text.includes('MacBook Pro Microphone'),
      `visualiser sources: the microphone is asked only when picked, raw, and named ("${said.text}")`);
    // A plain microphone chosen as a device is remembered but never starts by itself.
    await sheet(page);
    await page.click('#visualizer-full [data-viz-device="mic-1"]');
    await page.waitForFunction(() => /** @type {any} */ (window).__asked.length === 5, null, { timeout: 5000 }).catch(() => {});
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await page.click('#visualizer-full [data-visualizer-stage]');
    await sheet(page);
    // The arrows move between the devices without starting one.
    await page.waitForSelector('#visualizer-full [data-viz-device="bh-2ch"]', { timeout: 5000 }).catch(() => {});
    await page.focus('#visualizer-full [data-viz-device="bh-2ch"]');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer')).device) === 'mic-1'
      && (await asked(page)).length === 0 && await page.evaluate(() => window.SonicVisualizer.source()) === 'clock'
      && await page.evaluate(() => document.activeElement.getAttribute('data-viz-device')) === 'mic-1',
      'visualiser sources: a remembered plain microphone never starts by itself, nor does an arrow key');
    await page.click('#visualizer-full [data-viz-device="usb-9"]');
    await page.waitForFunction(() => document.querySelector('#visualizer-full [data-viz-status]').getAttribute('data-i18n') === 'viz.denied', null, { timeout: 5000 }).catch(() => {});
    check((await status(page)).key === 'viz.denied' && await page.evaluate(() => window.SonicVisualizer.source()) === 'clock'
      && await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer')).device) === 'mic-1',
      'visualiser sources: a device that cannot start is said beside the buttons, and not remembered');
    check(errors.length === 0, `visualiser sources: no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();

    // Not yet allowed: the browser names no device, nothing starts, the hint is shown.
    const second = await open(browser, at('404.html'), desktop);
    await inputs(second.context, 'prompt', false);
    await second.page.goto(at(''), { waitUntil: 'load' });
    await second.page.evaluate(() => localStorage.setItem('sonic.visualizer', JSON.stringify({ device: 'bh-2ch' })));
    await second.page.reload({ waitUntil: 'load' });
    await second.page.evaluate(() => window.SonicVisualizer.open('tower'));
    await second.page.click('#visualizer-full [data-visualizer-stage]');
    await sheet(second.page);
    await second.page.waitForTimeout(1500);
    const before = await second.page.evaluate(() => ({
      asked: /** @type {any} */ (window).__asked.length, source: window.SonicVisualizer.source(),
      box: document.querySelector('#visualizer-full [data-viz-devices-box]').hidden,
      hint: document.querySelector('#visualizer-full [data-viz-loopback-hint]').hidden,
    }));
    check(before.asked === 0 && before.source === 'clock' && before.box && !before.hint,
      `visualiser sources: without the permission a remembered loopback waits, no device is listed, the hint is shown (${JSON.stringify(before)})`);
    check(second.errors.length === 0, `visualiser sources (not allowed): no console error${second.errors.length ? ': ' + second.errors.join(' | ') : ''}`);
    await second.context.close();
  }
  // A GPU mode whose code cannot be loaded (offline, blocked) is drawn by its p5 fallback; when
  // the p5 code cannot be loaded either, the stage says so instead of drawing nothing silently.
  {
    const { context, page } = await open(browser, at('404.html'), desktop);
    await context.route('**/js/viz-gl.js*', (route) => route.abort());
    await page.goto(at('?viz=liquid'), { waitUntil: 'load' });
    await page.waitForFunction(() => window.SonicVisualizer.shown() === 'flux', null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => window.SonicVisualizer.shown()) === 'flux', 'visualiser: a GPU mode whose code cannot load is drawn by its fallback');
    await context.close();
  }
  {
    // A fresh context, so nothing of the p5 code is in any cache.
    const { context, page } = await open(browser, at('404.html'), desktop);
    await context.route('**/js/viz-2d.js*', (route) => route.abort());
    await page.goto(at('?viz=kaleido'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-error') === 'p5', null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-error')) === 'p5',
      'visualiser: when no picture code can load, the stage is marked, never silently blank');
    await context.close();
  }
  // The analysis follows the music, not a clock: a 55 Hz pulse every 0.5 s (120 bpm), made with
  // WebAudio and handed over as the microphone, gives kick onsets and a tempo of about 120.
  {
    const { context, page, errors } = await open(browser, at('404.html'), phone, 'dark');
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const osc = ac.createOscillator();
        osc.frequency.value = 55;
        const gain = ac.createGain();
        gain.gain.value = 0;
        const out = ac.createMediaStreamDestination();
        osc.connect(gain).connect(out);
        osc.start();
        const t0 = ac.currentTime + 0.1;
        for (let i = 0; i < 60; i++) {
          const t = t0 + i * 0.5;
          gain.gain.setValueAtTime(1, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
          gain.gain.setValueAtTime(0, t + 0.18);
        }
        return out.stream;
      };
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('ripple'));
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.analysis().bpm > 0, null, { timeout: 15000 }).catch(() => {});
    // The label beside the mode's name refreshes once a second.
    await page.waitForFunction(() => document.querySelector('#visualizer-full [data-viz-tempo]').textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
    const tempo = await page.evaluate(() => ({ a: window.SonicVisualizer.analysis(), label: document.querySelector('#visualizer-full [data-viz-tempo]').textContent }));
    check(tempo.a.source === 'mic' && tempo.a.bpm >= 110 && tempo.a.bpm <= 130 && /1[12]\d/.test(tempo.label),
      `visualiser: the analysis finds the tempo of the music (120 bpm pulse -> ${tempo.a.bpm} bpm, "${tempo.label}")`);
    check(errors.length === 0, `visualiser (tempo): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The analysis follows real music, not an isolated pulse in silence: a mastered mix at 124 bpm
  // (a sustained bass line, a chord pad and a wash of hiss under a kick on every beat, a snare on
  // two and four and a hat on the off-beats, through a compressor), then the same mix 18 dB
  // quieter (a quiet room, a low player volume). The kicks, snares and hats are found where they
  // were played, nothing is found where nothing was, the tempo is 124, and the bars jump on the
  // kick. The earlier analysis found 1 of 25 kicks of this mix and no tempo (2026-11-22).
  {
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const out = ac.createMediaStreamDestination();
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4; comp.knee.value = 10;
        comp.attack.value = 0.008; comp.release.value = 0.15;
        const master = ac.createGain();
        comp.connect(master).connect(out);
        const bus = ac.createGain();
        bus.gain.value = 0.4;
        bus.connect(comp);
        const tone = (type, hz, filter, cut, level) => {
          const o = ac.createOscillator(); o.type = type; o.frequency.value = hz;
          const f = ac.createBiquadFilter(); f.type = filter; f.frequency.value = cut;
          const g = ac.createGain(); g.gain.value = level;
          o.connect(f).connect(g).connect(bus); o.start();
        };
        tone('sawtooth', 55, 'lowpass', 220, 0.3);
        [220, 277.2, 329.6, 440].forEach((hz) => tone('sawtooth', hz, 'lowpass', 2400, 0.08));
        const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const d = noise.getChannelData(0);
        let seed = 7;
        for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = seed / 1073741823.5 - 1; }
        const hiss = (filter, hz, q, at, peak, len) => {
          const s = ac.createBufferSource(); s.buffer = noise;
          const f = ac.createBiquadFilter(); f.type = filter; f.frequency.value = hz; f.Q.value = q;
          const g = ac.createGain();
          if (at < 0) { s.loop = true; g.gain.value = peak; s.connect(f).connect(g).connect(bus); s.start(); return; }
          g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + 0.002);
          g.gain.exponentialRampToValueAtTime(0.001, at + len);
          s.connect(f).connect(g).connect(bus); s.start(at, (at * 7.3) % 0.5, len + 0.02);
        };
        hiss('highpass', 5000, 0.7, -1, 0.05);
        const period = 60 / 124;
        const t0 = ac.currentTime + 0.3;
        const offset = performance.now() / 1000 - ac.currentTime;
        const quiet = t0 + 8;
        master.gain.setValueAtTime(2.2, 0);
        master.gain.setValueAtTime(2.2 / 8, quiet);
        const truth = { kick: [], snare: [], hat: [], quiet: quiet + offset };
        for (let i = 0; i * period < 16; i++) {
          const t = t0 + i * period;
          const k = ac.createOscillator();
          k.frequency.setValueAtTime(150, t); k.frequency.exponentialRampToValueAtTime(45, t + 0.12);
          const kg = ac.createGain();
          kg.gain.setValueAtTime(0, t); kg.gain.linearRampToValueAtTime(1.2, t + 0.003);
          kg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          k.connect(kg).connect(bus); k.start(t); k.stop(t + 0.4);
          truth.kick.push(t + offset);
          if (i % 2) { hiss('bandpass', 1800, 0.7, t, 0.9, 0.18); truth.snare.push(t + offset); }
          hiss('highpass', 8000, 0.7, t + period / 2, 0.6, 0.05);
          truth.hat.push(t + period / 2 + offset);
        }
        window.__truth = truth;
        return out.stream;
      };
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 15000 }).catch(() => {});
    // Every frame's bass and every onset the analysis reports, in the page's clock.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__frames = [];
      w.__found = new Map();
      const tick = () => {
        const a = w.SonicVisualizer.analysis();
        w.__frames.push({ t: performance.now() / 1000, bass: a.bass, bpm: a.bpm });
        a.onsets.forEach((o) => w.__found.set(o.name + o.t, o));
        if (w.__frames.length < 4000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForFunction(() => window.__truth && performance.now() / 1000 > window.__truth.quiet + 7.5, null, { timeout: 30000 }).catch(() => {});
    const run = await page.evaluate(() => ({ frames: window.__frames || [], found: Array.from((window.__found || new Map()).values()), truth: window.__truth }));
    if (!run.truth || run.frames.length < 60) {
      check(false, `visualiser: a mastered mix: the analysis ran (${run.frames.length} frames, ${run.truth ? 'the mix played' : 'the mix never started'})`);
    } else {
    // The stream's own latency (two audio contexts and a frame, about 60 ms; more on a loaded
    // machine) is measured, not assumed: the median delay from each kick played to the nearest kick
    // found. An onset counts within 70 ms of where it was played plus that delay. The first two
    // seconds of each half let the automatic gain and the thresholds settle.
    const halves = [[run.truth.kick[0] + 2, run.truth.quiet], [run.truth.quiet + 2, run.truth.quiet + 7]];
    const delays = run.truth.kick.map((t) => run.found.filter((o) => o.name === 'kick' && o.t - t > -0.05 && o.t - t < 0.3)
      .map((o) => o.t - t).sort((x, y) => Math.abs(x - 0.06) - Math.abs(y - 0.06))[0]).filter((x) => x !== undefined).sort((x, y) => x - y);
    const lag = delays.length ? delays[delays.length >> 1] : 0.06;
    const near = (x, t) => Math.abs(x - t - lag) < 0.07;
    // A snare's noise reaches the hats' range too: an onset there on a snare is no stray.
    const heard = { kick: run.truth.kick, snare: run.truth.snare, hat: run.truth.hat.concat(run.truth.snare) };
    const score = (name, [from, to]) => {
      const played = run.truth[name].filter((t) => t > from && t < to - 0.2);
      const found = run.found.filter((o) => o.name === name && o.t > from && o.t < to).map((o) => o.t);
      const hit = played.filter((t) => found.some((x) => near(x, t))).length;
      const stray = found.filter((x) => !heard[name].some((t) => near(x, t))).length;
      return { hit, played: played.length, stray };
    };
    // The frame rate of each half, and its longest frame: a starved browser misses onsets.
    const pace = ([from, to]) => {
      const ts = run.frames.map((f) => f.t).filter((t) => t > from && t < to);
      const gap = ts.slice(1).reduce((m, t, i) => Math.max(m, t - ts[i]), 0);
      return `${Math.round(ts.length / (to - from))} fps, longest frame ${Math.round(gap * 1000)} ms`;
    };
    ['loud', 'quiet'].forEach((label, h) => {
      const s = { kick: score('kick', halves[h]), snare: score('snare', halves[h]), hat: score('hat', halves[h]) };
      const good = (x) => x.played > 0 && x.hit >= x.played * 0.6 && x.stray <= Math.max(1, x.hit * 0.2);
      check(good(s.kick) && good(s.snare) && good(s.hat),
        `visualiser: a mastered mix (${label}): its kicks, snares and hats are found where they were played (${JSON.stringify(s)}; ${pace(halves[h])})`);
    });
    const bpm = run.frames[run.frames.length - 1].bpm;
    check(bpm >= 121 && bpm <= 127, `visualiser: a mastered mix at 124 bpm reads as ${bpm} bpm`);
    // The bars jump on the kick: the bass in the 80 ms after a kick arrives (played plus the
    // measured latency) stands above the bass in the 60 ms before it arrives.
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const kicks = run.truth.kick.filter((t) => t > halves[0][0] && t < halves[0][1] - 0.2).map((t) => t + lag);
    const before = mean(kicks.map((t) => mean(run.frames.filter((f) => f.t > t - 0.07 && f.t <= t - 0.01).map((f) => f.bass))));
    const after = mean(kicks.map((t) => mean(run.frames.filter((f) => f.t > t && f.t <= t + 0.08).map((f) => f.bass))));
    check(after - before > 0.05, `visualiser: the bass bars jump on the kick (${before.toFixed(2)} -> ${after.toFixed(2)}; latency ${Math.round(lag * 1000)} ms)`);
    }
    check(errors.length === 0, `visualiser (mastered mix): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // A microphone in a room with no music: its noise (pink, as a room's is) is no beat. A quiet
  // room gives next to no onsets and a loud one (a fan, traffic) no tempo: a first version of the
  // dB analysis found a kick about every second in both, and a tempo of 110-126 (2026-11-22).
  for (const [label, level] of [['quiet', 0.003], ['loud', 0.03]]) {
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await page.addInitScript((level) => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        // 20 s that never repeat: a looped buffer would repeat its noise, and with it a tempo.
        const buf = ac.createBuffer(1, ac.sampleRate * 20, ac.sampleRate);
        const d = buf.getChannelData(0);
        let seed = 11, y = 0;
        for (let i = 0; i < d.length; i++) {
          seed = (seed * 16807) % 2147483647;
          const w = seed / 1073741823.5 - 1;
          y = 0.97 * y + 0.03 * w;
          d[i] = (y * 6 + w * 0.3) * level;
        }
        const s = ac.createBufferSource();
        s.buffer = buf;
        const out = ac.createMediaStreamDestination();
        s.connect(out);
        s.start();
        return out.stream;
      };
    }, level);
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__from = performance.now() / 1000;
      w.__found = new Map();
      w.__bpm = 0;
      const tick = () => {
        const a = w.SonicVisualizer.analysis();
        a.onsets.forEach((o) => { if (o.t > w.__from) w.__found.set(o.name + o.t, o); });
        w.__bpm = Math.max(w.__bpm, a.bpm);
        if (performance.now() / 1000 - w.__from < 9) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForTimeout(8500);
    const r = await page.evaluate(() => {
      const n = { kick: 0, snare: 0, hat: 0 };
      for (const o of window.__found.values()) n[o.name] += 1;
      return { n, bpm: window.__bpm, source: window.SonicVisualizer.source() };
    });
    const total = r.n.kick + r.n.snare + r.n.hat;
    // Music at 120 bpm has 16 kicks in 8 s; the noise of a quiet room has at most a stray few.
    check(r.source === 'mic' && r.bpm === 0 && (label === 'loud' || total <= 4),
      `visualiser: a ${label} room without music: no tempo${label === 'quiet' ? ', next to no onsets' : ''} (${JSON.stringify(r.n)} in 8 s, ${r.bpm} bpm)`);
    check(errors.length === 0, `visualiser (${label} room): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The analysis hears where the sound stands and what it is made of: a 440 Hz tone panned hard
  // left (balance -1, width 0.5: one side only, a tone's flatness), then white noise in the
  // centre, quiet, then 24 dB louder (balance 0, width 0, as flat and bright as noise, the
  // loudness 24 dB up), then a second, mono stream with the tone (0 and 0: a mono microphone is
  // centred, not hard left). Before it, the clock (the player playing, no sound) has no pitch and
  // no stereo, and its bar runs over four beats with the downbeat on the first.
  {
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      let calls = 0;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const out = ac.createMediaStreamDestination();
        const tone = ac.createOscillator();
        tone.frequency.value = 440;
        const tg = ac.createGain();
        tg.gain.value = 0.2;
        if (calls++) {
          out.channelCount = 1;
          tone.connect(tg).connect(out);
          tone.start();
          return out.stream;
        }
        const offset = performance.now() / 1000 - ac.currentTime;
        const t0 = ac.currentTime + 0.2;
        const pan = ac.createStereoPanner();
        pan.pan.value = -1;
        tone.connect(tg).connect(pan).connect(out);
        tone.start(t0);
        tone.stop(t0 + 3);
        const buf = ac.createBuffer(1, ac.sampleRate * 7, ac.sampleRate);
        const d = buf.getChannelData(0);
        let seed = 3;
        for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = seed / 1073741823.5 - 1; }
        const noise = ac.createBufferSource();
        noise.buffer = buf;
        const ng = ac.createGain();
        ng.gain.setValueAtTime(0.2 / 16, 0);
        ng.gain.setValueAtTime(0.2, t0 + 6);
        noise.connect(ng).connect(out);
        noise.start(t0 + 3);
        window.__ends = [t0 + 3, t0 + 6, t0 + 9].map((t) => t + offset);
        return out.stream;
      };
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await showViz(page);
    // Every frame's features, in the page's clock.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__frames = [];
      const tick = () => {
        const a = w.SonicVisualizer.analysis();
        w.__frames.push(Object.assign({ t: performance.now() / 1000 }, a, { bands: null, onsets: null }));
        if (w.__frames.length < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      w.__state = document.documentElement.getAttribute('data-player-state');
      document.documentElement.setAttribute('data-player-state', 'playing');
    });
    await page.waitForTimeout(2600);
    const clock = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      if (w.__state) document.documentElement.setAttribute('data-player-state', w.__state);
      else document.documentElement.removeAttribute('data-player-state');
      return w.__frames.splice(0);
    });
    const bars = clock.map((f) => f.bar);
    const downs = clock.filter((f) => f.downbeat > 0.9).map((f) => f.bar);
    check(clock.length > 20 && clock.every((f) => f.source === 'clock' && f.chroma.every((c) => c === 0) && f.balance === 0
      && f.width === 0 && f.keyStrength === 0 && f.brightness >= 0 && f.brightness <= 1 && f.rolloff >= 0 && f.rolloff <= 1
      && f.loudness === f.level) && Math.min(...bars) < 0.1 && Math.max(...bars) > 0.9 && downs.length > 0 && downs.every((b) => b < 0.05),
    `visualiser: the clock has no pitch and no stereo, its bar runs over four beats from the downbeat (${clock.length} frames, bar ${Math.min(...bars).toFixed(2)}-${Math.max(...bars).toFixed(2)}, downbeats at ${downs.map((b) => b.toFixed(2)).join(' ')})`);
    // The controls faded while the pointer rested; a move shows them.
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => window.__ends && performance.now() / 1000 > window.__ends[2] + 0.2, null, { timeout: 30000 }).catch(() => {});
    const run = await page.evaluate(() => ({ frames: window.__frames, ends: window.__ends }));
    if (!run.ends) {
      check(false, 'visualiser: stereo, timbre and loudness: the signal never started');
    } else {
      // Each phase's last 0.7 s (its first moments let the smoothing settle).
      const phase = (end) => {
        const fs = run.frames.filter((f) => f.t > end - 0.8 && f.t < end - 0.1);
        const mean = (k) => fs.reduce((s, f) => s + f[k], 0) / Math.max(1, fs.length);
        return { n: fs.length, balance: mean('balance'), width: mean('width'), flatness: mean('flatness'), rolloff: mean('rolloff'),
          brightness: mean('brightness'), loudness: mean('loudness'), lufs: mean('lufs'), dyn: mean('dynamicsDb') };
      };
      const [left, quiet, loud] = run.ends.map(phase);
      const say = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Math.round(v * 100) / 100])));
      check(left.n > 5 && left.balance < -0.9 && left.width > 0.4 && left.width < 0.6,
        `visualiser: a tone panned hard left reads balance -1, width 0.5 (${say(left)})`);
      check(quiet.n > 5 && Math.abs(quiet.balance) < 0.1 && quiet.width < 0.1,
        `visualiser: noise in the centre reads balance 0, width 0 (${say(quiet)})`);
      check(left.flatness < 0.1 && quiet.flatness > 0.8 && loud.flatness > 0.8,
        `visualiser: a tone is tonal, white noise flat (flatness ${left.flatness.toFixed(2)} vs ${quiet.flatness.toFixed(2)})`);
      check(left.brightness < 0.05 && quiet.brightness > 0.6 && left.rolloff > 0.35 && left.rolloff < 0.45 && quiet.rolloff > 0.9,
        `visualiser: a 440 Hz tone is dark, its rolloff at 440 Hz; white noise bright, its rolloff near the top (brightness ${left.brightness.toFixed(2)} vs ${quiet.brightness.toFixed(2)}, rolloff ${left.rolloff.toFixed(2)} vs ${quiet.rolloff.toFixed(2)})`);
      check(Math.abs(loud.lufs - quiet.lufs - 24) < 3 && Math.abs(loud.loudness - quiet.loudness - 0.5) < 0.08 && loud.loudness < 1,
        `visualiser: a passage 24 dB louder reads 24 dB louder (${quiet.lufs.toFixed(1)} -> ${loud.lufs.toFixed(1)} LUFS, loudness ${quiet.loudness.toFixed(2)} -> ${loud.loudness.toFixed(2)})`);
      // The dynamics read 3 s: at the end of the loud passage nearly all of them are its noise.
      const steady = run.frames.filter((f) => f.t > run.ends[2] - 0.3 && f.t < run.ends[2] - 0.1).map((f) => f.dynamicsDb);
      check(steady.length > 0 && Math.max(...steady) < 3, `visualiser: a steady noise has next to no dynamics (${steady.map((x) => x.toFixed(1)).join(' ')} dB)`);
      // A second stream, mono: the analysis starts again from it.
      await page.evaluate(() => window.SonicVisualizer.stop());
      await page.evaluate(() => window.SonicVisualizer.listen('mic'));
      await page.waitForTimeout(1500);
      const mono = await page.evaluate(() => window.SonicVisualizer.analysis());
      check(mono.source === 'mic' && Math.abs(mono.balance) < 0.05 && mono.width < 0.05 && mono.loudness > 0.5,
        `visualiser: a mono source reads balance 0, width 0 (${mono.balance.toFixed(2)}, ${mono.width.toFixed(2)})`);
    }
    check(errors.length === 0, `visualiser (stereo, timbre, loudness): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The analysis hears the harmony: a C major chord (C4, E4, G4, each with five harmonics) for
  // 5 s, then an A minor chord (A3, C4, E4). The chroma peaks at C, E and G, then at A, C and E;
  // the key reads C major, then A minor, and changes once, within 3 s, not from frame to frame.
  {
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const out = ac.createMediaStreamDestination();
        const offset = performance.now() / 1000 - ac.currentTime;
        const t0 = ac.currentTime + 0.2;
        const wave = ac.createPeriodicWave(new Float32Array([0, 1, 0.5, 0.33, 0.25, 0.2]), new Float32Array(6));
        const note = (hz, from, to) => {
          const o = ac.createOscillator();
          o.setPeriodicWave(wave);
          o.frequency.value = hz;
          const g = ac.createGain();
          g.gain.value = 0.15;
          o.connect(g).connect(out);
          o.start(from);
          o.stop(to);
        };
        [261.63, 329.63, 392].forEach((hz) => note(hz, t0, t0 + 5));
        [220, 261.63, 329.63].forEach((hz) => note(hz, t0 + 5, t0 + 10));
        window.__ends = [t0 + 5, t0 + 10].map((t) => t + offset);
        return out.stream;
      };
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__frames = [];
      const tick = () => {
        const a = w.SonicVisualizer.analysis();
        w.__frames.push({ t: performance.now() / 1000, chroma: a.chroma, pitch: a.pitch, key: a.key, minor: a.minor, strength: a.keyStrength });
        if (w.__frames.length < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForFunction(() => window.__ends && performance.now() / 1000 > window.__ends[1] - 0.05, null, { timeout: 30000 }).catch(() => {});
    const run = await page.evaluate(() => ({ frames: window.__frames, ends: window.__ends }));
    if (!run.ends) {
      check(false, 'visualiser: the harmony: the chords never played');
    } else {
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const chord = (end) => {
        const fs = run.frames.filter((f) => f.t > end - 0.8 && f.t < end - 0.1);
        const mean = names.map((_, i) => fs.reduce((s, f) => s + f.chroma[i], 0) / Math.max(1, fs.length));
        const top = mean.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, 3).map(([, i]) => i).sort((x, y) => x - y);
        const last = fs[fs.length - 1] || { key: -1, minor: -1, pitch: -1, strength: 0 };
        return { top, third: mean.slice().sort((x, y) => y - x)[3], key: last.key, minor: last.minor, pitch: last.pitch, strength: last.strength };
      };
      const [cmaj, amin] = run.ends.map(chord);
      const said = (c) => `${c.top.map((i) => names[i]).join(' ')}, key ${names[c.key] || '?'}${c.minor ? 'm' : ''} (${c.strength.toFixed(2)}), the next class ${c.third.toFixed(2)}`;
      check(cmaj.top.join() === '0,4,7' && cmaj.third < 0.5 && [0, 4, 7].includes(cmaj.pitch),
        `visualiser: a C major chord's chroma peaks at C, E and G (${said(cmaj)})`);
      check(amin.top.join() === '0,4,9' && amin.third < 0.5 && [0, 4, 9].includes(amin.pitch),
        `visualiser: an A minor chord's chroma peaks at A, C and E, distinct from C major (${said(amin)})`);
      check(cmaj.key === 0 && cmaj.minor === 0 && amin.key === 9 && amin.minor === 1 && cmaj.strength > 0.8 && amin.strength > 0.8,
        `visualiser: the key reads C major, then A minor (${said(cmaj)}; ${said(amin)})`);
      const keyed = run.frames.filter((f) => f.t > run.ends[0] - 4 && f.t < run.ends[1]);
      const changes = keyed.slice(1).filter((f, i) => f.key * 2 + f.minor !== keyed[i].key * 2 + keyed[i].minor).map((f) => f.t - run.ends[0]);
      check(changes.length === 1 && changes[0] > 0.3 && changes[0] < 3,
        `visualiser: the key changes once with the chord, never flickering (${changes.map((d) => d.toFixed(2) + ' s after the chord').join(', ') || 'never'})`);
    }
    check(errors.length === 0, `visualiser (harmony): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // The analysis hears the bar and the song's parts: a groove at 120 bpm whose first beat of each
  // bar is played 6 dB louder, under a pad and hats, for 12 s (it starts on the bar's last beat,
  // so the downbeat is learnt from the accents, not taken from the first kick heard); then the same beat under a new
  // texture (bright chords and a wash of noise) for 8 s. On the accented kick the bar reads 0, on
  // the others a quarter, a half, three quarters; one new section is counted, 0.2-4 s after the
  // switch, not one on every beat; a beat's dynamics stand far above a steady noise's; and a
  // frame's analysis costs little.
  {
    const { context, page, errors } = await open(browser, at('404.html'), desktop, 'dark');
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      md.getDisplayMedia = undefined;
      md.getUserMedia = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const out = ac.createMediaStreamDestination();
        const bus = ac.createGain();
        bus.gain.value = 0.5;
        bus.connect(out);
        const offset = performance.now() / 1000 - ac.currentTime;
        const t0 = ac.currentTime + 0.3;
        const sw = t0 + 12;
        const pad = (type, hz, cut, level, from, to) => {
          const o = ac.createOscillator(); o.type = type; o.frequency.value = hz;
          const f = ac.createBiquadFilter(); f.frequency.value = cut;
          const g = ac.createGain(); g.gain.value = level;
          o.connect(f).connect(g).connect(bus); o.start(from); o.stop(to);
        };
        [220, 261.6, 329.6].forEach((hz) => pad('triangle', hz, 1200, 0.06, t0, sw));
        [440, 554.4, 659.3, 880].forEach((hz) => pad('sawtooth', hz, 6000, 0.08, sw, sw + 9));
        const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
        const d = noise.getChannelData(0);
        let seed = 5;
        for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = seed / 1073741823.5 - 1; }
        const hiss = (cut, level, at, len) => {
          const s = ac.createBufferSource(); s.buffer = noise; s.loop = len < 0;
          const f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = cut;
          const g = ac.createGain();
          g.gain.setValueAtTime(level, at);
          if (len > 0) g.gain.exponentialRampToValueAtTime(0.001, at + len);
          s.connect(f).connect(g).connect(bus); s.start(at);
        };
        hiss(3000, 0.15, sw, -1);
        const truth = { down: [], beat: [], sw: sw + offset };
        for (let i = 0; i * 0.5 < 20.5; i++) {
          const t = t0 + i * 0.5;
          const k = ac.createOscillator();
          k.frequency.setValueAtTime(150, t); k.frequency.exponentialRampToValueAtTime(45, t + 0.12);
          const kg = ac.createGain();
          kg.gain.setValueAtTime(0, t); kg.gain.linearRampToValueAtTime(i % 4 === 1 ? 1 : 0.5, t + 0.003);
          kg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
          k.connect(kg).connect(bus); k.start(t); k.stop(t + 0.35);
          hiss(8000, 0.3, t + 0.25, 0.05);
          (i % 4 === 1 ? truth.down : truth.beat).push(t + offset);
        }
        window.__truth = truth;
        return out.stream;
      };
    });
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate(() => window.SonicVisualizer.open('tower'));
    await showViz(page);
    await page.click('#visualizer-full [data-viz-source="connect"]');
    await page.waitForFunction(() => window.SonicVisualizer.source() === 'mic', null, { timeout: 15000 }).catch(() => {});
    // Every frame, and the bar on the frame each kick was found.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__frames = [];
      w.__kicks = new Map();
      const tick = () => {
        const a = w.SonicVisualizer.analysis();
        w.__frames.push({ t: performance.now() / 1000, bar: a.bar, downbeat: a.downbeat, section: a.section, change: a.change,
          novelty: a.novelty, dyn: a.dynamicsDb, dynamics: a.dynamics, bpm: a.bpm, cost: a.cost });
        a.onsets.forEach((o) => { if (o.name === 'kick' && !w.__kicks.has(o.t)) w.__kicks.set(o.t, a.bar); });
        if (w.__frames.length < 5000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForFunction(() => window.__truth && performance.now() / 1000 > window.__truth.sw + 8, null, { timeout: 45000 }).catch(() => {});
    const run = await page.evaluate(() => ({ frames: window.__frames, kicks: Array.from(window.__kicks.entries()), truth: window.__truth }));
    if (!run.truth || run.frames.length < 60) {
      check(false, `visualiser: the bar and the parts: the analysis ran (${run.frames.length} frames, ${run.truth ? 'the groove played' : 'the groove never started'})`);
    } else {
      const T = run.truth;
      // Once the tempo is known (6 s in), each kick found is matched to the beat it was played on
      // (the stream's latency is under 0.15 s) and the bar read where it was found.
      const settled = T.down[0] + 6;
      const on = (list, t) => list.some((x) => t - x > -0.02 && t - x < 0.15);
      const found = run.kicks.filter(([t]) => t > settled);
      const downs = found.filter(([t]) => on(T.down, t)).map(([, bar]) => bar);
      const others = found.filter(([t]) => on(T.beat, t)).map(([, bar]) => bar);
      const atZero = (b) => b < 0.06 || b > 0.96;
      const quarter = (b) => Math.abs(b * 4 - Math.round(b * 4)) < 0.25 && Math.round(b * 4) % 4 !== 0;
      check(downs.length >= 5 && downs.filter(atZero).length >= downs.length * 0.8 && others.length >= 12 && others.filter(quarter).length >= others.length * 0.8,
        `visualiser: the bar reads 0 on the accented kick and a quarter, half, three quarters on the others (downbeats ${downs.map((b) => b.toFixed(2)).join(' ')}; others ${others.map((b) => b.toFixed(2)).join(' ')})`);
      const db = run.frames.filter((f) => f.t > settled && f.downbeat > 0.9).map((f) => f.bar);
      check(db.length >= 4 && db.every(atZero), `visualiser: the downbeat envelope rises on the bar's first beat (${db.map((b) => b.toFixed(2)).join(' ')})`);
      // The sections: one, a moment after the switch; none from the beat before or after it.
      const steps = run.frames.slice(1).filter((f, i) => f.section !== run.frames[i].section).map((f) => f.t - T.sw);
      const before = Math.max(...run.frames.filter((f) => f.t > T.sw - 2.5 && f.t < T.sw).map((f) => f.novelty));
      const after = Math.max(...run.frames.filter((f) => f.t > T.sw && f.t < T.sw + 4).map((f) => f.novelty));
      const lifted = run.frames.find((f) => f.t > T.sw + (steps[0] || 0) && f.t < T.sw + (steps[0] || 0) + 0.1);
      check(steps.length === 1 && steps[0] > 0.2 && steps[0] < 4 && after > before * 2 && lifted && lifted.change > 0.8,
        `visualiser: a new texture counts one new section, not one on every beat (${steps.map((s) => s.toFixed(2) + ' s after the switch').join(', ') || 'none'}; novelty ${before.toFixed(2)} before, ${after.toFixed(2)} after)`);
      const dyn = run.frames.filter((f) => f.t > settled && f.t < T.sw).map((f) => f.dyn);
      const low = dyn.slice().sort((x, y) => x - y)[dyn.length >> 2];
      check(low > 5 && run.frames.every((f) => f.dynamics >= 0 && f.dynamics <= 1),
        `visualiser: a beat has dynamics (${low.toFixed(1)} dB peak over mean, a steady noise under 3)`);
      const cost = run.frames.filter((f) => f.t > T.sw).map((f) => f.cost).sort((x, y) => x - y);
      const median = cost[cost.length >> 1];
      check(median < 2, `visualiser: a frame's analysis costs little (${median.toFixed(3)} ms a frame, median)`);
    }
    check(errors.length === 0, `visualiser (bar, sections): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // Without WebGL 2 a GPU mode is drawn by its p5 fallback, and the settings say so; three.js is
  // never downloaded for nothing.
  {
    const { context, page, errors } = await open(browser, at('404.html'), desktop);
    await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === 'webgl2' ? null : get.call(this, kind, ...rest); };
    });
    let three = 0;
    page.on('request', (r) => { if (/vendor\/three-/.test(r.url())) three += 1; });
    await page.goto(at('?viz=liquid'), { waitUntil: 'load' });
    await page.waitForFunction(() => Number(document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-frame') || 0) > 10, null, { timeout: 15000 }).catch(() => {});
    const fb = await page.evaluate(() => ({ mode: window.SonicVisualizer.mode(), shown: window.SonicVisualizer.shown(), engine: window.SonicVisualizer.engine() }));
    check(fb.mode === 'liquid' && fb.shown === 'flux' && fb.engine === 'p5' && await page.evaluate(litShare, '[data-visualizer-stage] canvas') > 0,
      `visualiser (no WebGL 2): liquid is drawn by its fallback (${JSON.stringify(fb)})`);
    // Flux morphs through five shapes, a new one every 7 s: it runs past the last of them.
    await page.waitForTimeout(22500);
    check(await page.evaluate(litShare, '[data-visualizer-stage] canvas') > 0, 'visualiser: flux still draws after morphing through every shape');
    await page.mouse.move(30, 30);
    await showViz(page); await page.click('#visualizer-full [data-viz-settings]');
    check(await page.isVisible('#visualizer-full [data-viz-fallback]'), 'visualiser (no WebGL 2): the settings say a lighter picture stands in');
    check(three === 0, `visualiser (no WebGL 2): three.js is never requested (${three})`);
    check(errors.length === 0, `visualiser (no WebGL 2): no console error${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  // A negative control for litShare: a blank canvas is not a picture.
  {
    const { context, page } = await open(browser, at(''), desktop);
    check(await page.evaluate(() => { const c = document.createElement('canvas'); c.id = 'blank-control'; c.width = 64; c.height = 36; document.body.appendChild(c); return true; })
      && await page.evaluate(litShare, '#blank-control') === 0, 'visualiser check: a blank canvas counts as unlit (negative control)');
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
    const newestStill = catalog.tracks.find((t) => t.thumbnail);
    check(featured === newestStill.source, `home features the newest review with a still (${newestStill.source})`);
    // The mosaic as served (hero.js turns its tiles a few seconds later).
    // Fetched by the page, so --artifact answers it (context.request would ask production).
    const served = await page.evaluate((u) => fetch(u).then((r) => r.text()), at(''));
    const mosaic = served.slice(served.indexOf('id="hero-mosaic"'), served.indexOf('id="hero-newest"'));
    const tiles = [...mosaic.matchAll(/data-source="([^"]+)"/g)].map((m) => m[1]);
    const nine = catalog.tracks.filter((t) => t.youtube).slice(0, 9).map((t) => t.source);
    check(tiles.join() === nine.join(), 'the hero mosaic shows the nine newest reviews with a video, newest first');
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
    const order = () => page.locator('#explorer-grid [data-track]').evaluateAll((els) => els.map((e) => e.dataset.source));
    const newest = catalog.tracks.map((t) => t.source);
    check((await order()).join() === newest.join(), 'sort newest first keeps the catalogue order, same-day reviews included');
    await page.selectOption('#explorer-sort', 'old');
    check((await order()).join() === newest.slice().reverse().join(), 'sort oldest first is the catalogue order reversed');
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
  // Home is scrolled just before Forward and the review is served 400 ms late, so a save still
  // pending from home fires after Forward has switched entries and before the review mounts: it
  // used to land in the review's entry (CI, run 43669472966: 0 of 900; here 120 of 900).
  {
    const context = await browser.newContext({ viewport: desktop });
    if (root) await context.route(`${base}**`, fromArtifact);
    await context.route((u) => u.pathname.endsWith('/' + sample.path), async (r) => {
      await new Promise((ok) => setTimeout(ok, 400));
      return r.fallback();
    });
    const page = await context.newPage();
    await page.goto(at(''), { waitUntil: 'load' });
    await page.evaluate((href) => window.SonicRouter.go(href), new URL(sample.path, base).href);
    await page.waitForFunction((p) => location.pathname.endsWith('/' + p) && document.documentElement.dataset.navigatingState === '', sample.path, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(400);
    const left = await page.evaluate(() => Math.round(window.scrollY));
    await page.goBack();
    await page.waitForFunction(() => !!document.getElementById('explorer-grid') && document.documentElement.dataset.navigatingState === '', null, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 120));
    await page.goForward();
    await page.waitForFunction((p) => location.pathname.endsWith('/' + p) && document.documentElement.dataset.navigatingState === '', sample.path, { timeout: 10000 }).catch(() => {});
    // Waits for the place rather than a fixed time, so a slow restore is told from a missing one.
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 40, left, { timeout: 3000 }).catch(() => {});
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
    // Measured once the page's charts have drawn (or 5 s passed) and fonts are in: on production the
    // genres index once measured 210 px of overflow mid-render and none a minute later (run
    // 44753754937); the check is about the settled layout, not a frame during it.
    await page.waitForFunction(() => !document.querySelector('[data-chart]') || Number(document.documentElement.dataset.chartsState) > 0,
      null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
    // The shell clips the document (#shell overflow-hidden), so the content area is measured too.
    const overflow = await page.evaluate(() => {
      const main = document.getElementById('main-content');
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
    });
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

  // One page layout (rule project.ui-components), phone to wide desktop: nothing overflows the page
  // or its content area, the page header and the first card share the gutter's left edge, long
  // text is mobile first (16 px or less on a phone, no content heading above the page title), a
  // plain page's text fills its card at a readable measure, and the navbar's title and controls
  // never overlap.
  for (const width of [360, 768, 1280, 1440, 1920]) {
    const gutter = width >= 1280 ? 32 : 16;
    for (const [name, rel] of [['welcome', 'welcome/'], ['author', 'author/'], ['cs welcome', 'cs/welcome/'], ['track', sample.path],
      ['archive', 'archive/'], ['insights', 'insights/'], ['concepts', 'concept/'], ['yearbooks', 'yearbook/']]) {
      const { context, page, errors } = await open(browser, at(rel), { width, height: 900 }, width === 768 ? 'dark' : 'light');
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
      const m = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        const left = (el) => (el ? el.getBoundingClientRect().left : null);
        const pad = (el) => parseFloat(getComputedStyle(el).paddingLeft);
        const header = document.querySelector('#main-content h1');
        const crumb = document.querySelector('#main-content nav[aria-label] ol, #main-content nav ol');
        const prose = document.querySelector('[data-prose]');
        const card = document.querySelector('[data-page-card]');
        const p = prose && prose.querySelector('p');
        const h2 = prose && prose.querySelector('h2');
        const shown = (el) => el.offsetParent && el.getBoundingClientRect().width > 1;
        const nav = document.querySelector('nav.fixed');
        const boxes = nav ? [...nav.querySelectorAll('a[href] span, button, a[href]:not(:has(span))')].filter(shown)
          .filter((el) => !el.closest('.sr-only') && !el.classList.contains('sr-only')).map((el) => {
            const range = document.createRange(); range.selectNodeContents(el);
            // A span's text, unless it is cut off (truncate): then its own box is what shows.
            const r = el.tagName === 'SPAN' && el.scrollWidth <= el.clientWidth ? range.getBoundingClientRect() : el.getBoundingClientRect();
            return { what: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 20), l: r.left, r: r.right, t: r.top, b: r.bottom };
          }) : [];
        const overlaps = [];
        for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]; const c = boxes[j];
          if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlaps.push(`${a.what} / ${c.what}`);
        }
        const firstCard = main && [...main.querySelectorAll('section, article, aside')].find((el) => el.getBoundingClientRect().width > 100 && !el.closest('header'));
        return {
          overflow: Math.max(document.documentElement.scrollWidth - innerWidth, main ? main.scrollWidth - main.clientWidth : 0),
          header: left(header), crumb: left(crumb), card: left(firstCard), main: main ? left(main) : 0,
          text: p ? parseFloat(getComputedStyle(p).fontSize) : null,
          h1: header ? parseFloat(getComputedStyle(header).fontSize) : null,
          h2: h2 ? parseFloat(getComputedStyle(h2).fontSize) : null,
          measure: p ? p.getBoundingClientRect().width / parseFloat(getComputedStyle(p).fontSize) : null,
          fill: card && prose ? Math.abs((left(prose) - left(card)) - pad(card)) + Math.abs(card.getBoundingClientRect().right - pad(card) - prose.getBoundingClientRect().right) : null,
          overlaps,
          // The narrowest title column of an aside's track rows (welcome, author).
          rows: Math.min(...[...document.querySelectorAll('aside [data-track] a > span.min-w-0')].map((el) => el.getBoundingClientRect().width)),
        };
      });
      const where = `${name} @${width}px`;
      check(m.overflow <= 0, `layout: ${where} nothing overflows the page or its content area (${m.overflow}px)`);
      if (m.header !== null) check(Math.abs(m.header - m.main - gutter) <= 1, `layout: ${where} the page title sits on the ${gutter}px gutter (${Math.round(m.header - m.main)}px)`);
      if (m.header !== null && m.card !== null) check(Math.abs(m.card - m.header) <= 1, `layout: ${where} the first card shares the title's left edge (${Math.round(m.card)} vs ${Math.round(m.header)})`);
      if (m.text !== null && width < 640) check(m.text <= 16, `layout: ${where} body text is mobile first (${m.text}px)`);
      if (m.h2 !== null && m.h1 !== null) check(m.h2 <= m.h1, `layout: ${where} no content heading outgrows the page title (h2 ${m.h2}px, h1 ${m.h1}px)`);
      if (m.fill !== null) check(m.fill <= 2, `layout: ${where} the text fills its card, not a column centred in it (${m.fill}px off)`);
      if (m.fill !== null && m.measure !== null) check(m.measure <= 45, `layout: ${where} the text keeps a readable measure (${m.measure.toFixed(1)}em per line)`);
      if (Number.isFinite(m.rows)) check(m.rows >= 64, `layout: ${where} the aside's track rows keep their titles readable (${Math.round(m.rows)}px)`);
      check(m.overlaps.length === 0, `layout: ${where} the navbar's title and controls do not overlap (${m.overlaps.join(', ')})`);
      check(errors.length === 0, `layout: ${where} no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
      if (width === 360 || width === 1920) await shot(page, `layout-${name.replace(' ', '-')}-${width}`);
      await context.close();
    }
  }

  // Without JavaScript the phone still reaches the navigation (review round 2).
  {
    const { context, page } = await open(browser, at(''), phone, 'light', { javaScriptEnabled: false });
    const box = await page.locator('#sidebar').boundingBox();
    check(box && box.x >= 0 && box.width > 300, `no-JS @390px: the sidebar is on screen (x=${box && box.x})`);
    await context.close();
  }

  // Full-text search (static/js/explorer.js over static/data/search*.json, sonic-search/v2):
  // relevance first, whole words, every token, word forms, phrases, the URL. Every expectation is
  // derived from the catalogue and the index as served, never typed: a review matches when its
  // index (its tokens in order) holds the words, a card when its text says them.
  {
    const readJson = async (rel) => JSON.parse(root ? fs.readFileSync(path.join(root, rel), 'utf8')
      : await (await get(at(rel))).text());
    const reviewsOf = async (rel) => {
      const data = await readJson(rel);
      check(data.schema === 'sonic-search/v2', `${rel}: schema sonic-search/v2 (${data.schema})`);
      return Object.fromEntries(Object.entries(data.tracks).map(([s, w]) => [s, ` ${w} `]));
    };
    const plain = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const searchIn = (page) => async (q) => {
      await page.fill('#explorer-q', q);
      await page.waitForFunction((want) => new URLSearchParams(location.search).get('q') === want
        && document.documentElement.dataset.reviewsState === 'ready', q, { timeout: 15000 });
      return page.locator('#explorer-grid [data-track]:not([hidden])').evaluateAll((els) =>
        els.map((e) => ({ source: e.dataset.source, text: e.dataset.text })));
    };
    const sources = (cards) => cards.map((c) => c.source);
    const same = (a, b) => sources(a).sort().join() === sources(b).sort().join();
    // Every review whose index holds `words` is shown, and every card shown has them in its
    // index or (`re`) in its own text: the matches are exactly the tracks that say it.
    const exact = (index, cards, words, re) => {
      const say = Object.keys(index).filter((s) => index[s].includes(words));
      const shown = sources(cards);
      return say.length > 0 && say.every((s) => shown.includes(s))
        && cards.every((c) => index[c.source].includes(words) || re.test(plain(c.text)));
    };
    const total = catalog.tracks.length;
    const noErrors = (what, errs) => check(errs.length === 0,
      `${what}: no console errors${errs.length ? ' — ' + errs.join(' | ') : ''}`);

    const en = await reviewsOf('data/search.json');
    const { context, page, errors } = await open(browser, at('?probe=kept'), desktop);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const search = searchIn(page);
    const url = () => new URL(page.url()).searchParams;

    // Relevance: the artist with most tracks (catalog.artists) finds their own tracks first,
    // and so does the same name with its last word unfinished, as it is while being typed.
    const top = catalog.artists[0].term;
    const own = catalog.tracks.filter((t) => t.artist.toLowerCase() === top.toLowerCase())
      .map((t) => t.source);
    for (const q of [top, top.slice(0, -1)]) {
      const shown = await search(q);
      check(own.length > 0 && shown.slice(0, own.length).every((c) => own.includes(c.source)),
        `search "${q}": the artist's own ${own.length} tracks come first (of ${shown.length})`);
    }
    check(await page.inputValue('#explorer-sort') === 'relevance' && !url().has('sort')
      && url().get('probe') === 'kept',
      'a query sorts by relevance by default; the URL holds no sort and keeps the other keys');
    // A title ranks its own track first: three catalogue titles of several words, each unique.
    const key = (s) => plain(s).replace(/[^a-z0-9]+/g, ' ').trim();
    const titles = catalog.tracks.filter((t) => /^[\x20-\x7e]+$/.test(t.track)
      && key(t.track).includes(' ')
      && catalog.tracks.filter((u) => key(u.track) === key(t.track)).length === 1).slice(0, 3);
    for (const t of titles) {
      const shown = await search(t.track);
      const first = shown.length ? shown[0].source : 'nothing';
      check(first === t.source,
        `search "${t.track}": its track first (${first}, of ${shown.length})`);
    }

    // Whole words: "art" is neither "start" nor "artist".
    const art = await search('art');
    check(art.length < total / 4 && exact(en, art, ' art ', /(^|[^a-z0-9])arts?([^a-z0-9]|$)/),
      `search "art": the word only (${art.length} of ${total})`);
    // Short tokens and digits are searched: "tb-303" is the run "tb 303".
    const tb = await search('tb-303');
    check(exact(en, tb, ' tb 303 ', /tb[^a-z0-9]+303/),
      `search "tb-303": exactly the tracks that name the TB-303 (${tb.length})`);
    // Word forms: a plural finds what its singular finds.
    const many = await search('synthesizers');
    const one = await search('synthesizer');
    check(same(many, one) && exact(en, one, ' synthesizer ', /synthesizer/),
      `search "synthesizers" finds what "synthesizer" finds (${many.length} = ${one.length})`);
    // A quoted phrase: its words side by side, fewer tracks than the same words anywhere.
    const loose = await search('bass line');
    const phrase = await search('"bass line"');
    check(phrase.length < loose.length && exact(en, phrase, ' bass line ', /bass[^a-z0-9]+line/),
      `search '"bass line"': the words side by side only (${phrase.length}, `
      + `unquoted ${loose.length})`);

    // A word being typed matches as typed too: a form rule must not turn it into a stem no word
    // starts with ("psy" is "psie" by the -y rule; every review saying a word in psy... shows).
    const half = 'psy';
    const sayHalf = Object.keys(en).filter((s) => en[s].includes(` ${half}`));
    const halfShown = sources(await search(half));
    check(sayHalf.length > 0 && sayHalf.every((s) => halfShown.includes(s)),
      `search "${half}": every review with a word that starts so (${sayHalf.length} of ${halfShown.length})`);
    // A possessive is its word: "daft punk's" finds what "daft punk" finds.
    const possessive = await search("daft punk's");
    const bare = await search('daft punk');
    check(bare.length > 0 && same(possessive, bare),
      `search "daft punk's" finds what "daft punk" finds (${possessive.length} = ${bare.length})`);

    // A sort the reader chooses wins over relevance and is in the URL; reset forgets it.
    await page.selectOption('#explorer-sort', 'new');
    const order = await page.locator('#explorer-grid [data-track]:not([hidden])')
      .evaluateAll((els) => els.map((e) => e.dataset.source));
    const byDate = catalog.tracks.map((t) => t.source).filter((s) => order.includes(s));
    check(url().get('sort') === 'new' && url().get('probe') === 'kept'
      && order.join() === byDate.join(),
      'search: a chosen sort (newest first) wins over relevance, in the URL beside the other keys');
    await page.fill('#explorer-q', '');
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('q'));
    check(url().get('sort') === 'new',
      'search: a chosen sort stays in the URL when the query is cleared, so a reload keeps it');
    await page.click('[data-explorer-reset]');
    await search('art');
    check(await page.inputValue('#explorer-sort') === 'relevance' && !url().has('sort'),
      'search: reset forgets the chosen sort; the next query is by relevance again');
    noErrors('search', errors);
    await context.close();

    // The Czech index on /cs/: Czech word forms, and one phrase in two cases.
    const cs = await reviewsOf('data/search.cs.json');
    const czech = await open(browser, at('cs/'), desktop);
    await czech.page.waitForFunction(() =>
      document.documentElement.dataset.explorerState === 'ready');
    const hledej = searchIn(czech.page);
    const forms = [];
    for (const q of ['syntezátory', 'syntezátor', 'syntezátorem']) forms.push(await hledej(q));
    check(same(forms[0], forms[1]) && same(forms[1], forms[2])
      && exact(cs, forms[0], ' syntezator ', /syntezator/),
      `cs: "syntezátory", "syntezátor", "syntezátorem" find the same ${forms[0].length} tracks`);
    const nominative = await hledej('"basová linka"');
    const instrumental = await hledej('"basovou linkou"');
    const czLoose = await hledej('basová linka');
    check(same(nominative, instrumental) && nominative.length < czLoose.length
      && exact(cs, nominative, ' basov link ', /basov[a-z]*[^a-z0-9]+link/),
      `cs: '"basová linka"' is '"basovou linkou"', words side by side (${nominative.length}, `
      + `unquoted ${czLoose.length})`);
    noErrors('cs search', czech.errors);
    await czech.context.close();
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
    // The listening guide on the track that plays seeks it in place (no reload of the frame).
    await page.evaluate((src) => Sonic.playIndex().then((c) => window.SonicPlayer.seek(c.tracks.find((t) => t.source === src), '0:42')), S[3]);
    check(await page.evaluate(() => window.__yt.calls.some((c) => c[0] === 'seek' && c[1] === 42)),
      'player: the listening guide seeks the playing track in place');

    await page.click('[data-player-queue]');
    check(await page.isVisible('#player-queue'), 'player: the queue panel opens');
    await videoSeen(page, 'player (desktop, small video, queue open)');
    const rows = async (kind) => page.locator(`#player-queue [data-queue-row="${kind}"]`).evaluateAll((els) => els.map((e) => e.dataset.source));
    check(JSON.stringify(await rows('now')) === JSON.stringify([S[3]]) && JSON.stringify(await rows('next')) === JSON.stringify([S[1]])
      && JSON.stringify(await rows('played')) === JSON.stringify([S[2], S[0]]),
      'player: the queue panel shows now playing, up next and played');
    await card(4, '[data-queue]').click();
    await until({ q: [S[0], S[2], S[3], S[1], S[4]] }, 'player: queued while the panel is open');
    await videoSeen(page, 'player (desktop, queue open, toast shown)');
    // The visualiser, opened from the queue's tools over a playing video: each mode draws, the
    // video stays uncovered, the toolbar fades when the pointer rests, Escape closes it and its
    // ?viz leaves the URL, and the queue is as it was.
    await page.click('#player-queue [data-visualizer-open]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-visualizer') === 'open');
    check(new URL(page.url()).searchParams.has('viz'), 'visualiser: opening it puts ?viz in the URL');
    check(new URL(page.url()).searchParams.get('play') === S[3].replace(/\.md$/, ''), 'player: the URL names the playing song (?play)');
    const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    for (const mode of await page.evaluate(() => window.SonicVisualizer.modes())) {
      await page.evaluate((m) => window.SonicVisualizer.set(m), mode);
      const from = Number(await page.getAttribute('[data-visualizer-stage]', 'data-visualizer-frame') || 0);
      await page.waitForFunction((f) => Number(document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-frame') || 0) > f + 20, from, { timeout: 10000 }).catch(() => {});
      const shown = await page.evaluate(() => ({ shown: window.SonicVisualizer.shown(), canvases: document.querySelectorAll('[data-visualizer-stage] canvas').length }));
      check(await page.evaluate(litShare, '[data-visualizer-stage] canvas') > 0 && shown.canvases === 1,
        `visualiser: ${mode} draws${shown.shown !== mode ? ' (as ' + shown.shown + ')' : ''}`);
      if (webgl) check(shown.shown === mode, `visualiser: ${mode} draws on its own engine where WebGL 2 exists`);
      await videoSeen(page, `visualiser (${mode}, desktop, queue open)`);
    }
    // Live controls and cinema: a slider writes its value into the URL; cinema fills the screen
    // with the video, the picture around it, and the settings sheet never lies over it.
    await page.evaluate(() => { window.SonicVisualizer.set('prism'); window.SonicVisualizer.param('warp', 1.5); });
    check(new URL(page.url()).searchParams.get('viz.warp') === '1.5', 'visualiser: a live control is in the URL (viz.warp)');
    await page.evaluate(() => window.SonicVisualizer.cinema(true));
    await page.waitForTimeout(300);
    check(new URL(page.url()).searchParams.get('viz.video') === 'cinema'
      && await page.evaluate(() => document.querySelector('#player-panel > div').getBoundingClientRect().width > innerWidth * 0.5),
      'visualiser: cinema fills the screen with the video and says so in the URL');
    await videoSeen(page, 'visualiser (cinema, desktop)');
    // A toast over cinema never lands on the video: desktop and landscape (a review, 2026-11-22).
    await page.evaluate(() => window.SonicPlayer.notify('A toast over cinema'));
    await page.waitForTimeout(120);
    await videoSeen(page, 'visualiser (cinema, desktop, toast shown)');
    const wide = page.viewportSize();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.SonicPlayer.notify('A toast over cinema in landscape'));
    await page.waitForTimeout(120);
    await videoSeen(page, 'visualiser (cinema, landscape 844x390, toast shown)');
    await page.setViewportSize(wide);
    await page.waitForTimeout(300);
    await showViz(page); await page.click('#visualizer-full [data-viz-settings]');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => {
      const v = document.querySelector('#player-panel > div').getBoundingClientRect();
      const s = document.getElementById('visualizer-settings').getBoundingClientRect();
      return s.right <= v.left || s.left >= v.right || s.bottom <= v.top || s.top >= v.bottom;
    }), 'visualiser (cinema, desktop): the settings and the video do not overlap');
    await videoSeen(page, 'visualiser (cinema, desktop, settings open)');
    // An independent review (2026-11-22) found each of these; each check fails on that build.
    // The live controls are named by their own labels (an <output> inside the label took it).
    check(await page.evaluate(() => [...document.querySelectorAll('#visualizer-settings [data-viz-param]')].filter((i) => i.offsetParent)
      .every((i) => i.labels.length === 1 && i.labels[0].tagName === 'LABEL' && i.labels[0].textContent.trim().length > 0)),
    'visualiser: every live control is named by its own label');
    const warpName = await page.evaluate(() => document.querySelector('label[for="viz-param-warp"]').textContent.trim());
    check(await page.getByRole('slider', { name: warpName, exact: true }).count() === 1, 'visualiser: a live control has its accessible name (role slider)');
    // Every control of the sheet is at least 40 px tall (the chips, the toggles, the sliders).
    const tiny = await page.evaluate(() => [...document.querySelectorAll('#visualizer-settings button, #visualizer-settings input[type=range], #visualizer-settings label:not([for])')]
      .filter((e) => e.offsetParent).filter((e) => e.getBoundingClientRect().height < 39.5).map((e) => e.outerHTML.slice(0, 60)));
    check(tiny.length === 0, `visualiser: every control of the settings is at least 40 px tall${tiny.length ? ': ' + tiny.join(' | ') : ''}`);
    // The radio pattern: one tab stop per group; the arrows move within a group and check what they
    // reach, and never change the picture from the Sound group.
    check(await page.evaluate(() => [...document.querySelectorAll('#visualizer-settings [role=radiogroup]')]
      .every((g) => g.querySelectorAll('[role=radio][tabindex="0"]').length === 1 && g.querySelector('[role=radio][tabindex="0"]').getAttribute('aria-checked') !== 'false')
      || [...document.querySelectorAll('#visualizer-settings [role=radiogroup]')].every((g) => g.querySelectorAll('[role=radio][tabindex="0"]').length === 1)),
    'visualiser: one tab stop per radio group');
    await page.focus('#visualizer-settings [data-viz-mode][aria-checked="true"]');
    const fromMode = await page.evaluate(() => window.SonicVisualizer.mode());
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate((m) => window.SonicVisualizer.mode() !== m
      && document.activeElement.getAttribute('data-viz-mode') === window.SonicVisualizer.mode()
      && document.activeElement.getAttribute('aria-checked') === 'true', fromMode),
    'visualiser: ArrowRight on a mode checks the next mode and keeps focus on it');
    const keptMode = await page.evaluate(() => window.SonicVisualizer.mode());
    await page.focus('#visualizer-settings [data-viz-source="mic"]');
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate((m) => window.SonicVisualizer.mode() === m && document.activeElement.getAttribute('data-viz-source') === 'clock'
      && window.SonicVisualizer.source() === 'clock', keptMode),
    'visualiser: the arrows in the Sound group move within it and leave the picture alone');
    // The glow's variables are set on the video panel, not on <html> (a whole-page restyle per frame).
    await page.waitForTimeout(300);
    check(await page.evaluate(() => document.documentElement.style.getPropertyValue('--viz-kick') === ''
      && document.getElementById('player-panel').style.getPropertyValue('--viz-kick') !== ''),
    'visualiser (cinema): the glow lives on the video panel, not on the root');
    // The 40 s change switch is remembered both ways.
    await page.click('#visualizer-full label:has([data-viz-cycle])');
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer') || '{}').cycle === false), 'visualiser: the change switch turns the 40 s change off');
    await page.click('#visualizer-full label:has([data-viz-cycle])');
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('sonic.visualizer') || '{}').cycle === true), 'visualiser: and on again');
    // Reset returns the live controls to the mode's defaults and takes them out of the URL.
    await page.evaluate(() => window.SonicVisualizer.set('prism'));
    await page.evaluate(() => window.SonicVisualizer.param('hue', 120));
    check(new URL(page.url()).searchParams.get('viz.hue') === '120', 'visualiser: a moved control is in the URL');
    await page.click('#visualizer-full [data-viz-reset]');
    check(!new URL(page.url()).searchParams.has('viz.hue') && (await page.evaluate(() => window.SonicVisualizer.params().hue)) === 0,
      'visualiser: Reset returns the controls to the mode\'s defaults');
    // A slider moved by the keyboard writes its value, live, and the URL follows.
    await page.focus('#viz-param-warp');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    check(new URL(page.url()).searchParams.has('viz.warp') && Number(new URL(page.url()).searchParams.get('viz.warp')) === (await page.evaluate(() => window.SonicVisualizer.params().warp)),
      'visualiser: a slider moved by the keyboard sets the control and the URL');
    // The cinema switch in the sheet and the cinema button agree.
    await page.click('#visualizer-full label:has([data-viz-cinema-switch])');
    check(!(await page.evaluate(() => window.SonicVisualizer.cinema())) && !new URL(page.url()).searchParams.has('viz.video'),
      'visualiser: the cinema switch turns cinema off');
    await page.click('#visualizer-full label:has([data-viz-cinema-switch])');
    check(await page.evaluate(() => window.SonicVisualizer.cinema()), 'visualiser: the cinema switch turns it on again');
    await page.keyboard.press('Escape');
    // C toggles cinema from the keyboard; F asks for real fullscreen.
    await page.focus('#visualizer-full');
    await page.keyboard.press('c');
    check(!(await page.evaluate(() => window.SonicVisualizer.cinema())), 'visualiser: C turns cinema off');
    await page.keyboard.press('c');
    check(await page.evaluate(() => window.SonicVisualizer.cinema()), 'visualiser: C turns cinema on');
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => !!document.fullscreenElement)) await page.keyboard.press('f');
    check(await page.evaluate(() => document.documentElement.getAttribute('data-visualizer') === 'open'), 'visualiser: F leaves the picture open');
    // "Copy a link" copies the URL of this picture and this song, and says so.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await showViz(page);
    await page.click('#visualizer-full [data-viz-share]');
    await page.waitForTimeout(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(new URL(copied).searchParams.get('viz') && new URL(copied).searchParams.get('play') && new URL(copied).searchParams.get('viz.video') === 'cinema',
      `visualiser: "Copy a link" copies the picture and the song (${copied.replace(/^https?:\/\/[^/]+/, '')})`);
    check(await page.evaluate(() => document.querySelector('[data-player-toast-text]').textContent.length > 0), 'visualiser: the copy is confirmed in the toast');
    // A resized window redraws the picture at its new size.
    const was = page.viewportSize();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    check(await page.evaluate(() => { const c = document.querySelector('[data-visualizer-stage] canvas'); return c && c.getBoundingClientRect().width === 900; }),
      'visualiser: a resized window redraws the picture at its new size');
    await page.setViewportSize(was);
    // Cinema yields to the open queue: the queue's own rules place the video beside it.
    await page.click('[data-player-queue]');
    await page.waitForTimeout(200);
    check(await page.isVisible('#player-queue'), 'visualiser (cinema): the queue opens over the picture');
    await videoSeen(page, 'visualiser (cinema, desktop, queue open)');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.SonicVisualizer.cinema(false));
    check(!(await page.isVisible('#player-queue')), 'visualiser: opening it closes the queue');
    await vizControlsOnTop(page, 'visualiser (desktop)');
    check(await page.evaluate(() => window.SonicVisualizer.source()) === 'clock', 'visualiser: nothing listens until the reader asks');
    await page.waitForFunction(() => document.getElementById('visualizer-full').getAttribute('data-controls') === 'hidden', null, { timeout: 8000 }).catch(() => {});
    check(await page.getAttribute('#visualizer-full', 'data-controls') === 'hidden', 'visualiser: the toolbar fades while the pointer rests');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.documentElement.hasAttribute('data-visualizer') && document.getElementById('visualizer-full').hidden), 'visualiser: Escape closes it');
    check(!new URL(page.url()).searchParams.has('viz'), 'visualiser: closing it takes ?viz out of the URL');
    check(await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-player-queue]')),
      'visualiser: closing it returns focus to the queue button it was opened from');
    // Escape closes the topmost layer only: the queue reopened over it first, then the picture.
    await page.evaluate(() => window.SonicVisualizer.open('bars'));
    check(await page.evaluate(() => window.SonicVisualizer.mode() === 'tower'), 'visualiser: the old name bars opens its successor');
    await page.click('[data-player-queue]');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.getElementById('player-queue').hidden && document.documentElement.getAttribute('data-visualizer') === 'open'),
      'visualiser: Escape with the queue open closes the queue and keeps the picture');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.documentElement.hasAttribute('data-visualizer')), 'visualiser: the next Escape closes the picture');
    // Leaving a mode before its first frame (reef builds its grid on the first frame): the next
    // mode takes over, and a close right after it still closes, leaving no page inert.
    await page.evaluate(() => window.SonicVisualizer.open('prism'));
    await page.waitForFunction(() => Number(document.querySelector('[data-visualizer-stage]').getAttribute('data-visualizer-frame') || 0) > 5, null, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => { window.SonicVisualizer.set('reef'); window.SonicVisualizer.set('fold'); });
    await page.waitForTimeout(400);
    check(await page.evaluate(() => window.SonicVisualizer.mode() === 'fold' && document.querySelectorAll('[data-visualizer-stage] canvas').length === 1),
      'visualiser: a mode left before its first frame hands over cleanly');
    await page.evaluate(() => { window.SonicVisualizer.set('reef'); window.SonicVisualizer.close(); });
    check(await page.evaluate(() => !document.documentElement.hasAttribute('data-visualizer') && document.getElementById('visualizer-full').hidden
      && !document.getElementById('main-content').hasAttribute('inert')),
    'visualiser: a close right after a mode change closes, and the page is usable');
    // A link to the page on screen fetches nothing, whatever the player keeps in the URL.
    let refetched = 0;
    const onRequest = (r) => { if (r.resourceType() === 'fetch' && new URL(r.url()).pathname === new URL(page.url()).pathname) refetched += 1; };
    page.on('request', onRequest);
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = location.pathname;
      a.id = 'same-page-probe';
      a.textContent = 'here';
      document.getElementById('main-content').prepend(a);
    });
    check(new URL(page.url()).searchParams.has('play'), 'player: the URL names the song before the same-page link');
    await page.click('#same-page-probe');
    await page.waitForTimeout(600);
    page.off('request', onRequest);
    check(refetched === 0, `router: a link to the page on screen fetches nothing although ?play is in the URL (${refetched})`);
    await page.evaluate(() => document.getElementById('same-page-probe').remove());
    // Leaving a page with the picture open closes it before the next entry is pushed, so Back
    // never returns to an entry that reopens it.
    await page.evaluate(() => window.SonicVisualizer.open('veil'));
    check(new URL(page.url()).searchParams.get('viz') === 'veil', 'visualiser: open, the URL names it');
    const away = catalog.tracks.find((t) => t.youtube && !t.video_gone && t.source !== S[0]);
    await page.evaluate((href) => window.SonicRouter.go(href), at(away.path));
    await page.waitForFunction((p) => location.pathname.endsWith(p), away.path, { timeout: 15000 }).catch(() => {});
    check(!new URL(page.url()).searchParams.has('viz') && new URL(page.url()).searchParams.has('play'),
      'router: the next page keeps the song and not the closed picture');
    await page.goBack();
    await page.waitForTimeout(800);
    check(!new URL(page.url()).searchParams.has('viz') && !(await page.evaluate(() => document.documentElement.hasAttribute('data-visualizer'))),
      'router: Back returns to the page without reopening the picture');
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready', null, { timeout: 15000 }).catch(() => {});
    // Behind every page while the player plays (the owner, 2026-11-16): the layer draws while
    // playing, never covers the video, rests while paused and obeys the settings' switch.
    await page.evaluate(() => window.__yt.fire(1));
    await page.waitForFunction(() => Number(document.getElementById('visualizer-bg').getAttribute('data-visualizer-frame') || 0) > 20, null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => window.SonicVisualizer.background()) && await page.evaluate(litShare, '#visualizer-bg canvas') > 0,
      'visualiser: it draws behind the page while the player plays');
    await videoSeen(page, 'visualiser behind the page (desktop, playing)');
    // It lies under the page (a negative z-index in the root stacking context) and never takes a
    // click; elementFromPoint cannot judge it, since it skips pointer-events: none.
    check(await page.evaluate(() => { const c = getComputedStyle(document.getElementById('visualizer-bg')); return Number(c.zIndex) < 0 && c.pointerEvents === 'none' && c.position === 'fixed'; }),
      'visualiser: the background picture lies under the page and takes no clicks');
    await page.evaluate(() => window.__yt.fire(2));
    await page.waitForFunction(() => !window.SonicVisualizer.background(), null, { timeout: 5000 }).catch(() => {});
    check(await page.evaluate(() => !window.SonicVisualizer.background() && !document.documentElement.hasAttribute('data-visualizer-bg')), 'visualiser: the background rests while the player is paused');
    await page.evaluate(() => { localStorage.setItem('sonic.visualizer', JSON.stringify({ bg: false })); window.__yt.fire(1); });
    await page.waitForTimeout(600);
    check(await page.evaluate(() => !window.SonicVisualizer.background()), 'visualiser: the settings\' switch keeps the background off');
    await page.evaluate(() => localStorage.removeItem('sonic.visualizer'));
    if (!(await page.isVisible('#player-queue'))) await page.click('[data-player-queue]');
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
    await page.click('[data-player-queue]');
    await page.evaluate(() => window.SonicPlayer.notify('A toast while the large video and the queue are open'));
    await videoSeen(page, 'player (desktop, large video, queue open, toast shown)');
    await page.keyboard.press('Escape');
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
    await page.evaluate(() => window.SonicPlayer.notify('A toast while the queue is open'));
    await videoSeen(page, 'player (phone, queue open, toast shown)');
    check(await page.isVisible('#player-queue [data-player-repeat]') && await page.isVisible('#player [data-player-prev]'),
      'player (phone): previous is in the bar and repeat in the queue panel');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'player (phone): no horizontal overflow');
    await shot(page, 'player-phone-queue');
    await page.click('#player-queue [data-visualizer-open]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-visualizer') === 'open');
    await page.mouse.move(20, 20);
    await vizControlsOnTop(page, 'visualiser (phone, opened from the queue)');
    await videoSeen(page, 'visualiser (phone, opened from the queue)');
    await showViz(page); await page.click('#visualizer-full [data-viz-settings]');
    check(await page.isVisible('#visualizer-settings') && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'visualiser (phone): the settings open within the screen');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => {
      const v = document.querySelector('#player-panel > div').getBoundingClientRect();
      const s = document.getElementById('visualizer-settings').getBoundingClientRect();
      return s.right <= v.left || s.left >= v.right || s.bottom <= v.top || s.top >= v.bottom;
    }), 'visualiser (phone): the settings sheet ends above the video');
    await videoSeen(page, 'visualiser (phone, settings open)');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.getElementById('visualizer-settings').hidden && document.documentElement.getAttribute('data-visualizer') === 'open'),
      'visualiser (phone): Escape closes the settings first');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.documentElement.hasAttribute('data-visualizer')), 'visualiser (phone): then the picture');
    check(await page.evaluate(() => {
      const mark = document.querySelector('nav a[href]').getBoundingClientRect();
      return [...document.querySelectorAll('nav button, nav a')].filter((b) => b.offsetParent && b !== document.querySelector('nav a[href]'))
        .every((b) => { const r = b.getBoundingClientRect(); return r.left >= mark.right || r.top >= mark.bottom || r.right <= mark.left; });
    }), 'nav (phone): no button lies over the site name');
    await page.keyboard.press('Escape');
    await cards.nth(2).locator('[data-track-menu]').click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    const sheet = await box('#track-menu');
    check(Math.round(sheet.l) === 0 && Math.round(sheet.r) === 390 && Math.abs(sheet.b - 844) < 2,
      'track menu (phone): a bottom sheet across the screen');
    await videoSeen(page, 'track menu (phone, sheet open)');
    await shot(page, 'track-menu-phone');
    await page.keyboard.press('Escape');
    await page.click('[data-player-minimise]');
    const pill = await box('#player');
    check(pill.r <= 390 && pill.l >= 0 && pill.b - pill.t < 70, 'player (phone): minimised to a pill');
    check(errors.length === 0, `player (phone): no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Short phones, both languages, repeat off and on (its label is longer and can wrap the queue
  // header): the queue and the track menu still end below the moved video.
  for (const [vp, lang, repeat] of [[{ width: 375, height: 667 }, '', false], [{ width: 375, height: 667 }, 'cs/', true],
    [{ width: 320, height: 568 }, '', true], [{ width: 320, height: 568 }, 'cs/', false]]) {
    const name = `${vp.width}x${vp.height} ${lang ? 'cs' : 'en'}${repeat ? ', repeat on' : ''}`;
    const { context, page, errors } = await open(browser, at(lang), vp, 'light', {}, true);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const cards = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') });
    await cards.nth(0).locator('[data-play]').click();
    for (let i = 1; i <= 6; i++) await cards.nth(i).locator('[data-queue]').click();
    await page.waitForFunction(() => window.SonicPlayer.state().queue.length === 7, null, { timeout: 10000 });
    await page.waitForSelector('#player-panel iframe', { timeout: 30000 }).catch(() => {});
    await page.click('[data-player-queue]');
    if (repeat) await page.click('#player-queue [data-player-repeat]'); // shows its own toast
    else await page.evaluate(() => window.SonicPlayer.notify('A toast while the queue is open'));
    await videoSeen(page, `player (${name}, queue of 7 open, toast shown)`);
    await page.keyboard.press('Escape');
    await cards.nth(2).locator('[data-track-menu]').click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    await videoSeen(page, `track menu (${name}, sheet open)`);
    check(errors.length === 0, `player (${name}): no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Between phone and desktop, and on a landscape phone: the video beside the open queue stays
  // whole and on screen, the queue's header stays on screen, and a toast moves off the video.
  for (const vp of [{ width: 700, height: 800 }, { width: 667, height: 375 }, { width: 844, height: 390 }]) {
    const name = `${vp.width}x${vp.height}`;
    const { context, page, errors } = await open(browser, at(''), vp, 'light', {}, true);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const cards = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') });
    await cards.nth(0).locator('[data-play]').click();
    await cards.nth(1).locator('[data-queue]').click();
    await page.waitForSelector('#player-panel iframe', { timeout: 30000 }).catch(() => {});
    if (await page.evaluate(() => document.documentElement.dataset.playerVideoState !== 'large')) await page.click('[data-player-size]');
    await page.evaluate(() => window.SonicPlayer.notify('A toast over a large video'));
    await videoSeen(page, `player (${name}, large video, toast shown)`);
    await page.click('[data-player-queue]');
    await page.evaluate(() => window.SonicPlayer.notify('A toast with the queue open'));
    await videoSeen(page, `player (${name}, large video, queue open, toast shown)`);
    const qTop = await page.evaluate(() => document.getElementById('player-queue').getBoundingClientRect().top);
    check(qTop >= 0, `player (${name}): the open queue's header is on screen (top ${Math.round(qTop)})`);
    check(errors.length === 0, `player (${name}): no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Desktop: the track menu never lands on the docked video, opened from the card nearest to it.
  {
    const { context, page, errors } = await open(browser, at(''), desktop, 'light', {}, true);
    await page.waitForFunction(() => document.documentElement.dataset.explorerState === 'ready');
    const cards = page.locator('#explorer-grid [data-track]:not([hidden])').filter({ has: page.locator('[data-play]') });
    await cards.nth(0).locator('[data-play]').click();
    await page.waitForSelector('#player-panel iframe', { timeout: 30000 }).catch(() => {});
    const nearest = await page.evaluate(() => {
      const v = document.getElementById('player-panel').getBoundingClientRect();
      let best = -1, dist = Infinity;
      document.querySelectorAll('#explorer-grid [data-track]:not([hidden]) [data-track-menu]').forEach((b, i) => {
        const r = b.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight) return;
        const d = Math.hypot(r.left - v.left, r.top - v.top);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    });
    await page.locator('#explorer-grid [data-track]:not([hidden]) [data-track-menu]').nth(Math.max(0, nearest)).click();
    await page.waitForSelector('#track-menu:not([hidden])', { timeout: 5000 });
    await videoSeen(page, 'track menu (desktop, opened from the card nearest the video)');
    check(errors.length === 0, `track menu (desktop): no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // A review page's labelled Play button is a Pause button while its own track plays.
  {
    const { context, page, errors } = await open(browser, at(sample.path), desktop, 'light', {}, true);
    const bar = page.locator('main [data-track-actions]').filter({ has: page.locator('[data-play-radio]') }).first();
    const label = () => bar.locator('[data-play]').evaluate((b) => b.innerText.trim());
    const idle = await label();
    await bar.locator('[data-play]').click();
    await page.waitForFunction(() => document.documentElement.dataset.playerState === 'playing', null, { timeout: 30000 }).catch(() => {});
    const playing = await label();
    check(idle !== playing && playing.length > 0, `track page: the Play button reads ${JSON.stringify(playing)} while its track plays (was ${JSON.stringify(idle)})`);
    check(errors.length === 0, `track page player: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
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

  // The listening guide seeks the player through a real guide button, as a reader does: the first
  // teaching review whose guide has a timed point is opened, its button clicked, the player starts
  // the track there (calling SonicPlayer.seek directly passed with the button's dispatch deleted;
  // a review, 2026-11-14).
  {
    const { context, page } = await open(browser, 'about:blank', desktop, 'light', {}, true);
    // Few guides carry times (3 of 321 on 2026-11-14): the review is found in the content's front
    // matter (an `at = "m:ss"` inside extra.learning.listen_for), not by opening pages.
    const content = path.join(__dirname, '..', '..', 'content');
    const timed = fs.readdirSync(content).filter((f) => f.endsWith('.md') && !f.endsWith('.cs.md'))
      .filter((f) => /listen_for\s*=\s*\[[^\]]*\bat\s*=\s*"\d/.test(fs.readFileSync(path.join(content, f), 'utf8')));
    const found = catalog.tracks.find((t) => t.youtube && timed.includes(t.source)) || null;
    if (found) await page.goto(at(found.path), { waitUntil: 'load' });
    if (!found) {
      check(false, 'education: some teaching review has a timed listening point to seek');
    } else {
      const guide = page.locator(`[data-seek="${found.source}"]`).first();
      const when = (await guide.getAttribute('data-seek-at')) || '0:00';
      const seconds = when.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
      await guide.click();
      const src = await page.waitForSelector('#player-panel iframe', { timeout: 10000 }).then((e) => e.getAttribute('src')).catch(() => '');
      check(new RegExp(`[?&]start=${seconds}(&|$)`).test(src) && src.includes(found.youtube),
        `education: a listening guide button seeks the player to its time (${found.source} ${when} = ${seconds} s)`);
    }
    await context.close();
  }

  // Yearbooks (ADR 0005): when the corpus has any, the list and each year serve, every reviewed
  // item links to its review, and the counts are the catalogue's.
  if (catalog.yearbooks && catalog.yearbooks.length) {
    const { context, page, errors } = await open(browser, at('yearbook/'), desktop);
    check((await page.locator('[data-yearbook]').count()) === catalog.yearbooks.length, `yearbooks: the list shows all ${catalog.yearbooks.length}`);
    for (const b of catalog.yearbooks) {
      await page.goto(at(`yearbook/${b.year}/`), { waitUntil: 'load' });
      // In order, each item what the catalogue says: a review's row (its source, linking to its
      // page) or the item's own row. Counts alone passed a list rendered in reverse.
      const expected = b.tracks.map((i) => (i.source && catalog.lookup[i.source] !== undefined
        ? `${i.source} ${catalog.tracks[catalog.lookup[i.source]].path}` : `n-${i.n}`));
      const shown = await page.locator('#yearbook-list > li').evaluateAll((lis, site) => lis.map((li) => {
        if (!li.dataset.source) return li.id;
        const a = li.querySelector('a[href]');
        const rel = a && a.href.startsWith(site) ? a.href.slice(site.length).split(/[?#]/)[0] : '';
        return `${li.dataset.source} ${rel.replace(/^cs\//, '')}`;
      }), base);
      const first = shown.findIndex((x, k) => x !== expected[k]);
      check(shown.length === b.items && first < 0,
        `yearbook ${b.year}: ${b.items} items in order, each linked to its review` + (first < 0 ? '' : ` (item ${first + 1}: ${shown[first]} where ${expected[first]})`));
    }
    check(errors.length === 0, `yearbooks: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // Genre families (data/genres.toml through catalog.genre_families): every scene is reachable
  // from the sidebar, the home page, the explorer and the family chart, never hidden behind the
  // umbrella terms that outnumber it (techno, jungle and dub were on no page but their own,
  // 2026-11-22). The home page shows every yearbook, not the first four.
  if (catalog.genre_families && catalog.genre_families.length) {
    const fams = catalog.genre_families;
    const { context, page, errors } = await open(browser, at(''), desktop);
    check((await page.locator('section:has(#home-yearbooks) [data-yearbook]').count()) === (catalog.yearbooks || []).length,
      `home: every yearbook is shown (${(catalog.yearbooks || []).length})`);
    const side = await page.locator('#sidebar a[href*="/genre/#family-"]').evaluateAll((as) => as.map((a) => a.hash.slice(8)));
    check(side.join() === fams.map((f) => f.id).join(), `sidebar: every genre family, umbrella last (${side.join(', ')})`);
    const groups = await page.locator('#explorer-genre optgroup').evaluateAll((gs) => gs.map((g) => g.querySelectorAll('option').length));
    check(groups.join() === fams.map((f) => f.terms.length).join(), `explorer: the genre options are grouped by family (${groups.length} groups)`);
    const scene = fams.find((f) => !f.umbrella && f.terms.length > 1) || fams[0];
    const term = scene.terms[scene.terms.length - 1].term;
    await page.selectOption('#explorer-genre', term);
    await page.waitForFunction((t) => new URL(location.href).searchParams.get('genre') === t, term, { timeout: 10000 })
      .then(() => check(true, `explorer: a grouped option filters (${term})`), () => check(false, `explorer: a grouped option filters (${term})`));
    await page.selectOption('#explorer-genre', '');
    // The family chart: a click on a bar opens that family on the genre index, through the router.
    // The chart lists the families bottom-up, so its top bar (the highest index) is the first family.
    await page.locator('#home-genres').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.echarts && window.echarts.getInstanceByDom(document.getElementById('home-genres')), null, { timeout: 20000 });
    const bar = await page.evaluate((n) => {
      const el = document.getElementById('home-genres');
      const [x, y] = window.echarts.getInstanceByDom(el).convertToPixel({ seriesIndex: 0 }, [1, n]);
      const r = el.getBoundingClientRect();
      return { x: r.left + x, y: r.top + y };
    }, fams.length - 1);
    await page.mouse.click(bar.x, bar.y);
    await page.waitForFunction(() => location.pathname.endsWith('/genre/'), null, { timeout: 15000 }).catch(() => {});
    const opened = await page.evaluate(() => location.pathname + location.hash);
    check(opened.endsWith(`/genre/#family-${fams[0].id}`), `family chart: a bar opens the family on the genre index (${opened})`);
    // The genre index: one section per family, each holding exactly the family's terms.
    const sections = await page.locator('section[id^="family-"]').evaluateAll((ss) => ss.map((s) => [s.id.slice(7), s.querySelectorAll('a[href*="/genre/"]').length]));
    check(sections.map((s) => s[0]).join() === fams.map((f) => f.id).join()
      && sections.every(([id, n]) => n === fams.find((f) => f.id === id).terms.length),
      `genre index: ${fams.length} family sections, each with its terms`);
    check(await page.isVisible(`#family-${fams[0].id} a[href$="/genre/${fams[0].terms[0].slug}/"]`), 'genre index: a family links its terms');
    // A term's page names its family and links every sibling.
    await page.goto(at(`genre/${scene.terms[0].slug}/`), { waitUntil: 'load' });
    const nav = await page.evaluate(() => {
      const a = document.getElementById('family-nav');
      return a ? { hash: a.hash, siblings: a.parentElement.querySelectorAll('a[href*="/genre/"]:not(#family-nav)').length } : null;
    });
    check(nav && nav.hash === `#family-${scene.id}` && nav.siblings === scene.terms.length,
      `genre term: ${scene.terms[0].term} names its family and links its ${scene.terms.length} genres`);
    if (catalog.yearbooks && catalog.yearbooks.length) {
      const b = catalog.yearbooks[0];
      await page.goto(at(`yearbook/${b.year}/`), { waitUntil: 'load' });
      const yf = await page.locator('aside:not(#sidebar) a[href*="/genre/#family-"]').count();
      check(yf === b.families.length, `yearbook ${b.year}: its ${b.families.length} genre families, each linking the genre index`);
    }
    if (catalog.yearbooks && catalog.yearbooks.length > 1) {
      // The taste chart: a year x family heatmap of the yearbooks; a cell opens that year.
      await page.goto(at('yearbook/'), { waitUntil: 'load' });
      await page.locator('#chart-taste').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.echarts && window.echarts.getInstanceByDom(document.getElementById('chart-taste')), null, { timeout: 20000 });
      const built = await page.evaluate(seriesBuilt);
      check(built.some((c) => c.id === 'chart-taste' && c.built > 0), 'yearbooks: the taste chart is built by the shipped ECharts');
      const oldest = Math.min(...catalog.yearbooks.map((b) => b.year));
      const cell = await page.evaluate(() => {
        const el = document.getElementById('chart-taste');
        const [x, y] = window.echarts.getInstanceByDom(el).convertToPixel({ seriesIndex: 0 }, [0, 0]);
        const r = el.getBoundingClientRect();
        return { x: r.left + x, y: r.top + y };
      });
      await page.mouse.click(cell.x, cell.y);
      await page.waitForFunction((y) => location.pathname.endsWith(`/yearbook/${y}/`), oldest, { timeout: 15000 }).catch(() => {});
      check(new URL(page.url()).pathname.endsWith(`/yearbook/${oldest}/`), `taste chart: a cell opens its yearbook (${new URL(page.url()).pathname})`);
    }
    check(errors.length === 0, `genre families: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  // A review's contents (page.toc and the educational parts it has): every chip leads to a part
  // of this page; a yearbook position on a review leads to that row of the yearbook (only
  // unresolved rows had the anchor, 2026-11-22); the Czech home page links stay in Czech.
  {
    const t = catalog.tracks.find((x) => x.yearbooks && x.yearbooks.length && x.related && x.related.length) || catalog.tracks[0];
    const { context, page, errors } = await open(browser, at(t.path), desktop);
    const chips = await page.locator('[data-contents] a').evaluateAll((as) => as.map((a) => {
      const id = decodeURIComponent(a.hash.slice(1));
      return { id, ok: a.pathname === location.pathname && !!document.getElementById(id) };
    }));
    check(chips.length > 2 && chips.every((c) => c.ok),
      `track contents: ${chips.length} chips, each a part of this page${chips.some((c) => !c.ok) ? ' — ' + chips.filter((c) => !c.ok).map((c) => c.id).join(', ') : ''}`);
    const lastChip = chips[chips.length - 1];
    await page.locator('[data-contents] a').last().click();
    await page.waitForFunction((id) => location.hash === '#' + id, lastChip.id, { timeout: 5000 }).catch(() => {});
    const seen = await page.evaluate((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight;
    }, lastChip.id);
    check(seen, `track contents: a chip scrolls its part into view (#${lastChip.id})`);
    if (t.yearbooks && t.yearbooks.length) {
      const y = t.yearbooks[0];
      await page.goto(at(`yearbook/${y.year}/#n-${y.n}`), { waitUntil: 'load' });
      check(await page.evaluate((s) => { const li = document.getElementById(location.hash.slice(1)); return !!li && li.dataset.source === s; }, t.source),
        `yearbook ${y.year}: #n-${y.n} is the row of ${t.source}`);
    }
    await page.goto(at('cs/'), { waitUntil: 'load' });
    const english = await page.locator('main a[href]').evaluateAll((as, site) => as.map((a) => a.href)
      .filter((h) => h.startsWith(site) && /\/(genre|sentiment|concept)\/$/.test(h) && !h.startsWith(site + 'cs/')), base);
    check(english.length === 0, `cs home: facet and glossary links stay in Czech${english.length ? ' — ' + english.join(', ') : ''}`);
    check(errors.length === 0, `contents and anchors: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }

  await wcag(browser, desktop, new Set(catalog.tracks.map((t) => t.path)));
  if (process.env.SMOKE_SWEEP !== '0') await sweep(browser);
  return done(browser);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
