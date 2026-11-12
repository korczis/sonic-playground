// Vendors the pinned browser libraries out of node_modules into static/vendor/ so the site
// self-hosts them (no CDN). Versions come from package.json (exact pins) and are part of each
// file name; static/data/vendor.json maps a library to its file, and the templates read that
// manifest, so a version bump never edits a template.
//
// ECharts is not copied but built (esbuild) from exactly the modules data/echarts.json declares:
// the full bundle is 1.1 MB and the site draws three chart types. --check rebuilds it in memory
// and compares the bytes, and refuses a series type, option or renderer static/js/charts.js uses
// whose module is not declared, and a declared module charts.js does not use.
//
//   node scripts/vendor.mjs          copy bundles, licences and write static/data/vendor.json
//   node scripts/vendor.mjs --check  exit 1 when a vendored file differs from node_modules
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync }
  from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'static/vendor');
const MANIFEST = join(ROOT, 'static/data/vendor.json');
const LIBS = {
  flowbite: { bundle: 'dist/flowbite.min.js', licence: 'LICENSE.md', ext: 'min.js' },
  echarts: { build: true, licence: 'LICENSE', ext: 'custom.min.js' },
};

// What charts.js would show for each ECharts module: a series type, an option key, a renderer.
const SERIES = {
  bar: 'BarChart', line: 'LineChart', pie: 'PieChart', scatter: 'ScatterChart',
  effectScatter: 'EffectScatterChart', graph: 'GraphChart', heatmap: 'HeatmapChart',
  radar: 'RadarChart', tree: 'TreeChart', treemap: 'TreemapChart', sunburst: 'SunburstChart',
  sankey: 'SankeyChart', boxplot: 'BoxplotChart', candlestick: 'CandlestickChart',
  funnel: 'FunnelChart', gauge: 'GaugeChart', parallel: 'ParallelChart', lines: 'LinesChart',
  map: 'MapChart', pictorialBar: 'PictorialBarChart', themeRiver: 'ThemeRiverChart',
  custom: 'CustomChart',
};
const OPTIONS = {
  grid: 'GridComponent', tooltip: 'TooltipComponent', axisPointer: 'AxisPointerComponent',
  visualMap: 'VisualMapComponent', legend: 'LegendComponent', title: 'TitleComponent',
  dataZoom: 'DataZoomComponent', toolbox: 'ToolboxComponent', aria: 'AriaComponent',
  polar: 'PolarComponent', geo: 'GeoComponent', dataset: 'DatasetComponent',
  markLine: 'MarkLineComponent', markPoint: 'MarkPointComponent', markArea: 'MarkAreaComponent',
  timeline: 'TimelineComponent', calendar: 'CalendarComponent', graphic: 'GraphicComponent',
  brush: 'BrushComponent', singleAxis: 'SingleAxisComponent', parallelAxis: 'ParallelComponent',
};
const RENDERERS = { canvas: 'CanvasRenderer', svg: 'SVGRenderer' };

/** The modules static/js/charts.js needs, read from its code (comments excluded). */
export function neededModules(code) {
  const text = code.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const need = new Set();
  for (const [, type] of text.matchAll(/\btype:\s*'([a-zA-Z]+)'/g)) if (SERIES[type]) need.add(SERIES[type]);
  for (const [key, mod] of Object.entries(OPTIONS)) {
    if (new RegExp(`\\b${key}\\s*:|\\.${key}\\s*=`).test(text)) need.add(mod);
  }
  for (const [, r] of text.matchAll(/renderer:\s*'(canvas|svg)'/g)) need.add(RENDERERS[r]);
  return need;
}

/** The ECharts bundle of exactly the declared modules, as bytes (deterministic for one esbuild). */
async function buildEcharts(decl) {
  const all = [...decl.charts, ...decl.components, ...decl.renderers];
  const entry = [
    "import * as echarts from 'echarts/core';",
    `import { ${decl.charts.join(', ')} } from 'echarts/charts';`,
    `import { ${decl.components.join(', ')} } from 'echarts/components';`,
    `import { ${decl.renderers.join(', ')} } from 'echarts/renderers';`,
    `echarts.use([${all.join(', ')}]);`,
    'window.echarts = echarts;',
  ].join('\n');
  const out = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'js' }, bundle: true, minify: true,
    format: 'iife', target: 'es2019', legalComments: 'none', write: false, logLevel: 'error',
  });
  return Buffer.from(out.outputFiles[0].contents);
}
const DECL = JSON.parse(readFileSync(join(ROOT, 'data/echarts.json'), 'utf8'));

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const check = process.argv.includes('--check');
const plan = [];
const manifest = { schema: 'sonic-vendor/v1', libs: {} };

for (const [name, lib] of Object.entries(LIBS)) {
  const pinned = pkg.devDependencies[name];
  if (!/^\d+\.\d+\.\d+$/.test(pinned || '')) {
    console.error(`vendor: ${name} must be pinned to an exact version in package.json`);
    process.exit(1);
  }
  const installed = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (installed !== pinned) {
    console.error(`vendor: node_modules/${name} is ${installed}, package.json pins ${pinned}; `
      + 'run npm ci');
    process.exit(1);
  }
  const file = `${name}-${pinned}.${lib.ext}`;
  plan.push([lib.build ? await buildEcharts(DECL) : join('node_modules', name, lib.bundle), file]);
  plan.push([join('node_modules', name, lib.licence), `${name}-${pinned}.LICENSE.txt`]);
  manifest.libs[name] = { version: pinned, js: `vendor/${file}` };
}
const manifestText = JSON.stringify(manifest, null, 2) + '\n';

const bytes = (source) => (Buffer.isBuffer(source) ? source : readFileSync(join(ROOT, source)));
const label = (source) => (Buffer.isBuffer(source) ? 'its build from data/echarts.json' : source);

if (check) {
  let bad = 0;
  for (const [source, file] of plan) {
    const target = join(TARGET, file);
    if (!existsSync(target) || !readFileSync(target).equals(bytes(source))) {
      console.error(`vendor: static/vendor/${file} is missing or differs from ${label(source)}`);
      bad += 1;
    }
  }
  const declared = new Set([...DECL.charts, ...DECL.components, ...DECL.renderers]);
  const needed = neededModules(readFileSync(join(ROOT, 'static/js/charts.js'), 'utf8'));
  for (const mod of needed) {
    if (!declared.has(mod)) {
      console.error(`vendor: static/js/charts.js uses ${mod}, which data/echarts.json does not ship`);
      bad += 1;
    }
  }
  for (const mod of declared) {
    if (!needed.has(mod)) {
      console.error(`vendor: data/echarts.json ships ${mod}, which static/js/charts.js does not use`);
      bad += 1;
    }
  }
  const wanted = new Set(plan.map(([, f]) => f));
  for (const f of existsSync(TARGET) ? readdirSync(TARGET) : []) {
    if (!wanted.has(f) && f !== 'README.md') {
      console.error(`vendor: static/vendor/${f} is not a pinned library file`);
      bad += 1;
    }
  }
  if (!existsSync(MANIFEST) || readFileSync(MANIFEST, 'utf8') !== manifestText) {
    console.error('vendor: static/data/vendor.json is stale; run npm run vendor');
    bad += 1;
  }
  console.log(`vendor: ${plan.length} file(s) checked, ${bad} problem(s)`);
  process.exit(bad ? 1 : 0);
}

mkdirSync(TARGET, { recursive: true });
mkdirSync(dirname(MANIFEST), { recursive: true });
const wanted = new Set(plan.map(([, f]) => f));
for (const f of readdirSync(TARGET)) {
  if (!wanted.has(f) && f !== 'README.md') rmSync(join(TARGET, f));
}
for (const [source, file] of plan) {
  if (Buffer.isBuffer(source)) writeFileSync(join(TARGET, file), source);
  else copyFileSync(join(ROOT, source), join(TARGET, file));
  console.log(`vendor ${label(source)} -> static/vendor/${file} (${Math.round(bytes(source).length / 1024)} kB)`);
}
writeFileSync(MANIFEST, manifestText);
console.log('vendor: wrote static/data/vendor.json');
