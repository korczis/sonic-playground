// Vendors the pinned browser libraries out of node_modules into static/vendor/ so the site
// self-hosts them (no CDN). Versions come from package.json (exact pins) and are part of each
// file name; static/data/vendor.json maps a library to its file, and the templates read that
// manifest, so a version bump never edits a template.
//
//   node scripts/vendor.mjs          copy bundles, licences and write static/data/vendor.json
//   node scripts/vendor.mjs --check  exit 1 when a vendored file differs from node_modules
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync }
  from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'static/vendor');
const MANIFEST = join(ROOT, 'static/data/vendor.json');
const LIBS = {
  flowbite: { bundle: 'dist/flowbite.min.js', licence: 'LICENSE.md', ext: 'min.js' },
};

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
  plan.push([join('node_modules', name, lib.bundle), file]);
  plan.push([join('node_modules', name, lib.licence), `${name}-${pinned}.LICENSE.txt`]);
  manifest.libs[name] = { version: pinned, js: `vendor/${file}` };
}
const manifestText = JSON.stringify(manifest, null, 2) + '\n';

if (check) {
  let bad = 0;
  for (const [source, file] of plan) {
    const target = join(TARGET, file);
    if (!existsSync(target) || !readFileSync(target).equals(readFileSync(join(ROOT, source)))) {
      console.error(`vendor: static/vendor/${file} is missing or differs from ${source}`);
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
  copyFileSync(join(ROOT, source), join(TARGET, file));
  console.log(`vendor ${source} -> static/vendor/${file}`);
}
writeFileSync(MANIFEST, manifestText);
console.log('vendor: wrote static/data/vendor.json');
