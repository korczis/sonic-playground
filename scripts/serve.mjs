// A static server for a built site, for looking at a build on this machine: zero dependencies,
// nothing deploys it, and the site itself stays static (rule project.site-static-serverless).
// It answers as GitHub Pages does: a directory by its index.html, a directory named without its
// trailing slash by a redirect to it, anything missing by 404 with the site's 404.html. Every
// response is no-store, so a rebuild shows on the next reload.
//
// The port and host come from the flag, SONIC_PORT / SONIC_HOST, package.json "config", or the
// default (1111, 127.0.0.1), in that order (scripts/port.mjs). --port 0 takes a free port. The
// URL it serves is printed once it listens; a port already in use is refused with what holds it.
//
// --base serves the site under the path of config.toml's base_url (/sonic-playground/), as
// production does; / and the path without its slash redirect there. --build first builds the
// site into --dir with base_url pointing at this server, so every link and asset stays local
// (zola writes absolute URLs, and a production build's would lead to the live site); it implies
// --base.
//
//   node scripts/serve.mjs                       public/ at http://127.0.0.1:1111/
//   node scripts/serve.mjs --dir <dir> --base    a production build, under /sonic-playground/
//   node scripts/serve.mjs --build --port 0      built for a free port, then served (preview)
//   SONIC_PORT=4000 npm run serve                the port from the environment
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, ROOT, listen, options, resolveHost, resolvePort, run, url } from './port.mjs';

const USAGE = 'usage: node scripts/serve.mjs [--dir <built site>] [--port <n>] [--host <h>] '
  + '[--base] [--build]';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.wasm': 'application/wasm',
};
const NOT_FOUND = '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found</p>\n';

/** The path config.toml's base_url names ("/sonic-playground/"), always ending in a slash. */
export function basePath(file = join(ROOT, 'config.toml')) {
  const m = /^base_url\s*=\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'));
  if (!m) throw new InputError(`${file} has no base_url`);
  return new URL(m[1]).pathname.replace(/\/?$/, '/');
}

/**
 * The request handler: the files under root, at the URL path base.
 * @param {string} root an absolute directory @param {string} base a path ending in "/"
 * @returns {import('node:http').RequestListener}
 */
export function site(root, base) {
  // A name the file system refuses (too long, not readable) is a file that is not there, never a
  // crash of the server; a symbolic link is followed only while it stays under root (a review,
  // 2026-11-23).
  const look = (path) => {
    try {
      return statSync(path, { throwIfNoEntry: false });
    } catch (e) {
      return undefined;
    }
  };
  const under = (path) => {
    let real, top;
    try {
      real = realpathSync(path); top = realpathSync(root);
    } catch (e) { return false; } // untested: the file was found a moment before; only a race with its removal lands here
    return real === top || real.startsWith(top + sep);
  };
  return (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    const missing = () => {
      const page = join(root, '404.html');
      const found = statSync(page, { throwIfNoEntry: false });
      send(404, { 'Content-Type': TYPES['.html'] }, found ? readFileSync(page) : NOT_FOUND);
    };
    const { pathname, search } = new URL(req.url, 'http://localhost');
    let name;
    try {
      name = decodeURIComponent(pathname);
    } catch (e) {
      return send(400, { 'Content-Type': TYPES['.txt'] }, 'Bad request: not a valid URL path\n');
    }
    if (base !== '/' && (name === '/' || `${name}/` === base)) {
      return send(302, { Location: base + search }, '');
    }
    const file = join(root, name.slice(base.length));
    const inside = file === root || file.startsWith(root + sep);
    if (!name.startsWith(base) || name.includes('\0') || !inside) return missing();
    const stat = look(file);
    if (stat && stat.isDirectory() && !name.endsWith('/')) {
      return send(301, { Location: `${pathname}/${search}` }, '');
    }
    const target = stat && stat.isDirectory() ? join(file, 'index.html') : file;
    if (!look(target)?.isFile() || !under(target)) return missing();
    const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    return send(200, { 'Content-Type': type }, readFileSync(target));
  };
}

async function main(argv) {
  const { values, rest } = options(argv, ['port', 'host', 'dir']);
  if (rest.includes('--help')) return console.log(USAGE);
  const unknown = rest.find((a) => a !== '--base' && a !== '--build');
  if (unknown !== undefined) throw new InputError(`unknown argument ${unknown}; ${USAGE}`);
  const build = rest.includes('--build');
  const base = build || rest.includes('--base') ? basePath() : '/';
  const { host } = resolveHost(values);
  const { port: asked, source } = resolvePort(values);
  const root = resolve(values.dir || join(ROOT, 'public'));
  if (!build && !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new InputError(`no built site at ${root}; run npm run build, pass --dir <dir>, `
      + 'or build one for this server with --build (npm run preview)');
  }
  const server = createServer(site(root, base));
  const port = await listen(server, host, asked, source);
  const address = url(host, port, base);
  if (build) {
    execFileSync('zola', ['build', '--force', '--base-url', address.replace(/\/$/, ''),
      '--output-dir', root], { cwd: ROOT, stdio: 'inherit' });
  }
  console.log(`serve: ${address} (${root})`);
  // A signal ends the process through exit, so Node's coverage of a test run is written.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run('serve', () => main(process.argv.slice(2)));
}
