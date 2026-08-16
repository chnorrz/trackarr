# Working notes

Hard-won facts about this project. Read this before debugging anything -
most of it cost hours of trial and error to establish, and several
"obvious" theories in here are recorded specifically because they turned
out to be **wrong**.

---

## 1. What this is

A Torznab server that makes scraper-hostile torrent trackers usable as
"Torznab (Custom)" indexers in Prowlarr. One indexer per provider, all from
one process (shared browser + cache).

| File | Role |
|---|---|
| `server.js` | Torznab endpoints: `/:provider/api`, `/:provider/download` |
| `lib/browser.js` | Camoufox session, Cloudflare clearing, auto-solve |
| `lib/cache.js` | TTL cache (search 5 min, magnets 1 h) |
| `lib/categories.js` | Shared Torznab category ids |
| `providers/*.js` | Per-tracker `{ id, name, search(q), resolveMagnet({id,url}) }` |
| `tools/tinyproxy.conf` | Proxy config, runs on the **macOS host** (see 1337x) |
| `get-magnet.js` | Standalone CLI, uses ext.to's *detail-page* flow (legacy) |

Adding a tracker: write `providers/<id>.js`, register in
`providers/index.js`. Nothing else needs touching.

---

## 2. ext.to

### Search

- URL: `https://ext.to/browse/?q=<query>` — **not** `/search/`, that path
  triggers a WAF challenge.
- Bare `/browse/` without `?q=` does **not** render `searchPageToken`. If you
  just need a token, use a realistic query.
- Rows: `table.search-table tbody > tr`

| Field | Selector |
|---|---|
| title / detail URL | `a.torrent-title-link` (text, href) |
| torrent id | `a.search-magnet-btn[data-id]` |
| size | `td[1] span:last` (e.g. `1.98 GB`) |
| files | `td[2]` |
| age | `td[3] span:last` — **`title` attr** holds the exact date; the text is relative ("5 days ago") |
| seeds / leechers | `td[4]` / `td[5]` |
| category | `.related-posted a[href^="/"] strong` |

**Category gotcha:** `.related-posted` also contains an *uploader* link. Its
href starts with `?`, category links start with `/`. Without the
`[href^="/"]` filter you silently scrape the uploader name and every result
maps to "Other".

### Magnets

Two different flows exist. Use the search one.

| | Search flow (used) | Detail flow (legacy, `get-magnet.js`) |
|---|---|---|
| Endpoint | `/ajax/getSearchMagnet.php` | `/ajax/getTorrentMagnet.php` |
| Token | `window.searchPageToken` | `window.pageToken` |
| Session | `<meta name="csrf-token">` | `window.csrfToken` |
| Extra fields | `hash`, `name` (both empty) | `action: 'get_magnet'` |
| Response | `{success, url}` | `{magnet}` |

Both sign the same way:

```js
hmac = sha256(`${torrentId}|${timestamp}|${token}`)   // timestamp in seconds
```

The search flow means **no detail-page visit is needed** — `data-id` from the
search row plus a fresh token page is enough. That was a significant
simplification; don't regress to per-result detail navigation.

Client logic lives in `/static/js/advanced-search-list.js` (not inline). It's
Cloudflare-protected, so fetch it *through the browser*, not curl.

---

## 3. 1337x

Much lighter protection, and **no cookie needed**.

- URL: `https://1337x.to/search/<query>/1/`
- Rows: `table.table-list tbody > tr`
- Title: `td.coll-1.name a[href^="/torrent/"]`
- Seeds / leechers: `td.coll-2.seeds` / `td.coll-3.leeches`
- Size: `td.coll-4.size` — contains a **nested duplicate span**; strip child
  elements or you get `"2.2 GB28818"`
- Category: from the icon class `td.coll-1.name a.icon i` (`flaticon-movies`,
  `flaticon-tv`, ...)
- Magnet: embedded directly on the detail page as `a[href^="magnet:"]` — no
  HMAC dance
- Dates are only relative strings; no exact-date attribute. `pubDate` falls
  back to now.

### Reachability

1337x has banned our **IPv4** address; our IPv6 is clean. It therefore works
in a desktop browser but not from the container, and needs the host proxy —
see [section 4](#4-ipv4-bans-and-the-ipv6-proxy). It requests this itself via
`gotoCleared(url, { proxy: '1337x' })`, so it only needs `PROXY_URL` set.

---

## 4. IPv4 bans and the IPv6 proxy

Some trackers ban an IPv4 address while leaving the IPv6 clean. The site then
keeps working in your desktop browser (macOS prefers IPv6 per RFC 6724) but
fails from the container, which looks convincingly like fingerprinting or a
parser bug. **Check this first** - it cost hours of chasing the wrong thing.

### Symptoms

- Cloudflare **error 1006**, `Access denied ... has banned your IP`. It is a
  static page with **no Turnstile widget**, so the auto-solver cannot help.
  Different failure, different fix.
- The exact same URL loads fine in a normal browser on the same machine.
- `isBlocked()` fires. Before that check existed this showed up as a silent
  "0 results", which is far more confusing.

### Diagnose

**1. Does the target even have IPv6, and which family did the host use?**

```bash
dig +short AAAA <host>     # empty -> no IPv6 at all, this is not your problem
curl -s -o /dev/null -m 15 -w '%{remote_ip}\n' https://<host>/
```

**2. Force each family on the host and compare.** This is the money shot:

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0"
for f in 4 6; do
  body=$(curl -s -$f -m 20 -A "$UA" https://<host>/)
  printf "IPv%s len=%s banned=%s\n" "$f" "${#body}" \
    "$(grep -qc 'banned your IP' <<<"$body" && echo YES || echo no)"
done
```

IPv4 banned + IPv6 clean confirms it. For a browser-level control (same
binary, only the family differs):

```js
Camoufox({ headless: true, firefox_user_prefs: { 'network.dns.disableIPv6': true } })
```

**3. Confirm the container has no IPv6 of its own:**

```bash
docker run --rm <image> bash -c 'curl -s -6 -m 8 https://api64.ipify.org || echo "no IPv6"'
colima ssh -- ip -6 addr show scope global      # expect empty
```

### Why enabling IPv6 in Docker does not help

Colima's VM has no global IPv6 addresses and no IPv6 egress, so the Docker
daemon has nothing to route. The traffic has to leave via the host instead.

### Fix: proxy through the host

Run **tinyproxy** on the host and tunnel the container through it. HTTP
`CONNECT` only pipes bytes, so TLS stays end-to-end and the browser's
fingerprint is unchanged - only the egress address differs.

No IPv6-specific flag is needed: tinyproxy uses the system resolver, and macOS
prefers IPv6. (A hand-rolled Node proxy *did* need an explicit `family: 6`,
because Node's Happy Eyeballs kept picking the banned IPv4 - a Node quirk, not
a system one.)

```bash
brew install tinyproxy

# must outlive the shell, hence launchctl (see section 7)
launchctl submit -l ext-tinyproxy -o /tmp/tp.log -e /tmp/tp.err \
  -- "$(which tinyproxy)" -d -c /path/to/tools/tinyproxy.conf

# host address from inside a container: 192.168.5.2 under Colima,
# host.docker.internal elsewhere
docker run ... -e PROXY_URL=http://192.168.5.2:8888 ...
```

`tools/tinyproxy.conf` restricts access to localhost plus the Docker/Colima
ranges. Without those `Allow` lines it is an open relay on the LAN.

### Configuration (env)

| Var | Meaning |
|---|---|
| `PROXY_URL` | e.g. `http://192.168.5.2:8888`. **Unset = proxy disabled**, everything direct. |
| `PROXY_PROVIDERS` | Comma-separated provider ids, overriding which use it. Unset = whichever ask in code. Set but **empty = none** (kill switch, no code change needed). |

Providers opt in per request with `gotoCleared(url, { proxy: '<id>' })`;
passing the id is what lets `PROXY_PROVIDERS` target them. Asking for a proxy
that isn't configured silently falls back to direct.

Only the direct context's cookies are persisted, so a proxied context cannot
clobber ext.to's `cf_clearance`.

**Do not proxy a provider that works directly.** `cf_clearance` is bound to
the egress IP (section 5), so routing ext.to through the proxy would
invalidate its stored cookie.

Verified behaviour:

| Config | 1337x | ext.to |
|---|---|---|
| `PROXY_URL` set, `PROXY_PROVIDERS` unset | 20 results via proxy | 50, direct |
| `PROXY_URL` set, `PROXY_PROVIDERS=` | hard blocked (direct) | unaffected |
| no `PROXY_URL` | hard blocked (direct) | unaffected |

---

## 5. Cloudflare: what is and isn't true

### Detection markers

```js
isChallenge = html.includes('cf-turnstile') || html.includes('Just a moment')
isBlocked   = html.includes('Access denied') && html.includes('Cloudflare')
```

- **Never** use `challenge-platform` as a marker. Cloudflare injects
  `/cdn-cgi/challenge-platform/scripts/jsd/main.js` on perfectly good cleared
  pages. It caused a permanent false positive.
- `isBlocked` matters: a hard ban has no Turnstile widget, so `isChallenge`
  misses it and the scrape silently looks like "0 results" instead of an
  error.
- Wrap `page.content()` in try/catch — it throws mid-navigation during
  Cloudflare's redirect chain.

### Ruled out as discriminators (all measured, all negative)

Our automation is **byte-identical** to a real Firefox at every inspectable
layer. Don't re-litigate these:

| Hypothesis | Verdict |
|---|---|
| Headless detection | Headed fails identically |
| WebGL / fonts | Follows from above |
| Cookie/session reputation | Fresh zero-cookie session fails |
| Camoufox's patches | Vanilla Playwright Firefox fails identically |
| `navigator.webdriver` | Camoufox `false` fails; vanilla `true` fails the same |
| TLS JA3/JA4 | Identical to real Firefox: `t13d1617h2_86a278354501_3cbfd9057e0d` |
| HTTP/2 akamai fingerprint | Identical: `1:65536;2:0;4:131072;5:16384\|12517377\|0\|m,p,a,s` |
| HTTP headers | Byte-identical order and values |
| IP reputation | Real browser passes from the same IP |

Reference points if re-measuring: `https://tls.peet.ws/api/all` returns JA3/
JA4/akamai/header order.

### What cf_clearance is actually bound to

- **User-Agent** — must match exactly. Camoufox randomises the spoofed OS
  *per launch*, which silently invalidates a stored cookie. Pin `os` and
  persist the UA alongside the cookie if reusing one.
- **IP**
- **OS / TCP stack** — strong inference, not proof. A cookie solved in a
  macOS browser is rejected when replayed from a Linux container even with
  identical TLS, headers, UA and IP. Solving inside the *same kernel* that
  will use it works. This was verified as a prediction and held.
- **Not** the TLS fingerprint in the browser→browser case: real Firefox and
  Playwright Firefox handshakes are identical, so transplants work between
  them.

Node's `fetch` is a different matter — undici's TLS stack differs, so
cf_clearance genuinely cannot be replayed there. **All requests, including
the magnet POST, must run inside the browser page** via
`page.evaluate(fetch...)`.

---

## 6. The auto-solver

This is the fragile heart of the project. Three non-obvious requirements,
all found empirically:

**1. Input must be injected at the X server level (XTEST / `xdotool`).**
With Playwright's mouse API the widget sits on "Verifying..." forever and
never offers a checkbox. With XTEST it advances to a real "Verify you are
human" checkbox. XTEST events are indistinguishable from hardware to
Firefox. This is the single most important fact in this document.

**2. Coordinates must be translated page → screen.**
`getBoundingClientRect()` is page space; `xdotool` is screen space. Firefox's
chrome offsets the content area:

```js
screenX = window.mozInnerScreenX + rect.x     // typically 0
screenY = window.mozInnerScreenY + rect.y     // typically 57
```

Getting this wrong clicks ~57px above the checkbox and silently does
nothing. Coordinates are computed dynamically and vary per launch (observed
`214,395`, `317,395`, `534,395` — all correct). **Varying coordinates are not
a bug; do not "fix" this by pinning the viewport.**

**3. The display must have a real size.**
Camoufox's built-in `headless: 'virtual'` uses a **1x1** Xvfb screen —
nowhere to render or click. Run our own `Xvfb :99 -screen 0 1280x900x24` and
launch with `headless: false`.

### Locating the widget

Container ids are randomised per page load (`#mZiFs3` etc.) — never hardcode
them. Anchor on the stable hidden input and walk up:

```js
const input = document.querySelector('input[name="cf-turnstile-response"]');
let el = input;
while (el && el.getBoundingClientRect().height < 30) el = el.parentElement;
// checkbox ≈ left edge + 22px, vertically centred
```

The widget is in a **closed shadow DOM**. `document.querySelectorAll('iframe')`
returns `[]` — you cannot get iframe geometry.

### Ordering

Working sequence: load → short settle → read geometry → mouse warm-up →
approach → click. The warm-up (~30 moves) is what unsticks "Verifying...".

---

## 7. Environment gotchas

**Colima does not mount the host's `/tmp`.** `-v /tmp/x:/data` silently
mounts a *VM-local* directory, which may hold stale files from earlier runs.
This produced a completely bogus debugging conclusion once. Use **named
volumes** or `docker cp`.

**Docker builds exceed the tool timeout.** Run detached and poll:

```bash
nohup docker build -t ext-to-torznab:test . > /tmp/build.log 2>&1 &
# then poll for: "naming to docker.io/library/ext-to-torznab:test done"
```

**Keep `npx camoufox-js fetch` above the source `COPY`s** in the Dockerfile,
or every code edit re-downloads 654 MB.

**`DEBIAN_FRONTEND=noninteractive` is mandatory** — `x11vnc` pulls in
`tzdata`, which otherwise blocks the build on an interactive timezone prompt.

**Disk-full corrupts containerd.** A full host disk produced I/O errors and a
broken content store where even `docker system df` failed. Recovery:
`colima delete --force`, remove the leftover `~/.colima/_lima/_disks`
directory (including the empty `colima` subdir, which blocks restart), then
`colima start`. This destroys all images/containers/volumes.

**macOS Screen Sharing rejects `x11vnc -nopw`** — it won't do "no auth". Use
`-passwd <something>` if you ever need a VNC solve again.

**Background processes started from a tool shell get killed** when that
command ends or times out — `nohup` and `disown` are not enough, the whole
process group goes. For anything that must outlive the shell (the IPv6
proxy), use `launchctl submit`. `setsid` does not exist on macOS.

**Never cache empty results.** A transient failure (proxy down, challenge not
cleared) got cached for the full 5 min TTL and kept being served *after* the
fix, which looked exactly like "the parser is broken". Cost real debugging
time; `server.js` now only caches non-empty results.

---

## 8. Debugging playbook

**Never conclude "the site escalated / banned us" without running a control.**
I did this twice and was wrong both times. Keep a known-good standalone
script; if it still clears, the fault is ours.

**Screenshots are ground truth.** Widget state was twice misdiagnosed by
inferring from frame URLs and `page.content()`. `page.screenshot()`, then
`docker cp` it out and actually look at it.

**Fast iteration without rebuilds** (a rebuild is ~3 min, this is ~30 s):

```bash
# long-lived debug container with a display
docker run -d --name ext-dbg ext-to-torznab:test \
  bash -c "Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX & sleep 2 && sleep 3000"

docker cp probe.js ext-dbg:/app/probe.js
docker exec -e DISPLAY=:99 ext-dbg node /app/probe.js
```

**Test the real code path**, not a reimplementation of it — that's how the
solver regression was localised to our code rather than the environment:

```bash
docker exec -e DISPLAY=:99 ext-dbg node -e "
  (async () => {
    const { gotoCleared, closeBrowser } = await import('/app/lib/browser.js');
    try { const p = await gotoCleared('https://ext.to/browse/?q=yify');
          console.log('CLEARED'); await p.close(); }
    catch (e) { console.log('FAILED', e.message); }
    await closeBrowser(); process.exit(0);
  })();"
```

**Beware measurement artifacts.** `page.evaluate()` runs through the debugger
harness, so error stacks contain `juggler` frames. That is *not* something a
site can see — I briefly reported it as a smoking gun and it was nonsense. To
measure what page JS really sees, load a real page containing an inline
`<script>` (a local `file://` works) and read the value afterwards.

### End-to-end verification

```bash
docker volume create ext-to-data
docker run -d --name ext-to -p 9117:9117 -e API_KEY=k -v ext-to-data:/data ext-to-torznab:test

curl -s "localhost:9117/ext-to/api?t=caps"
curl -s "localhost:9117/ext-to/api?t=search&q=yify&apikey=k" | grep -c "<item>"   # expect 50
curl -sD- -o/dev/null "localhost:9117/ext-to/download?apikey=k&id=<id>"           # expect 302 magnet
```

Use a **fresh volume** to exercise the cold-start solve; an existing
cf_clearance hides solver breakage entirely.

---

## 9. Open issues

**Concurrent solves are unserialised.** XTEST input is global to the display,
so two simultaneous solves fight over one virtual mouse. Low risk under
Prowlarr's polling, real under load.

An attempt to add a mutex was **reverted** — the supporting changes
(viewport pinning, `bringToFront`, reworked widget detection) regressed
auto-solve to failing every time. Ruled out individually as the cause: click
coordinates, `bringToFront`, `page.content()` polling, the reload, and
warm-up ordering.

**Prime remaining suspect:** `xdo()` swallows errors. If the warm-up movement
silently no-ops, the widget stays on "Verifying..." and the click lands on
nothing — exactly the observed symptom. Verify the mouse actually moves:

```js
execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: ':99' } })
```

**Brittleness.** The solver depends on the widget DOM shape and the `+22px`
checkbox offset. Cloudflare can invalidate either at any time. Expect it, and
check a screenshot first when it breaks.

**No pagination** — search returns page 1 only. Deliberate MVP scope.
