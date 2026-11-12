// Social preview images (Open Graph / X cards), one per page, generated at build time.
//
//   node scripts/og.cjs <public dir> [<key>...]
//
// For every page of <public dir>/sitemap.xml (and the 404 page) it renders a 1200x630 card in a
// headless browser and writes <public dir>/og/<key>.png, where <key> is the page path slugified
// ("home" for the root) — the same key templates/base.html derives for og:image. A track's card
// shows its still, artist, track and genres; any other page shows its title, its description and
// a mosaic of the newest stills; the home page of each language, the one most shared, gets its
// pitch (seo.home_title) over a tilted wall of stills. Everything comes from the built page's own
// meta tags, the derived catalogue and the interface strings; nothing is written here but the
// layout. Exit 0 ok, 1 failure, 3 skipped (playwright-core not installed). Keys after the
// directory render only those cards (a quick look).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  console.log('og: playwright-core not installed (npm ci); skipped');
  process.exit(3);
}

const root = path.resolve(process.argv[2] || 'public');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const base = urls[0].replace(/\/?$/, '/').replace(/^(https?:\/\/[^/]+\/[^/]*\/?).*$/, '$1');
const prefix = new URL(base).pathname; // /sonic-playground/
const bySlug = {};
catalog.tracks.forEach((t) => { bySlug[t.path.replace(/\/$/, '')] = t; });
const site = 'Sonic Playground';
const s = catalog.stats;
const stats = `${s.tracks} tracks · ${s.artists} artists · ${s.genre_terms} genres`;
const host = new URL(base).host + prefix.replace(/\/$/, '');
const i18n = JSON.parse(fs.readFileSync(path.join(root, 'data/i18n.json'), 'utf8'));
const strings = i18n.locales[i18n.default].strings;
const only = new Set(process.argv.slice(3));
const icon = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'favicon.svg')).toString('base64');

function key(pagePath) {
  const rel = pagePath.slice(prefix.length).replace(/\/$/, '');
  if (!rel) return 'home';
  return rel.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function meta(html, prop) {
  const m = html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}
function still(t) {
  return t && t.youtube ? `https://i.ytimg.com/vi/${t.youtube}/hqdefault.jpg` : '';
}

const STYLE = `
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;font-family:Inter,'Segoe UI',Roboto,'DejaVu Sans',sans-serif;
  color:#fff;background:#030712}
.bg{position:absolute;inset:0;background:radial-gradient(ellipse at top left,#6d28d9,transparent 55%),
  radial-gradient(ellipse at bottom right,#9d174d,transparent 50%);opacity:.9}
.blur{position:absolute;inset:-40px;background-size:cover;background-position:center;filter:blur(28px);opacity:.35}
.wrap{position:relative;display:flex;gap:48px;align-items:center;height:100%;padding:64px}
.still{width:520px;height:292px;border-radius:24px;background:#111 center/cover;flex:none;
  box-shadow:0 30px 80px rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.12)}
.text{min-width:0}
.kicker{font-size:26px;font-weight:600;color:#c4b5fd;margin-bottom:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1{font-size:64px;line-height:1.04;font-weight:800;letter-spacing:-.02em;display:-webkit-box;-webkit-line-clamp:3;
  -webkit-box-orient:vertical;overflow:hidden}
p{margin-top:20px;font-size:26px;line-height:1.35;color:#d1d5db;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.chips{margin-top:26px;display:flex;flex-wrap:wrap;gap:10px}
.chip{font-size:20px;font-weight:600;padding:6px 14px;border-radius:999px;background:rgba(139,92,246,.28);color:#ede9fe}
.brand{position:absolute;left:64px;bottom:40px;display:flex;align-items:center;gap:14px;font-size:24px;font-weight:700}
.brand img{width:44px;height:44px}
.host{position:absolute;right:64px;bottom:46px;font-size:20px;color:#9ca3af}
.mosaic{display:grid;grid-template-columns:repeat(3,150px);gap:14px;flex:none}
.mosaic div{width:150px;height:150px;border-radius:18px;background:#111 center/cover;border:2px solid rgba(255,255,255,.1)}
.mosaic div:nth-child(2),.mosaic div:nth-child(5){transform:translateY(22px)}
.eq{position:absolute;left:0;right:0;bottom:0;height:120px;display:flex;align-items:flex-end;justify-content:center;gap:6px;opacity:.25}
.eq span{width:10px;border-radius:4px 4px 0 0;background:linear-gradient(#f472b6,#8b5cf6)}
.home .wrap{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:40px 64px 96px}
.home .text{width:720px}
.home .badge{display:inline-flex;align-items:center;gap:12px;font-size:24px;font-weight:700;padding:8px 18px 8px 8px;
  border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2)}
.home .badge img{width:40px;height:40px}
.home h1{margin-top:34px;font-size:78px;line-height:1.02;-webkit-line-clamp:4;max-width:640px}
.home h1 em{font-style:normal;display:block;background:linear-gradient(90deg,#c4b5fd,#f9a8d4,#fde68a);
  -webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:6px}
.home .chips{margin-top:30px;flex-wrap:nowrap}
.home .chip{font-size:20px;padding:7px 14px;white-space:nowrap;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18)}
.home .chip b{color:#f9a8d4}
.wall{position:absolute;top:-120px;right:-150px;width:640px;display:grid;grid-template-columns:repeat(3,196px);gap:16px;
  transform:rotate(-10deg)}
.wall div{height:196px;border-radius:22px;background:#111 center/cover;border:2px solid rgba(255,255,255,.12);
  box-shadow:0 20px 50px rgba(0,0,0,.5)}
.wall div:nth-child(3n+2){transform:translateY(60px)}
.fade{position:absolute;inset:0;background:linear-gradient(90deg,#030712 38%,rgba(3,7,18,.55) 62%,rgba(3,7,18,0) 82%)}
.home .host{color:#d1d5db}
`;

function eq() {
  return '<div class="eq">' + Array.from({ length: 64 }, (_, i) =>
    `<span style="height:${20 + Math.round(80 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)))}%"></span>`).join('') + '</div>';
}

function trackCard(t) {
  const img = still(t);
  const chips = t.facets.genre.slice(0, 3).concat(t.facets.sentiment.slice(0, 2))
    .map((g) => `<span class="chip">${esc(g)}</span>`).join('');
  return `<div class="bg"></div>${img ? `<div class="blur" style="background-image:url('${img}')"></div>` : ''}${eq()}
  <div class="wrap">
    <div class="still" style="${img ? `background-image:url('${img}')` : 'background:linear-gradient(135deg,#7c3aed,#9d174d)'}"></div>
    <div class="text"><div class="kicker">${esc(t.artist)}</div><h1>${esc(t.track)}</h1><div class="chips">${chips}</div></div>
  </div>
  <div class="brand"><img src="${icon}">${site}</div><div class="host">${esc(host)}</div>`;
}

function pageCard(title, description) {
  const tiles = catalog.tracks.filter((t) => t.youtube).slice(0, 6)
    .map((t) => `<div style="background-image:url('https://i.ytimg.com/vi/${t.youtube}/mqdefault.jpg')"></div>`).join('');
  return `<div class="bg"></div>${eq()}
  <div class="wrap">
    <div class="text" style="flex:1"><div class="kicker">${esc(title === site ? stats : site)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>
    <div class="mosaic">${tiles}</div>
  </div>
  <div class="brand"><img src="${icon}">${site}</div><div class="host">${esc(host)}</div>`;
}

function homeCard(code) {
  const str = i18n.locales[code].strings;
  // The pitch in two beats: its first sentence (or clause) plain, the rest in the accent.
  const [lead, accent] = (str['seo.home_title'] || site).split(/(?<=[.,])\s+/, 2);
  const tiles = catalog.tracks.filter((t) => t.youtube).slice(0, 15)
    .map((t) => `<div style="background-image:url('https://i.ytimg.com/vi/${t.youtube}/mqdefault.jpg')"></div>`).join('');
  const chips = [[s.tracks, 'home.stat_tracks'], [s.artists, 'home.stat_artists'], [catalog.concepts.length, 'home.stat_concepts']]
    .map(([n, k]) => `<span class="chip"><b>${n}</b> ${esc(str[k])}</span>`).join('');
  return `<div class="home"><div class="bg"></div><div class="wall">${tiles}</div><div class="fade"></div>${eq()}
  <div class="wrap"><div class="text">
    <div class="badge"><img src="${icon}">${site}</div>
    <h1>${esc(lead)}${accent ? `<em>${esc(accent)}</em>` : ''}</h1>
    <div class="chips">${chips}</div>
  </div></div>
  <div class="host" style="left:64px;right:auto">${esc(host)}${code === i18n.default ? '' : '/' + code}</div></div>`;
}

(async () => {
  const out = path.join(root, 'og');
  fs.mkdirSync(out, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launch);
  const pages = urls.map((u) => new URL(u).pathname).concat([prefix + '404']);
  let next = 0;
  let written = 0;
  async function worker() {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    while (next < pages.length) {
      const p = pages[next++];
      const k = p === prefix + '404' ? '404' : key(p);
      if (only.size && !only.has(k)) continue;
      const file = p === prefix + '404' ? path.join(root, '404.html') : path.join(root, p.slice(prefix.length), 'index.html');
      if (!fs.existsSync(file)) continue;
      const html = fs.readFileSync(file, 'utf8');
      const t = bySlug[p.slice(prefix.length).replace(/\/$/, '')];
      const homeOf = k === 'home' ? i18n.default : (k in i18n.locales && k !== i18n.default ? k : null);
      const body = homeOf ? homeCard(homeOf) : t ? trackCard(t) : pageCard(meta(html, 'og:title') || site, meta(html, 'og:description'));
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${STYLE}</style><body>${body}</body>`, { waitUntil: 'load' });
      // The pitch keeps to three lines whatever font the machine has: shrink it until it does.
      if (homeOf) {
        await page.evaluate(() => {
          const h1 = document.querySelector('.home h1');
          let size = parseFloat(getComputedStyle(h1).fontSize);
          while (h1.scrollHeight > size * 1.02 * 3 + 4 && size > 48) {
            size -= 2;
            h1.style.fontSize = size + 'px';
          }
        });
      }
      await page.screenshot({ path: path.join(out, k + '.png'), type: 'png' });
      written += 1;
    }
    await page.close();
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  await browser.close();
  console.log(`og: ${written} social cards in ${path.relative(process.cwd(), out) || out}`);
})().catch((e) => { console.error('og:', e.message); process.exit(1); });
