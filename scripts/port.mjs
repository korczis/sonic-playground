// The port and host of the local servers (scripts/dev.mjs, scripts/serve.mjs), resolved the same
// way for both, so a port another server already holds is changed in one place and never by
// editing a script. Each value comes from the first of these that gives it:
//
//   1. the flag            --port <n>, --port=<n>, --host <h>, --host=<h>
//   2. the environment     SONIC_PORT, SONIC_HOST (an empty value counts as unset)
//   3. the configuration   "config": {"port": <n>, "host": "<h>"} in package.json (npm also
//                          exposes it to its scripts as npm_package_config_port)
//   4. the default         1111 (zola serve's own) and 127.0.0.1 (this machine only)
//
// A port is an integer 0-65535; 0 asks the system for a free one, and the server prints the port
// it was given. Anything else is refused before a socket opens, naming the value and where it
// came from. A port something already answers on is refused too, fast, with what holds it where
// lsof can tell (darwin, linux) and how to choose another. On macOS a socket bound to 0.0.0.0
// does not stop another from binding 127.0.0.1 with the same port, so binding alone can succeed
// while the URL printed reaches the other server (a probe once got 401 from an unrelated local
// server that way): the port is first tried as a client, at the address the URL names.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 1111;
export const DEFAULT_HOST = '127.0.0.1';
const CHOOSE_PORT = 'choose another with --port <n>, SONIC_PORT=<n> or "config": {"port": <n>} '
  + 'in package.json (--port 0 takes a free one)';
const CHOOSE_HOST = 'choose another with --host <h>, SONIC_HOST=<h> or "config": {"host": "<h>"} '
  + 'in package.json';

/** A value the caller gave that cannot be used: the scripts exit 2 on it, not 1. */
export class InputError extends Error {}

/**
 * The named options' values (`--name <v>` or `--name=<v>`) and every other argument, in order.
 * @param {string[]} argv @param {string[]} names
 * @returns {{values: Record<string, string>, rest: string[]}}
 */
export function options(argv, names) {
  const values = /** @type {Record<string, string>} */ ({});
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m || !names.includes(m[1])) {
      rest.push(argv[i]);
    } else if (m[2] !== undefined) {
      values[m[1]] = m[2];
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new InputError(`--${m[1]} needs a value`);
      }
      values[m[1]] = next;
      i += 1;
    }
  }
  return { values, rest };
}

/** package.json's "config" object ({} when it has none). */
export function readConfig(file = join(ROOT, 'package.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).config || {};
}

// The first candidate that gives a value, with the name of where it came from.
function first(candidates) {
  return candidates.find(([value]) => value !== undefined && value !== null);
}

/**
 * The port to serve on and where it came from: flag, then SONIC_PORT, then config, then 1111.
 * @param {{port?: string}} flags @param {Record<string, string|undefined>} env
 * @param {{port?: number|string}} config
 * @returns {{port: number, source: string}}
 */
export function resolvePort(flags = {}, env = process.env, config = readConfig()) {
  const [value, source] = first([[flags.port, '--port'],
    [env.SONIC_PORT || undefined, 'SONIC_PORT'], [config.port, 'package.json config.port'],
    [DEFAULT_PORT, 'the default']]);
  const text = String(value).trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) {
    throw new InputError(`the port ${JSON.stringify(value)} from ${source} is not an integer `
      + `0-65535; ${CHOOSE_PORT}`);
  }
  return { port: Number(text), source };
}

/**
 * The host to bind and where it came from: flag, then SONIC_HOST, then config, then 127.0.0.1.
 * @param {{host?: string}} flags @param {Record<string, string|undefined>} env
 * @param {{host?: string}} config
 * @returns {{host: string, source: string}}
 */
export function resolveHost(flags = {}, env = process.env, config = readConfig()) {
  const [value, source] = first([[flags.host, '--host'],
    [env.SONIC_HOST || undefined, 'SONIC_HOST'], [config.host, 'package.json config.host'],
    [DEFAULT_HOST, 'the default']]);
  const text = String(value).trim();
  if (!/^[\w.:%-]+$/.test(text)) {
    throw new InputError(`the host ${JSON.stringify(value)} from ${source} is not a host name or `
      + `address; ${CHOOSE_HOST}`);
  }
  return { host: text, source };
}

// The address a browser on this machine reaches a server bound to host at: a wildcard is reached
// through the loopback of its family.
function reachable(host) {
  return host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
}

/** The URL a server bound to host:port answers at, path included. */
export function url(host, port, path = '/') {
  const name = reachable(host);
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}${path}`;
}

/**
 * Who listens on the port, as lsof tells it ("node (pid 123)"); null where it cannot tell.
 * @param {number} port @param {string} platform
 */
export function holder(port, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  let out;
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    return null; // lsof is missing, or it found no listener (it exits 1)
  }
  const pid = /^p(\d+)$/m.exec(out);
  const command = /^c(.+)$/m.exec(out);
  return pid ? `${command ? command[1] : 'a process'} (pid ${pid[1]})` : null;
}

/** The refusal of a port in use: which port, from where, what holds it, how to choose another. */
export function busy(host, port, source) {
  const held = holder(port);
  return `port ${port}${source ? ` (from ${source})` : ''} on ${host} is already in use`
    + `${held ? ` by ${held}` : ''}; ${CHOOSE_PORT}`;
}

/** True when something already accepts a connection at the address the URL would name. */
export function answers(host, port, ms = 1000) {
  return new Promise((done) => {
    const socket = net.connect({ host: reachable(host), port });
    const end = (yes) => { socket.destroy(); done(yes); };
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
    socket.setTimeout(ms, () => end(false));
  });
}

/**
 * Binds the server to host:port, refusing a port in use; resolves with the port bound (the one
 * the system chose for 0).
 * @param {net.Server} server @param {string} host @param {number} port @param {string} [source]
 * @returns {Promise<number>}
 */
export async function listen(server, host, port, source = '') {
  if (port !== 0 && await answers(host, port)) throw new Error(busy(host, port, source));
  return new Promise((resolve, reject) => {
    server.once('error', (/** @type {NodeJS.ErrnoException} */ e) => reject(new Error(
      e.code === 'EADDRINUSE' ? busy(host, port, source)
        : `cannot listen on ${host}:${port}: ${e.message}`)));
    server.listen(port, host,
      () => resolve(/** @type {net.AddressInfo} */ (server.address()).port));
  });
}

/** Runs a script's main: an error is one line on stderr, exit 2 for bad input, else 1. */
export function run(who, main) {
  main().catch((e) => {
    console.error(`${who}: ${e.message}`);
    process.exit(e instanceof InputError ? 2 : 1);
  });
}
