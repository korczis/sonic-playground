#!/usr/bin/env bash
# The local servers' port and host (scripts/port.mjs, serve.mjs, dev.mjs): the flag beats
# SONIC_PORT, which beats package.json "config", which beats the default; a value that is no port
# is refused with exit 2, naming it and its source; --port 0 serves on a free port and prints it;
# a port something already holds is refused with exit 1, naming the port, its holder and how to
# choose another. serve.mjs answers files with their type, maps config.toml's base_url path,
# redirects directories and the bare path, answers 404 with the site's page, and keeps requests
# inside its directory. dev.mjs hands zola serve the resolved port (a fake zola records it). The
# real scripts run from their real paths, so Node's coverage of them counts under the gate.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/serve-port.XXXXXX")" && pwd -P)
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
# The binary itself, not a version manager's shim: one case runs it with a PATH that has no zola.
node=$(node -p process.execPath)
serve="$root/scripts/serve.mjs"
dev="$root/scripts/dev.mjs"
fail() { echo "FAIL serve-port: $1" >&2; exit 1; }
unset SONIC_PORT SONIC_HOST

# The resolution itself, called as the scripts call it.
ROOT="$root" WORK="$work" "$node" --input-type=module -e '
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const root = process.env.ROOT;
const p = await import(`${root}/scripts/port.mjs`);
const { basePath } = await import(`${root}/scripts/serve.mjs`);
const config = { port: 4003, host: "10.0.0.3" };
assert.deepEqual(p.resolvePort({ port: "4001" }, { SONIC_PORT: "4002" }, config),
  { port: 4001, source: "--port" });
assert.deepEqual(p.resolvePort({}, { SONIC_PORT: "4002" }, config), { port: 4002, source: "SONIC_PORT" });
assert.deepEqual(p.resolvePort({}, { SONIC_PORT: "" }, config),
  { port: 4003, source: "package.json config.port" });
assert.deepEqual(p.resolvePort({}, {}, { port: "4004" }).port, 4004);
assert.deepEqual(p.resolvePort({}, {}, {}), { port: 1111, source: "the default" });
assert.equal(p.resolvePort({ port: "0" }, {}, {}).port, 0);
assert.equal(p.resolvePort({ port: "65535" }, {}, {}).port, 65535);
assert.deepEqual(p.resolveHost({ host: "::1" }, { SONIC_HOST: "h2" }, config), { host: "::1", source: "--host" });
assert.equal(p.resolveHost({}, { SONIC_HOST: "h2" }, config).source, "SONIC_HOST");
assert.equal(p.resolveHost({}, {}, config).host, "10.0.0.3");
assert.deepEqual(p.resolveHost({}, {}, {}), { host: "127.0.0.1", source: "the default" });
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
assert.deepEqual(p.readConfig(), pkg.config);
assert.equal(p.resolvePort({}, {}).port, pkg.config.port);
assert.equal(p.resolvePort({}).source, "package.json config.port");
assert.equal(p.resolveHost().host, pkg.config.host);
writeFileSync(`${process.env.WORK}/bare.json`, "{}");
assert.deepEqual(p.readConfig(`${process.env.WORK}/bare.json`), {});
for (const bad of ["abc", "-1", "65536", "80.5", "", " ", "1e3", "99999999"]) {
  assert.throws(() => p.resolvePort({ port: bad }, {}, {}),
    (e) => e instanceof p.InputError && e.message.includes("from --port") && e.message.includes("0-65535")
      && e.message.includes("SONIC_PORT=<n>"));
}
assert.throws(() => p.resolvePort({}, {}, { port: 70000 }), /70000 from package.json config.port/);
assert.throws(() => p.resolveHost({}, { SONIC_HOST: "a b" }, {}), /"a b" from SONIC_HOST is not a host/);
assert.deepEqual(p.options(["--port", "5", "--drafts", "--host=h", "x", "--port=6"], ["port", "host"]),
  { values: { port: "6", host: "h" }, rest: ["--drafts", "x"] });
assert.throws(() => p.options(["--port"], ["port"]), /--port needs a value/);
assert.throws(() => p.options(["--port", "--host", "h"], ["port", "host"]), /--port needs a value/);
assert.equal(p.url("0.0.0.0", 8, "/a/"), "http://127.0.0.1:8/a/");
assert.equal(p.url("::", 8), "http://[::1]:8/");
assert.equal(p.url("localhost", 8), "http://localhost:8/");
assert.equal(p.holder(1, "win32"), null);
const net = (await import("node:net")).default;
const probe = net.createServer();
const port = await p.listen(probe, "127.0.0.1", 0);
await new Promise((done) => probe.close(done));
assert.equal(p.holder(port), null);
assert.equal(await p.answers("127.0.0.1", port), false);
assert.match(p.busy("127.0.0.1", port, ""), new RegExp(`^port ${port} on 127.0.0.1 is already in use; choose`));
assert.equal(basePath(), new URL(/^base_url\s*=\s*"([^"]+)"/m.exec(readFileSync(`${root}/config.toml`, "utf8"))[1]).pathname.replace(/\/?$/, "/"));
writeFileSync(`${process.env.WORK}/bare.toml`, "title = \"x\"\n");
assert.throws(() => basePath(`${process.env.WORK}/bare.toml`), /has no base_url/);
writeFileSync(`${process.env.WORK}/root.toml`, "base_url = \"https://example.invalid\"\n");
assert.equal(basePath(`${process.env.WORK}/root.toml`), "/");
' || fail "the resolution (scripts/port.mjs)"
echo "ok   serve-port: flag > SONIC_PORT > package.json config > default, for the port and the host"

# Refusals of bad input: exit 2, the value and its source named.
expect() { # <exit code> <text the output must hold> <command...>
  local want=$1 text=$2; shift 2
  local code=0
  "$@" > "$work/out" 2>&1 || code=$?
  [ "$code" -eq "$want" ] || fail "$* exited $code, not $want: $(cat "$work/out")"
  grep -qF -- "$text" "$work/out" || fail "$* did not say '$text': $(cat "$work/out")"
}
expect 2 'serve: the port "abc" from --port is not an integer 0-65535' "$node" "$serve" --port abc
expect 2 'from --port is not an integer' "$node" "$serve" --port=70000
expect 2 'serve: --port needs a value' "$node" "$serve" --port
expect 2 'the port "-5" from SONIC_PORT' env SONIC_PORT=-5 "$node" "$serve"
expect 2 'the host "a/b" from --host is not a host name' "$node" "$serve" --host a/b
expect 2 'serve: unknown argument --nope' "$node" "$serve" --nope
expect 2 'no built site at' "$node" "$serve" --dir "$work/absent" --port 0
expect 0 'usage: node scripts/serve.mjs' "$node" "$serve" --help
expect 2 'dev: the port "x" from SONIC_PORT' env SONIC_PORT=x "$node" "$dev"
echo "ok   serve-port: a value that is no port or host is refused (exit 2), named with its source"

# A site with a page, a style, a sub-directory, an unknown type, its 404 page, and a file outside it.
site="$work/site"
mkdir -p "$site/sub" "$site/assets"
printf '<p>home</p>\n' > "$site/index.html"
printf '<p>sub</p>\n' > "$site/sub/index.html"
printf 'body{}\n' > "$site/assets/app.css"
printf '{"a":1}\n' > "$site/assets/data.json"
printf 'raw\n' > "$site/assets/blob.bin"
printf '<p>missing page</p>\n' > "$site/404.html"
printf 'secret\n' > "$work/outside.txt"

# Starts serve.mjs in the background and waits for the URL it prints (into $url).
start() { # <log> <args...>
  local log=$1; shift
  "$node" "$serve" "$@" > "$log" 2>&1 &
  pids+=($!)
  pid=$!
  url=""
  for _ in $(seq 1 150); do
    url=$(sed -n 's/^serve: \(http[^ ]*\) .*/\1/p' "$log")
    [ -n "$url" ] && return 0
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  fail "serve.mjs $* printed no URL: $(cat "$log")"
}
stop() { kill -TERM "$pid"; local code=0; wait "$pid" || code=$?; [ "$code" -eq 0 ] || fail "serve.mjs ended with $code on SIGTERM"; }
get() { # <url>: sets $status, the headers in $work/head and the body in $work/body
  status=$(curl -s --noproxy '*' --path-as-is -o "$work/body" -D "$work/head" -w '%{http_code}' "$1")
}
header() { grep -i "^$1:" "$work/head" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

# Under config.toml's base path, on a free port (--port 0).
base=$("$node" --input-type=module -e "import('$serve').then((m) => console.log(m.basePath()))")
start "$work/serve.log" --dir "$site" --base --port 0
port=$(sed -E 's|^http://[^:]+:([0-9]+)/.*|\1|' <<<"$url")
[ "$port" -gt 0 ] || fail "--port 0 printed no port: $url"
[ "$url" = "http://127.0.0.1:$port$base" ] || fail "the URL printed is not the one served: $url"
grep -qF "($site)" "$work/serve.log" || fail "the directory served is printed: $(cat "$work/serve.log")"
origin="http://127.0.0.1:$port"
get "$url"
[ "$status" = 200 ] && grep -q home "$work/body" || fail "the base path serves index.html: $status"
[ "$(header Content-Type)" = 'text/html; charset=utf-8' ] || fail "html type: $(header Content-Type)"
[ "$(header Cache-Control)" = no-store ] || fail "responses are no-store"
get "${url}assets/app.css"
[ "$status" = 200 ] && [ "$(header Content-Type)" = 'text/css; charset=utf-8' ] || fail "css: $status $(header Content-Type)"
grep -q 'body{}' "$work/body" || fail "the css body"
get "${url}assets/data.json"
[ "$(header Content-Type)" = application/json ] || fail "json type: $(header Content-Type)"
get "${url}assets/blob.bin"
[ "$status" = 200 ] && [ "$(header Content-Type)" = application/octet-stream ] || fail "unknown type: $(header Content-Type)"
get "${url}sub?x=1"
[ "$status" = 301 ] && [ "$(header Location)" = "${base}sub/?x=1" ] || fail "a directory redirects to its slash: $status $(header Location)"
get "${url}sub/"
[ "$status" = 200 ] && grep -q sub "$work/body" || fail "a sub-directory serves its index.html"
get "$origin/"
[ "$status" = 302 ] && [ "$(header Location)" = "$base" ] || fail "/ redirects to the base path: $status $(header Location)"
get "$origin${base%/}"
[ "$status" = 302 ] && [ "$(header Location)" = "$base" ] || fail "the base without its slash redirects: $status"
get "${url}nope.html"
[ "$status" = 404 ] && grep -q 'missing page' "$work/body" || fail "a missing file is 404 with 404.html: $status"
get "$origin/elsewhere/index.html"
[ "$status" = 404 ] || fail "a path outside the base is 404: $status"
get "${url}..%2f..%2foutside.txt"
[ "$status" = 404 ] && ! grep -q secret "$work/body" || fail "a request escaping the directory is 404: $status"
get "${url}a%00b"
[ "$status" = 404 ] || fail "a NUL in the path is 404: $status"
get "${url}%E0%A4%A"
[ "$status" = 400 ] || fail "a malformed escape is 400: $status"
stop
echo "ok   serve-port: --port 0 serves on a free port it prints; files with their type under the base path"
echo "ok   serve-port: directories and the bare path redirect, missing is 404, nothing outside is served"

# Without --base, at /; without a 404.html, a plain 404. The port from SONIC_PORT, then the flag.
rm "$site/404.html"
freeport() { "$node" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
p1=$(freeport)
p2=$(freeport)
SONIC_PORT="$p1" start "$work/env.log" --dir "$site"
[ "$url" = "http://127.0.0.1:$p1/" ] || fail "SONIC_PORT chooses the port: $url"
get "$url"
[ "$status" = 200 ] && grep -q home "$work/body" || fail "/ serves index.html without --base"
get "${url}nope"
[ "$status" = 404 ] && grep -q 'Not found' "$work/body" || fail "a plain 404 without 404.html: $status"
stop
SONIC_PORT="$p1" start "$work/flag.log" --dir "$site" --port="$p2"
[ "$url" = "http://127.0.0.1:$p2/" ] || fail "--port beats SONIC_PORT: $url"
stop
echo "ok   serve-port: SONIC_PORT chooses the port, --port beats it; a site without 404.html answers plainly"

# A port something already holds: exit 1, the port, its source, its holder and the way out.
"$node" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))" > "$work/held" &
holder=$!
pids+=($holder)
for _ in $(seq 1 100); do [ -s "$work/held" ] && break; sleep 0.1; done
held=$(cat "$work/held")
[ -n "$held" ] || fail "the occupying server did not start"
expect 1 "serve: port $held (from --port) on 127.0.0.1 is already in use" "$node" "$serve" --dir "$site" --port "$held"
grep -qF -- '--port <n>, SONIC_PORT=<n> or "config": {"port": <n>} in package.json' "$work/out" \
  || fail "the refusal says how to choose another port: $(cat "$work/out")"
if command -v lsof > /dev/null; then
  grep -qF "by node (pid $holder)" "$work/out" || fail "the refusal names the holder: $(cat "$work/out")"
fi
expect 1 "port $held (from SONIC_PORT) on 127.0.0.1 is already in use" env SONIC_PORT="$held" "$node" "$serve" --dir "$site"
expect 1 "dev: port $held (from --port) on 127.0.0.1 is already in use" "$node" "$dev" --port "$held"
expect 1 'serve: cannot listen on 192.0.2.1:0' "$node" "$serve" --dir "$site" --host 192.0.2.1 --port 0
echo "ok   serve-port: a port in use is refused (exit 1) with its source, its holder and how to choose another"

# A fake zola: `build` writes a page naming its --base-url, `serve` records its arguments.
bin="$work/bin"
mkdir -p "$bin"
cat > "$bin/zola" <<'ZOLA'
#!/usr/bin/env bash
cmd=$1; shift
if [ "$cmd" = build ]; then
  [ "${FAKE_ZOLA_FAIL:-0}" = 1 ] && { echo "zola: build failed" >&2; exit 1; }
  while [ $# -gt 0 ]; do
    case $1 in --base-url) b=$2; shift ;; --output-dir) o=$2; shift ;; esac; shift
  done
  mkdir -p "$o" && printf '<p>built for %s</p>\n' "$b" > "$o/index.html"
else
  printf '%s\n' "$cmd $*" > "$FAKE_ZOLA_LOG"
  exit "${FAKE_ZOLA_EXIT:-0}"
fi
ZOLA
chmod +x "$bin/zola"

# --build: the site is built for this server's own URL, then served under the base path.
PATH="$bin:$PATH" start "$work/build.log" --build --port 0 --dir "$work/built"
get "$url"
[ "$status" = 200 ] && grep -qF "built for ${url%/}" "$work/body" || fail "--build builds for the URL served: $(cat "$work/body")"
stop
expect 1 'serve: Command failed: zola build' env PATH="$bin:$PATH" FAKE_ZOLA_FAIL=1 "$node" "$serve" --build --port 0 --dir "$work/built"
echo "ok   serve-port: --build builds the site for the URL it serves; a failed build exits 1"

# dev.mjs: zola serve gets the resolved port and host and every other argument; its status is dev's.
export FAKE_ZOLA_LOG="$work/zola.args"
expect 0 'dev: zola serve at http://127.0.0.1:' env PATH="$bin:$PATH" "$node" "$dev" --port 0 --drafts
grep -qE '^serve --port [1-9][0-9]* --interface 127.0.0.1 --drafts$' "$FAKE_ZOLA_LOG" || fail "dev passes the port: $(cat "$FAKE_ZOLA_LOG")"
p3=$(freeport)
expect 0 "dev: zola serve at http://127.0.0.1:$p3/" env PATH="$bin:$PATH" SONIC_PORT="$p3" "$node" "$dev"
[ "$(cat "$FAKE_ZOLA_LOG")" = "serve --port $p3 --interface 127.0.0.1" ] || fail "dev takes SONIC_PORT: $(cat "$FAKE_ZOLA_LOG")"
expect 3 'dev: zola serve at' env PATH="$bin:$PATH" FAKE_ZOLA_EXIT=3 "$node" "$dev" --port 0
expect 1 'dev: cannot run zola' env PATH="$work/empty" "$node" "$dev" --port 0
echo "ok   serve-port: npm run dev hands zola serve the resolved port, and exits with zola's status"
