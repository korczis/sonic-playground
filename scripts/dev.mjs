// npm run dev's server: zola serve on the port and host scripts/port.mjs resolves (the flag,
// SONIC_PORT / SONIC_HOST, package.json "config", or 1111 and 127.0.0.1), so a port another
// server holds is changed without editing anything. The port is proved free first by holding it
// a moment (which also makes --port 0 a concrete free port), and a port in use is refused with
// what holds it, before zola starts. Every other argument goes to zola serve as it is.
//
//   npm run dev                          zola serve --port 1111 --interface 127.0.0.1
//   npm run dev -- --port 4000 --drafts  zola serve --port 4000 --interface 127.0.0.1 --drafts
//   SONIC_PORT=0 npm run dev             a free port, printed
//
// It exits with zola's status; Ctrl-C reaches zola, which ends both.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { ROOT, listen, options, resolveHost, resolvePort, run, url } from './port.mjs';

run('dev', async () => {
  const { values, rest } = options(process.argv.slice(2), ['port', 'host']);
  const { host } = resolveHost(values);
  const { port: asked, source } = resolvePort(values);
  const probe = net.createServer();
  const port = await listen(probe, host, asked, source);
  await new Promise((done) => probe.close(done));
  console.log(`dev: zola serve at ${url(host, port)}`);
  const zola = spawn('zola', ['serve', '--port', String(port), '--interface', host, ...rest],
    { cwd: ROOT, stdio: 'inherit' });
  /** @type {NodeJS.Signals[]} */
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, () => zola.kill(signal));
  zola.on('error', (e) => {
    console.error(`dev: cannot run zola (${e.message}); install the version in .zola-version`);
    process.exit(1);
  });
  zola.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
