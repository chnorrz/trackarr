---
name: live-test
description: Build the trackarr Docker image, run the container, and smoke-test all three providers (ext-to, 1337x, eztv) with fixed queries against the real live sites. Use when asked to live test, smoke test, verify against the real sites, check the providers still work, or confirm a change end to end in Docker. Covers an opt-in tinyproxy IPv6 fallback, used only when a provider hits a Cloudflare 1006 IP ban.
---

# Live testing trackarr

Verifies a build against the real trackers. Unit tests mock the browser
entirely, so they cannot catch selector drift, Cloudflare behaviour changes, or
proxy misrouting. This is the only check that does.

Hits real sites and solves real Cloudflare challenges from the user's IP. Say
so before starting, and do not run it unprompted.

## 0. Preconditions

```bash
docker version --format '{{.Server.Version}}'   # daemon reachable
git status --porcelain                          # know what is being tested
```

Run without the proxy first. `tinyproxy` is a fallback for one specific
failure (section 6), not part of the normal path.

## 1. Start from a clean slate

Do this every time, before building. A previous run may have been abandoned
without teardown, and a stale container or image silently invalidates the
whole test — the container keeps serving on 9117, so the queries in section 4
succeed against **old code** and the run looks green.

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | rg -i trackarr
docker images 'trackarr*' --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}'
```

Inspect that output before destroying anything: if a container is running that
the user started deliberately (a real deployment rather than a test), stop and
ask rather than removing it.

```bash
docker rm -f trackarr-live trackarr-tinyproxy 2>/dev/null
docker network rm trackarr-net 2>/dev/null      # Linux proxy path only
pkill -f tinyproxy 2>/dev/null                  # macOS proxy path only
docker rmi trackarr:live 2>/dev/null            # force a genuine rebuild
```

Also confirm nothing else holds the port, or `docker run` fails with a
confusing bind error:

```bash
lsof -nP -iTCP:9117 -sTCP:LISTEN 2>/dev/null || echo "9117 free"
```

Each image is ~3.2GB and they accumulate across runs. Check for orphans from
earlier sessions and clear them if the user agrees:

```bash
docker images 'trackarr*' --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}'
```

## 2. Build

Always build fresh — never reuse an image from a previous session, since it
cannot be assumed to match the current working tree.

```bash
docker build -t trackarr:live . > /tmp/trackarr-build.log 2>&1
echo "EXIT=$?"; tail -5 /tmp/trackarr-build.log
```

Takes several minutes on a cold cache: the builder downloads Camoufox
(~650MB) and Firefox's shared libraries. Final image is ~3.2GB.

Confirm the image is actually new rather than a silently reused layer set:

```bash
docker images trackarr:live --format '{{.CreatedSince}}'
```

## 3. Run

```bash
docker rm -f trackarr-live 2>/dev/null
docker run -d --name trackarr-live -p 9117:9117 \
  -e API_KEY=livetest \
  trackarr:live
sleep 12
docker logs trackarr-live 2>&1 | tail -5
```

Expect the listening banner. Xvfb needs a couple of seconds before the server
starts, so do not query immediately.

## 4. Fixed queries

Three providers, one stable query each. These are chosen to be well-seeded and
long-lived; do not swap them for topical terms, or a failure becomes ambiguous
between "provider broken" and "nothing matches".

| Provider | id       | Query    | Expected |
| -------- | -------- | -------- | -------- |
| ext.to   | `ext-to` | `matrix` | ~50 items, real seed counts |
| 1337x    | `1337x`  | `ubuntu` | ~50 items, real seed counts |
| EZTV     | `eztv`   | `matrix` | ~48 items, real seed counts |

All three providers report real seed counts from a keyword search. EZTV's
search rows carry seeds too (see `NOTES.md` section 16) — a low/zero
`seeded` count here means a selector regression, not expected behaviour.

```bash
for p in ext-to 1337x eztv; do
  case $p in ext-to|eztv) q=matrix;; 1337x) q=ubuntu;; esac
  printf '%-8s ' "$p"
  curl -sS --max-time 300 \
    "http://localhost:9117/$p/api?t=search&q=$q&apikey=livetest" \
    -o /tmp/$p.xml -w 'HTTP=%{http_code} ' 2>&1
  echo "items=$(rg -c '<item>' /tmp/$p.xml || echo 0)"
done
```

First query per hostname is slow (30-90s) while the challenge is solved.
Later ones are seconds.

### Checking the results properly

`HTTP=200` alone means nothing — Torznab reports failures as an error
document inside a 200 response:

```bash
rg -o '<error code="[0-9]+" description="[^"]*"' /tmp/*.xml
```

Item count alone is also not enough; a selector can drift and yield rows of
zeroes. Verify the payload:

```bash
node -e "
const fs=require('fs');
for (const p of ['ext-to','1337x','eztv']) {
  const x=fs.readFileSync('/tmp/'+p+'.xml','utf8');
  const items=x.split('<item>').slice(1);
  const bad=items.filter(i=>/<size>0</.test(i));
  const live=items.filter(i=>+(i.match(/name=\"seeders\" value=\"(\d+)\"/)||[0,0])[1]>0);
  console.log(p.padEnd(8), 'items='+items.length, 'zero-size='+bad.length, 'seeded='+live.length);
}
"
```

`zero-size` must be 0 for every provider.

`seeded` must be well above 0 for all three providers. A handful of
0-seeder items is normal — dead torrents exist. Check that `peers` is also
0 before suspecting the parser; genuine drift produces zeroes in *both*
columns across *all* rows. (EZTV has no leechers column at all, so its
`peers` always equals `seeders` — that is expected, not a bug.)

Then confirm one magnet resolves end to end:

```bash
DL=$(node -e "
const x=require('fs').readFileSync('/tmp/1337x.xml','utf8');
console.log(x.match(/<link>([^<]+)<\/link>/)[1].replace(/&amp;/g,'&'));
")
curl -sS --max-time 300 -o /dev/null -w '%{http_code} %{redirect_url}\n' "$DL" | head -c 120
```

Expect `302` and a `magnet:?xt=urn:btih:...` URI.

## 5. Triage a failure

Classify before acting. Only one of these is a proxy problem.

| Symptom | Meaning | Proxy helps? |
| --- | --- | --- |
| `error code: 1006` / `Access denied` | IP hard-banned | **Yes** — go to section 6 |
| `challenge did not clear after ...ms` | Lost a challenge race | No — retry, usually transient |
| 200 with `items=0` | Selector drift or genuinely no results | No — parser problem |
| `Target page, context or browser has been closed` | Browser died | No — retry; second request should recover |
| `zero-size` > 0 | Selector drift | No — parser problem |

Container logs carry the detail the XML does not:

```bash
docker logs trackarr-live 2>&1 | rg -i 'error|blocked|challenge|recycling' | tail -20
```

## 6. tinyproxy fallback — only for a 1006 hard block

Some trackers ban an IPv4 address while leaving IPv6 clean (currently 1337x).
The site then works in a desktop browser — macOS prefers IPv6 under RFC 6724 —
but fails from the container, which looks like fingerprinting or a parser bug.
Tunnelling through a proxy on the host sends traffic out over IPv6 instead.

### 6a. Confirm it really is a hard block

Do not skip this. Setting up the proxy for a challenge failure wastes time and
proves nothing.

```bash
curl -4 -s -m 15 -o /dev/null -w 'v4 http=%{http_code} bytes=%{size_download}\n' https://1337x.to/
curl -6 -s -m 15 -o /dev/null -w 'v6 http=%{http_code} bytes=%{size_download}\n' https://1337x.to/
curl -4 -s -m 15 https://1337x.to/ | head -c 200
```

Proceed **only** if IPv4 shows a ban and IPv6 does not. A ~17-byte body reading
`error code: 1006` is the ban. A 403 with a larger body is a Cloudflare
challenge, which is solvable and not a proxy problem.

Note the size check specifically: the terse 1006 body does **not** contain the
`banned your IP` string, so grepping for that phrase alone false-negatives.
`isBlocked()` in `lib/challenge.ts` matches `Access denied` + `Cloudflare`,
which the short body also misses.

If `dig +short AAAA 1337x.to` is empty there is no IPv6 at all, and the proxy
cannot help.

### 6b. macOS — tinyproxy on the host

```bash
brew install tinyproxy
tinyproxy -d -c tools/tinyproxy.conf > /tmp/tinyproxy.log 2>&1 &
lsof -nP -iTCP:8888 -sTCP:LISTEN | tail -1
```

`-d` keeps it in the foreground, so background it explicitly. The repo config
listens on 8888 and allows only loopback plus Docker/Colima ranges.

To watch it work, raise the log level on a copy rather than editing the repo
file:

```bash
sed 's/^LogLevel Warning/LogLevel Connect/' tools/tinyproxy.conf > /tmp/tinyproxy-verbose.conf
tinyproxy -d -c /tmp/tinyproxy-verbose.conf > /tmp/tinyproxy.log 2>&1 &
```

Verify the tunnel before touching the container:

```bash
curl -sS -o /dev/null -m 30 -x http://127.0.0.1:8888 \
  -w 'via proxy http=%{http_code}\n' https://1337x.to/
```

`403` is correct here — that is the challenge page, and it proves CONNECT
works. A timeout or `403 Forbidden` from tinyproxy itself means the allow-list
rejected the source.

### 6c. Linux — tinyproxy as a container

There is no host-proxy trick on Linux; run the sidecar instead. It needs its
own IPv6-enabled network.

```bash
docker network create --ipv6 \
  --subnet 172.28.99.0/24 \
  --subnet fd00:dead:beef:99::/64 \
  trackarr-net

docker run -d --name trackarr-tinyproxy --network trackarr-net \
  -e ALLOWED_SUBNET=172.28.99.0/24 \
  -e FORCE_IPV6=true \
  ghcr.io/chnorrz/trackarr-tinyproxy:latest
```

`ALLOWED_SUBNET` must match the network's IPv4 subnet or every request is
refused. `FORCE_IPV6` pins outgoing connections to the container's own IPv6
address, which is the entire point.

### 6d. Re-run the failed provider through the proxy

Recreate the container with both variables. `PROXY_URL` alone does nothing —
no host is proxied unless `DOMAIN_OVER_PROXY` also names it.

macOS:

```bash
docker rm -f trackarr-live 2>/dev/null
docker run -d --name trackarr-live -p 9117:9117 \
  -e API_KEY=livetest \
  -e PROXY_URL=http://host.docker.internal:8888 \
  -e DOMAIN_OVER_PROXY=1337x.to \
  trackarr:live
sleep 12
docker logs trackarr-live 2>&1 | rg 'proxying'
```

Linux: use `--network trackarr-net` and `-e PROXY_URL=http://trackarr-tinyproxy:8888`.

Expect `[cf] proxying [1337x.to] via <url>, direct otherwise.` Absence means
the PAC was never built and the proxy is inert.

**On macOS/Colima use `host.docker.internal`.** The Lima address `192.168.5.2`
is not routable from inside the container and will silently time out. Verify
if unsure:

```bash
docker exec trackarr-live node -e "
fetch('http://host.docker.internal:8888/',{signal:AbortSignal.timeout(8000)})
  .then(r=>console.log('reachable, http',r.status))
  .catch(e=>console.log('UNREACHABLE:',e.message));"
```

HTTP 500 means reachable — tinyproxy rejecting a non-proxy GET. A 403 means
the allow-list blocked you.

Then re-run only the provider that failed (section 4) and confirm the traffic
actually took the proxy:

```bash
rg -o 'CONNECT [a-z0-9.-]+:[0-9]+' /tmp/tinyproxy.log | sort | uniq -c
```

Only the `DOMAIN_OVER_PROXY` hosts may appear. Everything else — including
Cloudflare's own challenge assets, which can be IPv4-only — must stay direct,
and routing them through an IPv6-forced proxy would break them.

## 7. Optional: session recovery check

Worth running after changes to `lib/browser.ts`. Kills the browser underneath
a live session and confirms it recovers without orphaning a process.

```bash
PID=$(docker exec trackarr-live node -e "
const fs=require('fs');
console.log(fs.readdirSync('/proc').filter(d=>/^\d+$/.test(d))
  .find(p=>{try{return /camoufox|firefox/i.test(fs.readFileSync('/proc/'+p+'/comm','utf8'))}catch{return false}}));")
docker exec trackarr-live kill -9 "$PID"

curl -sS --max-time 300 'http://localhost:9117/1337x/api?t=search&q=fedora&apikey=livetest' -o /tmp/r1.xml -w 'req1 HTTP=%{http_code}\n'
curl -sS --max-time 300 'http://localhost:9117/1337x/api?t=search&q=fedora&apikey=livetest' -o /tmp/r2.xml -w 'req2 HTTP=%{http_code}\n'
rg -o '<error[^>]*>' /tmp/r1.xml | head -1
echo "req2 items=$(rg -c '<item>' /tmp/r2.xml || echo 0)"
```

Expected: request 1 returns `<error code="900" ... has been closed />`. The
second request usually succeeds, but can also fail the same way — Playwright's
`page.isClosed()` doesn't always reflect an external `kill -9` immediately,
so a request landing in that window takes the slower discard path
(`browserContext.newPage: ... has been closed`, not `page.goto: ...`) instead
of relaunching directly. Not a regression by itself; keep retrying until one
succeeds, then confirm exactly one browser process remains — more than one
would mean the old session leaked:

```bash
docker exec trackarr-live node -e "
const fs=require('fs');
console.log(fs.readdirSync('/proc').filter(d=>/^\d+$/.test(d))
  .filter(p=>{try{return /camoufox|firefox/i.test(fs.readFileSync('/proc/'+p+'/comm','utf8'))}catch{return false}}).length);"
```

## 8. Teardown

Always, including after a failure — a running container keeps solving
challenges on a keep-alive timer, and anything left behind will be mistaken
for a fresh build by the next run (section 1).

```bash
docker rm -f trackarr-live
pkill -f tinyproxy                                    # macOS
docker rm -f trackarr-tinyproxy; docker network rm trackarr-net   # Linux
rm -f /tmp/tinyproxy-verbose.conf /tmp/trackarr-build.log
docker rmi trackarr:live                              # ~3.2GB, do not keep it
```

Delete the image rather than keeping it around. It cannot be reused for a
later run — the next test must build from that run's working tree — and each
one costs ~3.2GB.

Confirm the system is actually clean:

```bash
docker ps -a --format '{{.Names}}' | rg -i trackarr || echo "no containers"
docker images 'trackarr*' --format '{{.Repository}}:{{.Tag}}' || echo "no images"
pgrep -fl tinyproxy || echo "tinyproxy not running"
```

## Reporting

State which providers passed with item counts, whether the proxy was needed
and for which host, and classify any failure per section 5. Distinguish a
regression from an external condition: a lost challenge race or a 1006 ban is
the network, not the code. Say plainly which one it was.
