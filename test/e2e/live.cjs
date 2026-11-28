#!/usr/bin/env node
// Live delivery check of one review on production, in a real browser: a song is done when this
// passes (add-song, "Done = live"; the owner's order of 2026-11-28: not done until verified in a
// browser through Playwright on the delivery).
//
//   node test/e2e/live.cjs <slug> [--expect <sha>] [--base URL] [--out dir]
//   npm run live -- <slug> --expect <sha>
//
// Every expectation is derived from this checkout's static/data/catalog.json and the review's
// front matter, never typed in: the page's path in each language, its video, its concepts, its
// curated connections and the reviews that link back to it (connections and related tracks),
// its versions (each row with its still, each id present; a live page without the versions
// section yet falls back to finding each id anywhere on the page), each language's social card
// (og/<page path slugified>.jpg), the search indexes. revision.txt must start with --expect when
// given; while production serves another commit than this checkout's, a backlink from a review
// production does not have yet is skipped, not failed. Each language is opened on a
// desktop (1440 px) and a phone (390 px); screenshots go to --out (default: a temporary
// directory). Exit 0 pass, 1 a failure, 2 usage, 3 skipped (playwright-core not installed).
// CHROME_PATH=<binary> uses that browser instead of Playwright's chromium.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BASE = 'https://korczis.github.io/sonic-playground';
// Third-party frames (the YouTube player, its ads and fonts) are not the site's console.
const FOREIGN = /youtube|ytimg|doubleclick|googlevideo|google\.com|gstatic/i;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
];

function usage(message) {
  if (message) console.error(`live: ${message}`);
  console.error('usage: node test/e2e/live.cjs <slug> [--expect <sha>] [--base URL] [--out dir]');
  process.exit(2);
}

function args(argv) {
  const out = { slug: '', expect: '', base: DEFAULT_BASE, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--expect' || a === '--base' || a === '--out') {
      if (!argv[i + 1]) usage(`${a} needs a value`);
      out[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (!out.slug) out.slug = a.replace(/\.md$/, '').replace(/\/$/, '');
    else usage(`one slug only (got ${a})`);
  }
  if (!out.slug) usage('a review slug is required');
  out.base = out.base.replace(/\/+$/, '');
  return out;
}

// The sources named in a front matter's `connections = [ ... ]` (an inline array of tables).
function connections(text) {
  const front = (text.split(/^\+\+\+\s*$/m)[1]) || '';
  const block = front.match(/^connections = \[([\s\S]*?)^\]/m);
  return block ? [...block[1].matchAll(/source = "([^"]+\.md)"/g)].map((m) => m[1]) : [];
}

// The social card of a page, named as templates/base.html names it: the page path slugified,
// in the format of static/data/images.json (data/media.toml [social]).
function socialImage(pagePath) {
  const media = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/data/images.json'), 'utf8'));
  const ext = media.social.format === 'jpeg' ? 'jpg' : media.social.format;
  const key = pagePath.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
  return `og/${key}.${ext}`;
}

// The commit this checkout is at, to tell a page the checkout has and production not yet.
function head() {
  try {
    return require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

// What production must show for the review, from the checkout's data.
function expectations(slug) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'static/data/catalog.json'), 'utf8'));
  const source = `${slug}.md`;
  const track = catalog.tracks.find((t) => t.source === source);
  if (!track) usage(`${source} is not in static/data/catalog.json`);
  const bySource = new Map(catalog.tracks.map((t) => [t.source, t]));
  const slugOf = new Map(catalog.concepts.map((c) => [c.term, c.slug]));
  const own = connections(fs.readFileSync(path.join(ROOT, 'content', source), 'utf8'))
    .filter((s) => bySource.has(s));
  const back = new Set();
  for (const file of fs.readdirSync(path.join(ROOT, 'content'))) {
    if (!/^[^.]+\.md$/.test(file) || file === source || !bySource.has(file)) continue;
    if (connections(fs.readFileSync(path.join(ROOT, 'content', file), 'utf8')).includes(source)) back.add(file);
  }
  for (const t of catalog.tracks) {
    if (t.source !== source && (t.related || []).some((r) => r.source === source)) back.add(t.source);
  }
  const langs = track.langs || ['en'];
  return {
    track,
    source,
    langs,
    paths: Object.fromEntries(langs.map((l) => [l, l === 'en' ? track.path : track.i18n[l].path])),
    titles: Object.fromEntries(langs.map((l) => [l, l === 'en' ? track.title : track.i18n[l].title])),
    social: Object.fromEntries(langs.map((l) => [l, socialImage(l === 'en' ? track.path : track.i18n[l].path)])),
    concepts: (track.facets.concept || []).map((term) => slugOf.get(term)).filter(Boolean),
    connections: own.map((s) => bySource.get(s).path),
    backlinks: [...back].sort().map((s) => bySource.get(s).path),
    versions: track.versions || [],
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const want = expectations(opts.slug);
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (e) {
    console.log('live: playwright-core not installed (npm ci); skipped');
    process.exit(3);
  }
  const out = opts.out || fs.mkdtempSync(path.join(os.tmpdir(), `live-${opts.slug}-`));
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const check = (ok, what) => {
    results.push({ ok: !!ok, what });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  };
  const skip = (what) => {
    results.push({ ok: true, skipped: true, what });
    console.log(`SKIP ${what}`);
  };
  const bust = () => `?live=${Date.now()}`;
  const url = (p) => `${opts.base}/${p}`;

  console.log(`live: ${want.source} on ${opts.base} (${want.langs.join(', ')}; ` +
    `${want.versions.length} version(s), ${want.concepts.length} concept(s), ` +
    `${want.connections.length} connection(s), ${want.backlinks.length} backlink(s)); screenshots ${out}`);

  const revision = await fetch(url(`revision.txt${bust()}`)).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (opts.expect) {
    check(revision.trim().startsWith(opts.expect), `revision.txt serves ${opts.expect} (got ${revision.trim().slice(0, 12) || 'nothing'})`);
  } else {
    skip(`revision.txt not compared (no --expect); production serves ${revision.trim().slice(0, 12) || 'nothing'}`);
  }
  // A checkout ahead of production names reviews production does not serve yet: a backlink from
  // one of them is skipped, not failed, until production serves this checkout's commit.
  const checkout = head();
  const deployed = !!checkout && revision.trim() === checkout;
  if (!deployed) {
    skip(`this checkout (${checkout.slice(0, 12) || 'no git'}) is not the commit production serves: ` +
      'a backlink from a review production lacks is skipped');
  }

  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launch);
  try {
    for (const lang of want.langs) {
      for (const vp of VIEWPORTS) {
        await page(browser, lang, vp);
      }
    }
    await resources();
    await backlinks();
  } finally {
    await browser.close();
  }

  async function page(b, lang, vp) {
    const tag = `${lang}/${vp.name}`;
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile });
    const p = await ctx.newPage();
    const errors = [];
    p.on('console', (m) => {
      if (m.type() === 'error' && !FOREIGN.test((m.location() || {}).url || '')) errors.push(m.text());
    });
    p.on('pageerror', (e) => errors.push(String(e)));
    const pagePath = want.paths[lang];
    const resp = await p.goto(url(pagePath) + bust(), { waitUntil: 'networkidle' }).catch((e) => ({ status: () => String(e) }));
    check(resp && resp.status() === 200, `${tag}: ${pagePath} answers 200 (${resp && resp.status()})`);
    const seen = await p.evaluate(() => {
      const attr = (s, a) => (document.querySelector(s) || { getAttribute: () => '' }).getAttribute(a) || '';
      const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try { return JSON.parse(s.textContent); } catch (e) { return null; }
      });
      const still = document.querySelector('[data-video] img');
      return {
        title: document.title,
        lang: document.documentElement.lang,
        desc: attr('meta[name="description"]', 'content'),
        ogType: attr('meta[property="og:type"]', 'content'),
        ogImage: attr('meta[property="og:image"]', 'content'),
        canonical: attr('link[rel="canonical"]', 'href'),
        hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => l.hreflang),
        ld,
        hrefs: [...document.querySelectorAll('main a[href]')].map((a) => a.href),
        html: document.documentElement.outerHTML,
        still: still ? { src: still.currentSrc || still.src, ok: still.complete && still.naturalWidth > 0 } : null,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    const title = want.titles[lang];
    check(seen.title.includes(want.track.track) || seen.title.includes(title), `${tag}: title "${seen.title}"`);
    check(seen.lang.startsWith(lang), `${tag}: html lang ${seen.lang}`);
    check(seen.desc.length >= 50, `${tag}: meta description (${seen.desc.length} chars)`);
    check(seen.ogType === 'music.song' && seen.ogImage.endsWith(`/${want.social[lang]}`),
      `${tag}: og:type ${seen.ogType}, og:image ${seen.ogImage}`);
    check(seen.canonical.endsWith(`/${pagePath}`), `${tag}: canonical ${seen.canonical}`);
    const hreflangMissing = want.langs.filter((l) => !seen.hreflang.includes(l));
    check(hreflangMissing.length === 0, `${tag}: hreflang ${seen.hreflang.join(',')}${hreflangMissing.length ? ' (missing ' + hreflangMissing.join(',') + ')' : ''}`);
    const flat = JSON.stringify(seen.ld);
    check(seen.ld.length > 0 && seen.ld.every(Boolean) && flat.includes('MusicRecording'), `${tag}: JSON-LD parses, MusicRecording`);
    const linked = (target) => seen.hrefs.some((h) => h.split(/[?#]/)[0].endsWith(`/${target}`));
    const prefix = lang === 'en' ? '' : `${lang}/`;
    const conceptsMissing = want.concepts.filter((c) => !linked(`${prefix}concept/${c}/`));
    check(conceptsMissing.length === 0, `${tag}: links its ${want.concepts.length} concept page(s)${conceptsMissing.length ? ' (missing ' + conceptsMissing.join(',') + ')' : ''}`);
    const connectionsMissing = want.connections.filter((c) => !seen.hrefs.some((h) => h.includes(`/${c}`)));
    check(connectionsMissing.length === 0, `${tag}: links its ${want.connections.length} connection(s)${connectionsMissing.length ? ' (missing ' + connectionsMissing.join(',') + ')' : ''}`);
    if (want.track.youtube) {
      check(seen.still && seen.still.ok, `${tag}: the video's still loaded (${seen.still ? seen.still.src : 'none'})`);
    }
    await versions(p, tag, seen.html);
    check(seen.overflow <= 1, `${tag}: no horizontal overflow (${seen.overflow}px)`);
    await p.screenshot({ path: path.join(out, `${lang}-${vp.name}-top.png`) });
    if (want.track.youtube) {
      // Play: the still turns into the youtube-nocookie player of the review's own video.
      await p.click('[data-video] [data-play]').catch(() => {});
      await p.waitForFunction(() => !!document.querySelector('iframe#player-video'), null, { timeout: 15000 }).catch(() => {});
      const src = await p.evaluate(() => (document.querySelector('iframe#player-video') || {}).src || '');
      check(src.includes('youtube-nocookie.com') && src.includes(want.track.youtube), `${tag}: plays ${want.track.youtube} (${src.slice(0, 80) || 'no player'})`);
      await p.waitForTimeout(1500);
      await p.screenshot({ path: path.join(out, `${lang}-${vp.name}-playing.png`) });
    }
    check(errors.length === 0, `${tag}: no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();
  }

  async function versions(p, tag, html) {
    if (!want.versions.length) return;
    const section = p.locator('section[aria-labelledby="versions-title"]');
    const keys = want.versions.map((v) => v.youtube || v.url);
    if (await section.count() === 0) {
      skip(`${tag}: no versions section on the live page yet; looking for the ids anywhere`);
      const missing = keys.filter((k) => !html.includes(k));
      check(missing.length === 0, `${tag}: every version (${keys.length}) appears on the page${missing.length ? ' (missing ' + missing.join(',') + ')' : ''}`);
      return;
    }
    await section.scrollIntoViewIfNeeded();
    // Stills below the fold load lazily: bring each into view, then wait for them all.
    for (const img of await section.locator('img').all()) await img.scrollIntoViewIfNeeded().catch(() => {});
    await p.waitForFunction(() => [...document.querySelectorAll('section[aria-labelledby="versions-title"] img')]
      .every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
    const rows = await section.evaluate((s) => ({
      html: s.innerHTML,
      stills: [...s.querySelectorAll('img')].map((i) => ({ src: i.currentSrc || i.src, srcset: i.srcset || '',
        ok: i.complete && i.naturalWidth > 0, sized: !!(i.getAttribute('width') && i.getAttribute('height') && i.getAttribute('sizes')) })),
    }));
    const missing = keys.filter((k) => !rows.html.includes(k));
    check(missing.length === 0, `${tag}: the versions section lists all ${keys.length}${missing.length ? ' (missing ' + missing.join(',') + ')' : ''}`);
    const stillOf = (id) => rows.stills.find((s) => s.src.includes(`/vi/${id}/`) || s.srcset.includes(`/vi/${id}/`));
    const shown = want.versions.filter((v) => v.youtube && !v.gone);
    const broken = shown.filter((v) => { const s = stillOf(v.youtube); return !s || !s.ok || !s.sized; }).map((v) => v.youtube);
    check(broken.length === 0, `${tag}: ${shown.length} version still(s) loaded with srcset, sizes, width and height${broken.length ? ' (not: ' + broken.join(',') + ')' : ''}`);
    const goneShown = want.versions.filter((v) => v.gone && stillOf(v.youtube)).map((v) => v.youtube);
    check(goneShown.length === 0, `${tag}: no still requested for a gone version${goneShown.length ? ' (' + goneShown.join(',') + ')' : ''}`);
    await p.screenshot({ path: path.join(out, `${tag.replace('/', '-')}-versions.png`) });
  }

  async function resources() {
    for (const lang of want.langs) {
      const og = want.social[lang];
      const r = await fetch(url(og + bust())).catch(() => null);
      check(r && r.ok && /^image\//.test(r.headers.get('content-type') || ''), `${og}: ${r ? r.status + ' ' + r.headers.get('content-type') : 'no answer'}`);
      const prefix = lang === 'en' ? '' : `${lang}/`;
      for (const c of want.concepts) {
        const res = await fetch(url(`${prefix}concept/${c}/${bust()}`)).catch(() => null);
        check(res && res.ok, `${prefix}concept/${c}/: ${res ? res.status : 'no answer'}`);
      }
      const index = `data/search${lang === 'en' ? '' : '.' + lang}.json`;
      const body = await fetch(url(index + bust())).then((x) => (x.ok ? x.json() : {})).catch(() => ({}));
      check(body.tracks && want.source in body.tracks, `${index} lists ${want.source}`);
    }
  }

  async function backlinks() {
    if (!want.backlinks.length) return skip('no review links to this one (no connection or related track names it)');
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    for (const from of want.backlinks) {
      const resp = await p.goto(url(from) + bust(), { waitUntil: 'domcontentloaded' }).catch(() => null);
      if (resp && resp.status() === 404 && !deployed) {
        skip(`${from} is not on production yet (404), so its link back to ${want.track.path} is not checked`);
        continue;
      }
      const n = resp && resp.ok() ? await p.locator(`main a[href*="/${want.track.path}"]`).count() : 0;
      check(n > 0, `${from} links back to ${want.track.path}${resp && resp.ok() ? '' : ` (${resp ? resp.status() : 'no answer'})`}`);
    }
    await ctx.close();
  }

  fs.writeFileSync(path.join(out, 'live.json'), JSON.stringify({ slug: opts.slug, base: opts.base, revision: revision.trim(), results }, null, 1));
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(`\nlive: ${results.length - failed - skipped}/${results.length - skipped} passed, ${skipped} skipped -> ${path.join(out, 'live.json')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`live: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
