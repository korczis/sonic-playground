// New code is tested (rule project.new-code-tested): every line a change adds or modifies in the
// site's code must have run under the tests, or carry a written reason why it cannot.
//
//   static/js/*.js      the browser smoke test's coverage (test/e2e/smoke.cjs SMOKE_COVERAGE)
//   scripts/*.mjs|cjs   Node's own coverage of the gate's runs (NODE_V8_COVERAGE)
//   scripts/*.py        the unit suite's coverage (test/pycov.py)
//
// The change is the diff from a base: COVERAGE_BASE when set (CI: the commit before the push),
// else the merge base with origin/main; where that is HEAD itself, HEAD when the working tree
// holds the change (a branch not yet committed), else HEAD's first parent (main after a merge,
// judged by everything the merge brings). Untracked files count whole.
//
// A line that cannot run under the tests says why, on itself or alone on the line above:
//   // untested: <reason>          (# untested: <reason> in Python)
// and a block between `// untested-begin: <reason>` and `// untested-end`. Every exemption is
// listed with its reason, so the count is visible in every run; a marker without a reason fails.
//
//   node scripts/coverage.mjs --browser <file> --node <dir> --python <file>
//   node scripts/coverage.mjs --no-browser ...   browser scripts left to the full gate (pre-push)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// COVERAGE_ROOT judges another repository with this script (test/cases/69 runs it on a fixture).
const ROOT = process.env.COVERAGE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const v8lines = require('../test/e2e/v8lines.cjs');

const JUDGED = [
  { kind: 'browser', test: (f) => /^static\/js\/[^/]+\.js$/.test(f) },
  { kind: 'node', test: (f) => /^scripts\/[^/]+\.(mjs|cjs)$/.test(f) },
  { kind: 'python', test: (f) => /^scripts\/[^/]+\.py$/.test(f) },
];

function git(args, quiet = false) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'] });
  } catch (e) {
    return null;
  }
}

/** The commit the change is measured from. */
export function base() {
  if (process.env.COVERAGE_BASE && git(['cat-file', '-e', `${process.env.COVERAGE_BASE}^{commit}`], true) !== null) {
    return process.env.COVERAGE_BASE;
  }
  const head = (git(['rev-parse', 'HEAD'], true) || '').trim();
  const mb = (git(['merge-base', 'origin/main', 'HEAD'], true) || '').trim();
  if (mb && mb !== head) return mb;
  const dirty = (git(['status', '--porcelain', '--', 'static/js', 'scripts'], true) || '').trim();
  if (mb && dirty) return head;
  const parent = (git(['rev-parse', 'HEAD^1'], true) || '').trim();
  return parent || null;
}

/** File -> the line numbers (1-based, in the working tree) the change adds or modifies. */
export function changedLines(from) {
  const out = new Map();
  const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', from, '--', 'static/js', 'scripts']);
  // A diff git could not make is no reading, never "nothing changed".
  if (diff === null) throw new Error(`git diff from ${from} failed`);
  let file = null;
  for (const line of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; continue; }
    if (line.startsWith('+++ /dev/null')) { file = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      const set = out.get(file) || new Set();
      for (let i = 0; i < n; i++) set.add(start + i);
      out.set(file, set);
    }
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'static/js', 'scripts']) || '';
  for (const file of untracked.split('\n').filter(Boolean)) {
    const n = readFileSync(join(ROOT, file), 'utf8').split('\n').length;
    out.set(file, new Set(Array.from({ length: n }, (_, i) => i + 1)));
  }
  return out;
}

/** Line -> its exemption's reason, from the markers in the source; markers without a reason. */
export function exemptions(source, python) {
  const c = python ? '#' : '//';
  // The marker is the line's trailing comment; one quoted in prose (between backticks) is not.
  const marker = new RegExp(`(?:^|[\\s;{}(),])${c}\\s*untested(-begin|-end)?(?::\\s*([^\`]+?))?\\s*$`);
  const lines = source.split('\n');
  const exempt = new Map();
  const bad = [];
  let block = null;
  lines.forEach((text, i) => {
    const m = marker.exec(text);
    const n = i + 1;
    if (m && m[1] === '-end') {
      if (block === null) bad.push(n); // an end without a begin
      block = null;
      return;
    }
    if (m && m[1] === '-begin') {
      if (!m[2] || !m[2].trim()) bad.push(n);
      block = (m[2] || '').trim();
      return;
    }
    if (block !== null) { exempt.set(n, block); return; }
    if (m) {
      if (!m[2] || !m[2].trim()) { bad.push(n); return; }
      exempt.set(n, m[2].trim());
      // A marker alone on its line covers the next line.
      if (text.trim().startsWith(c)) exempt.set(n + 1, m[2].trim());
    }
  });
  if (block !== null) bad.push(lines.length); // a block left open would exempt the rest of the file
  return { exempt, bad };
}

/** File -> { covered, uncovered } from Node's own coverage files. */
function nodeCoverage(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (e) { continue; }
    for (const entry of data.result || []) {
      if (!entry.url || !entry.url.startsWith('file://')) continue;
      const file = relative(ROOT, fileURLToPath(entry.url));
      if (!/^scripts\/[^/]+\.(mjs|cjs)$/.test(file)) continue;
      const source = readFileSync(join(ROOT, file), 'utf8');
      const state = v8lines.paint(source, entry.functions);
      const was = out.get(file);
      out.set(file, was ? v8lines.merge(was, state) : state);
    }
  }
  const lines = new Map();
  for (const [file, state] of out) lines.set(file, v8lines.lines(readFileSync(join(ROOT, file), 'utf8'), state));
  return lines;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
}

function main() {
  const from = base();
  if (!from) {
    console.error('coverage: no base to measure the change from (no origin/main, no parent)');
    process.exit(1);
  }
  const browser = arg('--browser') && existsSync(arg('--browser')) ? JSON.parse(readFileSync(arg('--browser'), 'utf8')) : null;
  const node = nodeCoverage(arg('--node'));
  const python = arg('--python') && existsSync(arg('--python')) ? JSON.parse(readFileSync(arg('--python'), 'utf8')) : null;
  const changed = changedLines(from);
  const missing = [];
  const listed = [];
  const unread = [];
  const skipped = new Set();
  let judged = 0;
  for (const [file, set] of [...changed].sort()) {
    const kind = (JUDGED.find((j) => j.test(file)) || {}).kind;
    if (!kind || !existsSync(join(ROOT, file))) continue;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const text = source.split('\n');
    const { exempt, bad } = exemptions(source, kind === 'python');
    for (const n of bad) missing.push(`${file}:${n}: an untested marker without a reason, or a block not closed`);
    let uncovered;
    if (kind === 'browser') {
      if (process.argv.includes('--no-browser')) { skipped.add(file); continue; }
      if (!browser) { unread.push('browser (--browser)'); continue; }
      uncovered = new Set((browser[file] || { uncovered: [] }).uncovered);
      // A script no page loaded is wholly unread: every executable changed line is uncovered.
      if (!browser[file]) text.forEach((t, i) => { if (!/^\s*(?:$|\/\/|\/\*|\*|[{}()[\];,]+\s*$)/.test(t)) uncovered.add(i + 1); });
    } else if (kind === 'node') {
      const lines = node.get(file);
      uncovered = new Set(lines ? lines.uncovered : []);
      if (!lines) text.forEach((t, i) => { if (!/^\s*(?:$|\/\/|\/\*|\*|[{}()[\];,]+\s*$)/.test(t)) uncovered.add(i + 1); });
    } else {
      if (!python) { unread.push('python (--python)'); continue; }
      if (!python[file]) { unread.push(`python (${file} is not in the reading)`); continue; }
      const p = python[file];
      const ran = new Set(p.executed);
      uncovered = new Set(p.executable.filter((n) => !ran.has(n)));
    }
    for (const n of set) {
      if (!uncovered.has(n)) continue;
      judged += 1;
      if (exempt.has(n)) listed.push(`${file}:${n}: untested: ${exempt.get(n)}`);
      else missing.push(`${file}:${n}: never ran under the tests: ${text[n - 1].trim().slice(0, 90)}`);
    }
  }
  for (const u of [...new Set(unread)]) missing.push(`no coverage reading for ${u}`);
  const total = [...changed].filter(([f]) => JUDGED.some((j) => j.test(f))).reduce((a, [, s]) => a + s.size, 0);
  for (const f of skipped) console.log(`skipped ${f}: no browser reading here (--no-browser); the full gate judges it`);
  for (const l of listed) console.log(`exempt  ${l}`);
  for (const m of missing) console.error(`missing ${m}`);
  console.log(`coverage: ${total} changed line(s) since ${from.slice(0, 12)}, ${judged} not run by the tests: ` +
    `${listed.length} exempt with a reason, ${missing.length} problem(s)`);
  process.exit(missing.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
