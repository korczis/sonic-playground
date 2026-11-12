// majordomus-skill: fleet-flowbite-pro
// E2E smoke test of the built site in a real browser (scripts/verify.sh runs it after
// `zola build`; CI runs it before every deploy and against production).
//
//   node test/e2e/smoke.cjs <public dir> <port>      serve <public dir>, test it
//   node test/e2e/smoke.cjs --url <base url>          test a deployed site (production)
//
// The local build must have been made with --base-url http://127.0.0.1:<port>. Asserts:
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
const http = require('node:http');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.log('smoke: playwright-core not installed (npm ci); skipped');
  process.exit(3);
}

const args = process.argv.slice(2);
let base;
let root = null;
let server = null;
if (args[0] === '--url' && args[1]) {
  base = args[1].replace(/\/?$/, '/');
} else if (args.length >= 2) {
  root = path.resolve(args[0]);
  base = `http://127.0.0.1:${Number(args[1])}/`;
} else {
  console.error('usage: node test/e2e/smoke.cjs <public dir> <port> | --url <base url>');
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.txt': 'text/plain',
};

function serve(dir, port) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(dir, p);
      if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'content-type': TYPES['.html'] });
        res.end(fs.readFileSync(path.join(dir, '404.html')));
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

const failures = [];
const notices = new Set();
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

async function open(browser, url, viewport, colorScheme = 'light') {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  const origin = new URL(base).origin;
  // A failed resource is judged by its URL below (same origin fails, third party is a notice);
  // the browser's own 'Failed to load resource' line carries no URL, so it is not counted twice.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(origin)) errors.push(`request failed: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400 || r.url().includes('/nope-')) return;
    if (r.url().startsWith(origin)) errors.push(`HTTP ${r.status()}: ${r.url()}`);
    else notices.add(`HTTP ${r.status()}: ${r.url()}`);
  });
  const response = await page.goto(url, { waitUntil: 'load' });
  return { context, page, errors, response };
}

async function shot(page, name) {
  if (!process.env.SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

(async () => {
  if (root) await serve(root, Number(new URL(base).port));
  const catalog = await (await fetch(`${base}data/catalog.json`)).json();
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
    const { context, page, errors, response } = await open(browser, base + rel, desktop);
    const h1 = await page.locator('h1').first().textContent().catch(() => '');
    check(response && response.status() === 200 && h1.trim().length > 0, `${name}: 200 with an H1 ("${h1.trim().slice(0, 40)}")`);
    check(errors.length === 0, `${name}: no console or request errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);
    await context.close();
  }
  {
    const { context, response, page } = await open(browser, `${base}nope-${Date.now()}/`, desktop);
    check(response.status() === 404 && (await page.locator('h1').textContent()).includes('skipped'), '404 page served for an unknown path');
    await context.close();
  }

  // Explorer.
  {
    const { context, page, errors } = await open(browser, base, desktop);
    await page.waitForFunction(() => document.documentElement.dataset.explorer === 'ready');
    const visible = () => page.locator('[data-track]:not([hidden])').count();
    check((await page.locator('[data-track]').count()) === catalog.tracks.length, 'home renders one card per catalogue track');
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
    await page.selectOption('#explorer-sort', 'old');
    const first = await page.locator('[data-track]:not([hidden])').first().getAttribute('data-date');
    check(first === catalog.stats.first, `sort oldest first starts at ${catalog.stats.first}`);
    const deep = await open(browser, `${base}?genre=${encodeURIComponent(genre.term)}&sort=artist`, desktop);
    await deep.page.waitForFunction(() => document.documentElement.dataset.explorer === 'ready');
    check((await deep.page.locator('[data-track]:not([hidden])').count()) === genre.count, 'a filtered URL opens filtered');
    await deep.context.close();
    check(errors.length === 0, `explorer: no console errors${errors.length ? ' — ' + errors.join(' | ') : ''}`);

    // Theme toggle persists the Pro key.
    await page.click('#theme-toggle');
    const dark = await page.evaluate(() => [document.documentElement.classList.contains('dark'), localStorage.getItem('color-theme')]);
    check(dark[0] === true && dark[1] === 'dark', 'theme toggle switches to dark and stores color-theme');
    await shot(page, 'home-desktop-dark');
    await context.close();
  }

  // Track page: video and related tracks.
  {
    const { context, page, errors } = await open(browser, base + sample.path, desktop);
    check((await page.locator('aside[aria-label="About this track"] li').count()) === sample.related.length, `track: ${sample.related.length} related tracks listed`);
    await shot(page, 'track-desktop-light');
    await page.click('[data-video-play]');
    const src = await page.locator('[data-video] iframe').getAttribute('src');
    check(src && src.startsWith('https://www.youtube-nocookie.com/embed/' + sample.youtube), 'track: the still becomes a youtube-nocookie player');
    check(errors.filter((e) => !/youtube|google|doubleclick|ytimg/.test(e)).length === 0, 'track: no console errors of our own');
    await context.close();
  }

  // Phone width.
  for (const [name, rel] of [['home', ''], ['track', sample.path], ['insights', 'insights/']]) {
    const { context, page } = await open(browser, base + rel, phone, name === 'track' ? 'dark' : 'light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `${name} @390px: no horizontal overflow (${overflow}px)`);
    if (name === 'home') {
      await page.waitForFunction(() => window.FlowbiteInstances);
      await page.click('#toggleSidebarMobile');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => !document.getElementById('sidebar').classList.contains('-translate-x-full'));
      check(open, 'home @390px: the sidebar drawer opens');
      await shot(page, 'home-phone-drawer');
    } else {
      await shot(page, `${name}-phone`);
    }
    await context.close();
  }

  await browser.close();
  if (server) server.close();
  for (const n of notices) console.log(`note third-party ${n}`);
  console.log(failures.length ? `smoke: ${failures.length} failure(s)` : 'smoke: all checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  if (server) server.close();
  process.exit(1);
});
