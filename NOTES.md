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

TypeScript, `strict: true`. `npm run build` compiles `.ts` -> `dist/*.js`;
the Docker image only ever runs the compiled output (`node dist/server.js`,
or just `server.js` once `dist/` is the container's `/app`). There's no
`ts-node`/`tsx` at runtime, deliberately - keeps the production image from
carrying a whole extra toolchain just to interpret TS on every start.

| File | Role |
|---|---|
| `server.ts` | Torznab endpoints: `/:provider/api`, `/:provider/download` |
| `lib/browser.ts` | Camoufox session, Cloudflare clearing, auto-solve |
| `lib/cache.ts` | TTL cache (search 5 min, magnets 1 h) |
| `lib/categories.ts` | Torznab category ids + `categoriesXml()` (per-provider caps rendering) |
| `lib/paging.ts` | `fetchPagedWindow()` - offset/limit pagination with a depth cap |
| `lib/parse.ts` | Shared size-string parsing |
| `lib/types.ts` | `Provider`/`SearchItem`/`MagnetRef` shared interfaces |
| `providers/*.ts` | Per-tracker, each `export default {...} satisfies Provider` |
| `tools/tinyproxy.conf` | Proxy config, runs on the **macOS host** (see 1337x) |

Adding a tracker: write `providers/<id>.ts`, register in
`providers/index.ts`. Nothing else needs touching.

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
| category | `.related-posted a[href^="/"]:not([href^="/user/"])` **hrefs**, both breadcrumb levels, matched against `CATEGORY_RULES` (real search only — blank-query browsing already knows its category, see section 10) |

**Category gotcha, and it has already drifted:** `.related-posted` also
contains an *uploader* link, which needs filtering out or you silently
scrape the uploader as the "category". Its href shape isn't fixed -
confirmed live in three forms: `?source[]=N` (DHT bot), `?user_nick=N`
(external non-verified user), and `/user/<name>/` (verified uploader, which
also starts with `/`, unlike the other two). Filtered by excluding
`/user/` explicitly rather than trusting a leading-character heuristic.

**Category matching uses the breadcrumb *hrefs*, not the link text**, and
reads both levels (e.g. `/tv/ /tv/season-packs/`, `/books/
/books/audio-books/`) - not just the top one. Two real, live-confirmed
reasons this matters, both found the hard way:

1. Display text drifts/varies independent of the URL - `/books/
   audio-books/` renders as "Audio books" (two words, no hyphen), so a
   text keyword of `'audiobook'` never matches it at all. The href slug is
   what the site itself actually routes on, so it's the far more stable
   signal to match against (same reasoning as 1337x's `/sub/<id>/` fix in
   section 3).
2. Some Torznab categories only exist at the *subcategory* level -
   Audiobooks has no dedicated top-level breadcrumb of its own, it's
   `/books/audio-books/` under the generic Books top category. Matching
   only the first breadcrumb link, like the code used to, can never find
   it.

`CATEGORY_RULES` in `providers/ext-to.ts` is keyed on href fragments now
(`/tv/`, `/music/`, `audio-book`, etc), not words. Order still matters:
`audio-book` must stay above the generic `/books/` rule, since `/books/
audio-books/` also contains `/books/`. `parseListing()` also gained an
optional `knownCategory` param (mirrors 1337x's fix in section 3) so
blank-query browsing - which already knows its category from the URL it
built - never depends on this breadcrumb detection at all; only real
keyword search still needs it, since that listing genuinely mixes every
category on one page.

**Confirmed real top-level paths and which subcategories actually matter**
(only categories where our Torznab id set - `lib/categories.ts`'s
`CATEGORIES` - has a *specific* id for the subcategory; otherwise it just
collapses to the generic top-level rule, so there was no point tracking it):

| Path | Torznab category | Subcategories that matter |
|---|---|---|
| `/tv/` | TV (5000) | none - no dedicated ids for season-packs/episodes-hd/etc |
| `/movies/` | Movies (2000) | none - no dedicated ids for Bollywood/3D/UltraHD/etc |
| `/music/` | Audio (3000) | none - no dedicated ids for MP3/Lossless/etc |
| `/anime/` | TV/Anime (5070) | none - ext.to doesn't split anime by movie vs TV at all |
| `/books/` | Books (7000) | `/books/audio-books/` → Audiobooks (3030); `/books/ebooks/` → Books/EBook (7020) |
| `/games/` | PC/Games (4050, fallback) | `/games/pc-games/` → PC/Games (4050); `/games/other-games/` → Console/Other (1090) |
| `/applications/` | PC (4000) | `/applications/mac/` → PC/Mac (4030); `/applications/android/` → PC/Mobile-Android (4070); `/applications/windows/` has no dedicated id, falls through to PC (4000) |
| *(none)* | XXX | confirmed twice - ext.to has no XXX category at all |

Note the real top-level Apps slug is `/applications/`, not `/apps/` -
guessed wrong initially, corrected once confirmed live.

### Magnets

Two different flows exist. Use the search one.

| | Search flow (used) | Detail flow (exists, unused) |
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
- Category: primarily from the sub-category id embedded in
  `td.coll-1.name a.icon`'s `href` (`/sub/<id>/...`) via `SUB_ID_CATEGORY`
  in `providers/1337x.ts` — the icon **CSS class** (`flaticon-movies`,
  `flaticon-tv`, ...) is only a fallback for an unlisted sub id, since it's
  been observed to drift (live TV rows render `flaticon-hd`, identical to
  HD movies — see section 3's own "Category drift" note below and section
  10's `knownCategory` design for how blank-query browsing sidesteps this
  entirely by already knowing which category it asked for).
- Magnet: embedded directly on the detail page as `a[href^="magnet:"]` — no
  HMAC dance
- Dates are only relative strings; no exact-date attribute. `pubDate` falls
  back to now.

### Category drift — icon CSS class is not reliable, use the sub id

Live-tested by browsing `cat/Movies/1/`, `cat/TV/1/`, `cat/Music/1/`
directly and inspecting real rows: 1337x's markup has drifted from what the
old icon-class matcher (`CATEGORY_RULES`, substring rules like `'tv'`,
`'music'`, `'hd'`) expects. TV episode rows now render with icon class
`flaticon-hd` — identical to HD movies, so the `'hd'` rule (meant for
movies) silently absorbed every TV row into Movies. Music/lossless rows use
a `flaticon-lossless` class no rule matched at all, falling through to
`OTHER`.

The fix: every row's icon `<a>` also links to `/sub/<id>/<page>/` — a
numeric 1337x-internal subcategory id, which turned out to be a far more
stable signal than the CSS class. `providers/1337x.ts` has a
`SUB_ID_CATEGORY: Partial<Record<number, number>>` table (~70 entries,
transcribed from 1337x's own live category sidebar HTML for every top-level
category — Movies/TV/Anime/Music/XXX/Games/Apps/Other) mapping each sub id
to its Torznab category. `CATEGORY_RULES` (icon class) is now only a
fallback for a sub id not yet in the table, or a row with no icon href at
all. A handful of 1337x's "Other"-bucket sub-categories have no clean 1:1
Torznab equivalent and were mapped by judgment call (e.g. Comics -> Books,
Emulation -> Console/Other, Nulled Script -> generic PC) — check
`SUB_ID_CATEGORY`'s comments if a new one needs adding.

Live-verified after the fix: the no-cat browse snapshot (see section 10)
went from 37/0/0/32+11 (Movies/TV/Anime/Other, badly misclassified) to an
exactly correct 20/20/-/20 split across Movies/TV/Music/Other.

### Reachability

1337x has banned our **IPv4** address; our IPv6 is clean. It therefore works
in a desktop browser but not from the container, and needs the host proxy —
see [section 4](#4-ipv4-bans-and-the-ipv6-proxy). It requests this itself via
`gotoCleared(url, { proxy: '1337x' })`, but that alone isn't enough - it also
needs `1337x` listed in `PROXY_PROVIDERS`, which isn't set by default.

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
docker run ... -e PROXY_URL=http://192.168.5.2:8888 -e PROXY_PROVIDERS=1337x ...
```

`tools/tinyproxy.conf` restricts access to localhost plus the Docker/Colima
ranges. Without those `Allow` lines it is an open relay on the LAN.

### Configuration (env)

| Var | Meaning |
|---|---|
| `PROXY_URL` | e.g. `http://192.168.5.2:8888`. **Unset = proxy disabled**, everything direct. |
| `PROXY_PROVIDERS` | Comma-separated provider ids allowed to use it. **Unset or empty = none.** |

Deliberately opt-in, not opt-out: a provider asking for the proxy in code
(`gotoCleared(url, { proxy: '<id>' })`) is not enough on its own - it must
also be named in `PROXY_PROVIDERS`, or it goes direct regardless. `PROXY_URL`
alone does nothing. Not baked into `docker-compose.yml`'s defaults either -
needing this at all is specific to whichever tracker banned your IP, not
something every deployment should silently opt into.

Only the direct context's cookies are persisted, so a proxied context cannot
clobber ext.to's `cf_clearance`.

**Do not proxy a provider that works directly.** `cf_clearance` is bound to
the egress IP (section 5), so routing ext.to through the proxy would
invalidate its stored cookie.

`proxyEnabledFor()`'s matching logic is covered by a standalone unit test (6
cases: unset, empty, explicit match, non-match, no `PROXY_URL` regardless of
`PROXY_PROVIDERS`, and a multi-value list) - all passing confirms the
allow-list mechanism itself is correct. The original end-to-end Docker
verification below predates this change (back when unset meant "whichever
providers ask in code"), so it demonstrates the proxy path works at all, not
this specific default.

| Config | 1337x | ext.to |
|---|---|---|
| `PROXY_URL` set, `PROXY_PROVIDERS` unset (old default) | 20 results via proxy | 50, direct |
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

### After the solve: wait for the redirect

Clearing the challenge only means the interstitial is gone. Cloudflare *then*
client-side redirects to the URL you originally asked for. Returning as soon
as the challenge markers disappear hands the caller a near-empty page.

Symptom: **HTTP 200 with 0 results on the first request after a cold-start
solve, and correct results on the second.** It looks like a broken parser or
a stale cache, and it isn't either. `gotoCleared` now waits for
`networkidle` after a solve and re-reads the content.

### Concurrent navigations hang - `page.goto` needs serializing too

Multi-category requests (`fetchMergedBrowse`, 1337x's no-cat 4-category
snapshot - see section 10) fire several `gotoCleared()` calls at once via
`Promise.all`. Live-tested against 1337x through the proxy: a single
concurrent navigation works fine, 2+ concurrent navigations to the same
Cloudflare-protected host reliably hang until the 60 s `page.goto` timeout -
reproduced deterministically. Two separate causes, both in `lib/browser.ts`:

1. Only the xdotool **solve** step was serialized (the pre-existing
   `serializeSolve()`/`solveChain` promise-chain mutex). `page.goto()`
   itself was not - concurrent navigations to the same host raced each
   other and Cloudflare appears to treat simultaneous connections from one
   client as suspicious and gets stuck rather than erroring cleanly.
2. `getPersistentContext()`/`getProxyContext()` were lazy singletons with no
   guard against concurrent first calls - each could see the cache as still
   empty and launch its own Camoufox browser instance simultaneously
   (confirmed via logs: 4x `[cf] launching proxied browser` for one
   request), starving the shared Xvfb display and causing
   `NS_ERROR_NET_TIMEOUT`.

Fix: `serializeNav()` - a second pair of promise-chain mutexes
(`directNavChain`/`proxyNavChain`, keyed by whether the proxy is in use so
direct and proxied navigation don't block each other) wrapping the whole
`gotoCleared` body, mirroring `serializeSolve`'s existing pattern. Plus:
`getPersistentContext()`/`getProxyContext()` now cache the **in-flight
launch promise**, not just the resolved context, so concurrent callers
await the same launch instead of racing (cache is cleared on launch
failure so a later call can retry).

Live-verified after the fix: a 4-fetch concurrent snapshot produces exactly
one `[cf] launching proxied browser` line, one solve, and sequential
navigations - completes in ~24 s instead of hanging. Tradeoff accepted:
multi-category blank browsing is now ~N × single-fetch time instead of
running in parallel.

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
time; `server.ts` now only caches non-empty results.

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

### Before calling a new provider done: verify blank-query browse actually returns results

Prowlarr's Test button (and Save - Save genuinely fails, red exclamation
mark, if Test's result set is empty) searches with a **blank** `q`. There is
no `testQuery` substitution any more (see section 10) - a blank `q` is
passed straight to `provider.search('', opts)`, and every provider must
implement a real "browse latest uploads" path for that case, keyed off
`opts.category`.

**Historically this broke twice for the same underlying reason** (back when
blank `q` was substituted with a fixed search term): a term that's a good
fit for one tracker's catalog can return zero results on another. The new
per-category browse design removes the term entirely, but the failure mode
it's worth guarding against is now "this category has no `CATEGORY_BROWSE`
mapping for this provider" - Prowlarr still needs *a* category param on
Test/Save for this to produce anything.

So: **before considering a new provider finished, run its blank-query browse
directly for each category it claims to support (its `categories` array) and
confirm each returns a non-trivial result count**:

```bash
npm run build
node -e "
import('./dist/providers/<id>.js').then(async ({default: p}) => {
  for (const category of p.categories) {
    const { items, total } = await p.search('', { category, offset: 0, limit: 10 });
    console.log(category, '->', items.length, 'of', total);
    if (items[0]) console.log('  sample:', items[0].title);
  }
  process.exit(0);
});
"
```

---

## 9. Keep-alive

A solve costs ~20 s. Landing that inside a Prowlarr search risks the search
timing out, so a background task periodically visits each provider's
`keepAlive.url` to keep its clearance warm.

It **checks rather than solves**: `gotoCleared()` only solves when actually
challenged, so a visit with a valid cookie is cheap. Measured on a fresh
volume with a 1 min interval:

| Tick | ext.to | 1337x | Solve? |
|---|---|---|---|
| boot warm-up | 19.3 s | 17.3 s | yes, one each |
| later ticks | 1.7 s / 2.3 s | 0.75 s / 0.87 s | no |

Searches afterwards ran in **1.9 s / 2.4 s with zero solves** on the request
path, versus ~19 s cold.

`KEEPALIVE_INTERVAL_MS` (default 15 min, `0` disables) with ±20% jitter so
we're not hitting trackers on an exact schedule. Providers opt in by
exporting `keepAlive: { url, proxy? }`.

**The interval is a guess.** The real clearance lifetime was never measured —
only estimated at roughly 15–30 min. If challenges start appearing on the
request path, lower it.

---

## 10. Pagination, blank-query browsing, and per-provider categories

### Why `testQuery` was removed

Originally a blank `q` (what Prowlarr's Test/Save always sends) was
substituted with a fixed `provider.testQuery` string ('yify', 'MeGusta',
etc). That's a hack: it only ever returns whatever that one term happens to
match, ignores whatever category Prowlarr actually asked for, and provides
no real pagination - Sonarr/Radarr's "search all" flows use blank `q` too,
not just Prowlarr's Test button. It's gone. `server.ts` now passes `q`
through to `provider.search(q, opts)` completely unchanged, blank or not;
every provider implements a real "browse latest uploads for category X" path
for the blank case.

### `CATEGORY_BROWSE` tables and multi-category `cat`

Each provider (`providers/ext-to.ts`, `providers/1337x.ts`) has its own
`CATEGORY_BROWSE: Partial<Record<number, ...>>` mapping a Torznab category
id to that tracker's browse URL/path for it (e.g. ext.to's
`{cat, subCat?}` numeric pair vs 1337x's `cat/Movies` / `sub/36` path
fragments).

`SearchOptions.categories?: number[]` (renamed from a single `category`)
holds every id from a comma-separated `cat=` param (spec: OR semantics -
`cat=2000,5000` means either category). It drives two different things
depending on whether `q` is blank:

- **Blank `q` (browse):** each requested id is resolved through
  `CATEGORY_BROWSE`; unresolvable ones (unknown to this tracker, e.g. XXX on
  ext.to) are dropped. Zero resolved -> `{items:[],total:0}`. One resolved ->
  the existing single-source `fetchPagedWindow`. Two or more resolved ->
  `fetchMergedBrowse` (below), which fetches each category's listing
  independently and merges them by `pubDate` descending. No `cat` at all ->
  each provider's own general/no-cat browse (see below).
- **Real keyword search:** `categories` becomes a `filter` predicate passed
  into `fetchPagedWindow` (`item => categories.includes(item.category)`) -
  applied to the tracker's own search results, since none of these trackers
  support filtering by category server-side in their search UI.

**No-`cat` blank-query browsing is per-provider, not uniform:**
- ext.to and EZTV both have their own genuine "all categories, newest first"
  listing (ext.to: `/browse/?sort=age&order=desc` with no `cat`/`sub_cat` at
  all; EZTV: `/api/get-torrents` is TV-only anyway) - `fetchPagedWindow` runs
  once against that.
- 1337x has no such listing. Its no-`cat` case deliberately matches
  **Prowlarr's own reference Cardigann definition**
  (`Prowlarr/Indexers` repo, `definitions/v11/1337x.yml`) instead of
  inventing new behavior: a fixed snapshot of exactly 4 categories -
  `cat/Movies/1/`, `cat/TV/1/`, `cat/Music/1/`, `cat/Other/1/` - always page 1
  only, concatenated with **no** cross-category date re-sort, `total` is the
  exact combined count (the whole snapshot is always fully known, no depth-cap
  estimate needed). This intentionally does not support real offset/limit
  depth beyond that one fixed page per category, same as Prowlarr's own
  definition doesn't.

EZTV is TV-only and has no `CATEGORY_BROWSE` table at all - instead it has a
single guard at the top of `search()`: if `categories` is non-empty and
doesn't include `CATEGORIES.TV`, it returns `{items:[],total:0}` immediately,
before any network/browser call (blank or keyword path). Otherwise it hits
`https://eztvx.to/api/get-torrents?limit=N&page=M` directly with a plain
`fetch()` (not `gotoCleared`/browser - accepted risk if Cloudflare ever
starts protecting that endpoint) and always maps everything to
`CATEGORIES.TV`.

### `fetchPagedWindow`, `fetchMergedBrowse`, and the depth cap

`lib/paging.ts` exports `fetchPagedWindow<T>()`: given a `fetchPage(sitePage)`
callback and the caller's requested `{offset, limit, sitePageSize, depthCap,
filter?}`, it fetches only as many of the tracker's own pages as needed to
cover `[offset, offset+limit)`, slices the result to exactly that window, and
returns `{items, total}`. `total` is capped at `depthCap` (200 for every
provider) - Prowlarr's own client paginates by repeatedly requesting the next
`offset`, and it was found to page indefinitely against real trackers with no
natural stopping point (EZTV in particular kept paging for hundreds of
requests). Capping `total` at a small constant makes Prowlarr's own
"has-more" logic stop after a bounded number of pages, regardless of how
`opensearch:totalResults` gets used downstream.

With a `filter` (used for category-filtering real search results), it
switches to a sequential scan from site page 1 instead of jumping to a
computed page - filtered-item density per page is unknown up front - stopping
once enough matches are collected, `depthCap` raw items have been scanned, or
a page comes back short (source exhausted). `total` in that mode is the exact
match count if the source ran out, otherwise `depthCap` - any `totalHint`
from the unfiltered source is ignored since it would describe the wrong
(unfiltered) set.

`fetchMergedBrowse<T extends {pubDate: Date}>(sources, opts)` runs
`fetchPagedWindow` independently per source (each bounded by the same
`depthCap`), flattens all their items into one pool, sorts by `pubDate`
descending, and slices `[offset, offset+limit)` out of the merged pool -
used when 2+ categories are requested for a blank-query browse. Known
limitation: 1337x's `parseListing()` always sets `pubDate: new Date()` (no
real per-item date is parseable from the site), so merging multiple 1337x
categories doesn't produce a meaningfully chronological order, just rough
per-source concatenation - a pre-existing constraint, not something the merge
itself got wrong.

**`<opensearch:totalResults>` is never actually parsed by Prowlarr.** It's
rendered for spec-compliance only (see section 11); the real fix for runaway
pagination is the depth cap plus returning short/empty item lists once a
provider's browse listing is exhausted, which `fetchPagedWindow` and each
provider's own listing parser already do.

### Per-provider `categories` and the caps XML fix

`Provider.categories: number[]` (in `lib/types.ts`) declares exactly which
Torznab category ids a provider's content can be classified into.
`lib/categories.ts`'s `categoriesXml(ids)` renders only those ids (plus
their parent `<category>` wrapper for any 1000-series console subcat, added
automatically) into the `<categories>` block of `capsXml()` in `server.ts`.

This replaced an earlier bug where every provider's caps advertised the same
single global category list - e.g. EZTV (TV-only) was advertising Movies,
Books, XXX, PC/Apps, etc it doesn't actually have, because `capsXml()` used
to interpolate one shared `CATEGORIES_XML` constant regardless of which
provider was asking.

---

## 11. Torznab spec compliance

Audited against the official Torznab v1.3 draft spec
(https://torznab.github.io/spec-1.3-draft/torznab/Specification-v1.3.html).
Findings and fixes:

- **`t=` query param values are unhyphenated.** `t=search`/`t=tvsearch`/
  `t=movie` - not `tv-search`/`movie-search`. Those hyphenated forms are only
  the caps `<tv-search>`/`<movie-search>` *element* names, a separate thing.
  `server.ts`'s route handler was matching the wrong (element) names; fixed.
- **`cat` is a comma-separated OR list**, not a single value - fixed (see
  above section). Two distinct rules from the spec, both implemented:
  syntax must be validated against `^\d+(,\d+)*$` (error `201` if it
  isn't - e.g. `cat=abc`, `cat=2000,`, `cat=2000, 5000` all reject), while
  semantically-*unknown* category ids (valid integers, just not ones any
  provider recognizes) are silently ignored per "unknown categories must
  be silently ignored" rather than erroring - a syntax problem and an
  unknown-id problem are handled differently on purpose.
- **`limit` is clamped to the caps-advertised max** (`MAX_LIMIT=100`) via
  `Math.min` - was previously unbounded.
- **`categories` XML nesting** follows the Newznab `X000`/`Xnnn` convention
  uniformly (`lib/categories.ts`'s `CATEGORY_DEFS` sets `parent` on every
  subcat, e.g. `5070->5000`, `3030->3000`, `4030/4050/4060/4070->4000`,
  `7020->7000`), not just the console 1000-series.
- **Error responses are spec-shaped XML, not plain HTTP status text.**
  `server.ts`'s `sendError(res, code, description)` sends
  `<?xml version="1.0" encoding="UTF-8"?><error code="N" description="..." />`
  with **HTTP 200** - the newznab/torznab convention is that the error is
  communicated entirely via the `<error>` document's `code`/`description`
  attributes, which is what real clients parse, not the HTTP status.
  Codes in use, from the standard newznab table: `100` bad apikey, `200`
  missing parameter (e.g. no `id`/`url` on `/download`), `201` incorrect
  parameter (invalid `offset`/`limit`), `203` no such function (unrecognized
  `t=`), `900` unknown/internal error (caught exceptions during search or
  magnet resolution - description includes the real error message for
  debuggability). Unknown-provider 404s are intentionally left as plain HTTP
  404 - that's routing, not a Torznab function-level parameter error.
- **`offset`/`limit` are strictly validated.** Spec: "shall verify whether
  both values are integers greater or equal to zero. Otherwise the error
  201 ... must be returned." Non-integer or negative values now return
  `<error code="201">` instead of silently falling back to defaults; absent
  or empty values still default normally (offset 0, limit `DEFAULT_LIMIT`).

---

## 12. Testing

`npm test` (builds first, then runs `node --experimental-test-module-mocks
--test "test/**/*.test.ts"`). `npm run typecheck` type-checks source +
tests without emitting (`tsconfig.test.json`). CI (`.github/workflows/ci.yml`)
runs both on every push/PR; `docker-publish.yml` also gates the release build
on the same `test` job (`needs: test`), so a broken suite can't ship.

**No browser, no Docker, no network needed to run the suite at all** -
verified decisively by running `CAMOUFOX_INSTALL_DIR=/tmp/nonexistent npm
test` and getting all tests passing anyway. The mock boundary is
`lib/browser.ts`'s `gotoCleared()` - provider tests never import camoufox-js
for real.

### Mock boundary

- **Providers**: mock `gotoCleared` (via `node:test`'s `mock.module()`),
  assert against hand-built fixtures in `test/fixtures/`.
- **Server**: no mocking - `server.ts` exports `createApp(providers, opts?)`,
  a pure factory taking the provider map and cache TTLs as arguments instead
  of reading module-level singletons. Tests call `app.listen(0)` (OS-assigned
  port) and hit it with real `fetch()`, exercising the actual HTTP layer.
  Each `createApp()` call gets fresh `TTLCache` instances, so tests never
  leak state into each other. Production (`node dist/server.js`) still boots
  exactly as before via an `import.meta.url === file://${process.argv[1]}`
  entrypoint guard at the bottom of the file - `createApp` itself has zero
  side effects.

### Fixtures must not contain real content

`test/fixtures/*` are hand-built, not raw captures - no real torrent/episode
titles, no real magnet hashes (a real infohash resolves to a real torrent).
Fake titles use an obvious pattern (`Example Movie One (2024)... FAKEGRP`),
fake magnet hashes use recognizable placeholders (`0000...aaa1`,
`0000...bbb1`, etc). Exact selector structure (classes, attribute names, `td`
index positions) is preserved byte-for-byte against the real markup, since
that's the whole point of the fixture - only the *content* is fake.

If you ever capture a fresh fixture from a live site to check selectors still
match, do the substitution immediately and delete the raw capture - don't
leave real captured HTML sitting in `/tmp` or anywhere it could get
accidentally committed.

### mock.module() gotchas (Node 22-24)

- Needs the `--experimental-test-module-mocks` flag or `mock.module` is
  `undefined`.
- Register it **once per file**, at the top - calling `mock.module()` again
  for the same specifier throws `ERR_INVALID_STATE`. To vary behaviour per
  test, hold onto the `mock.fn()` handle and call
  `.mock.mockImplementation(...)` on it inside each `test()` instead of
  re-registering.
- Use `options.exports`, not `options.namedExports` - the latter is
  deprecated (still works, prints a warning).
- Mock by absolute path (`path.join(ROOT, 'dist', 'lib', 'browser.js')`), not
  a relative specifier - robust regardless of which file is importing it.
- An untyped `mock.fn(async () => x)` infers its call-signature from that
  *first* implementation, so `.mock.calls[i].arguments` can end up typed as
  `[]` even after `mockImplementation()` swaps in a differently-shaped one
  later. Type the mock explicitly:
  `mock.fn<(url: string, opts?: GotoOptions) => Promise<Page>>(...)`.

### Import path split: production vs test files

Node runs `.ts` test files directly (no ts-node/tsx needed, Node 22.6+
supports erasable-syntax TS natively) - but only for imports that resolve
exactly as written:

- **Importing production code**: always from `dist/*.js` (compiled output),
  never raw `.ts` source. Production files use `.js`-extension imports
  (required by NodeNext/ESM), and Node's native TS execution does not remap
  those to sibling `.ts` files - `import('../../providers/1337x.ts')` fails
  with `Cannot find module '.../lib/browser.js'`.
- **Importing other test files** (e.g. `test/helpers.ts`): use the explicit
  `.ts` extension - there's no compiled counterpart to point at.
- `tsc --noEmit` needs `allowImportingTsExtensions: true` (in
  `tsconfig.test.json` only) to accept those `.ts` import specifiers without
  complaining.

Since tests import compiled output, `npm test` runs `npm run build` first -
if you edit source and the test doesn't seem to pick it up, that's usually
because you're running the test binary directly instead of through `npm
test`.

### Test discovery

Use the quoted glob `node --test "test/**/*.test.ts"` - both a bare
`node --test test/` (tries to resolve `test/` as a module path, throws
`MODULE_NOT_FOUND`) and an unquoted `**` (bash doesn't expand it recursively
by default) fail. Node's own glob engine needs the literal, quoted pattern.
Also: without the `*.test.ts` suffix restriction, Node's directory-heuristic
auto-discovery will pick up non-test files like `test/helpers.ts` as a
phantom passing test.

### Adding tests for a new provider

1. Build a fixture in `test/fixtures/` with fake content, real selectors.
2. Mock `gotoCleared` once at the top of `test/providers/<id>.test.ts`
   (copy the pattern from `1337x.test.ts` or `ext-to.test.ts`).
3. Cover at minimum: a successful `search()` parse (title/size/category/etc),
   a malformed-row edge case, `resolveMagnet()` success, and its failure
   modes (missing id/url, no magnet found on the page).
4. This does **not** replace the blank-query-browse-against-the-real-site
   check in section 8 - fixtures catch parsing regressions, not "the live
   site changed its markup" or "this category returns zero results on this
   tracker".

---

## 13. Open issues

**Brittleness.** The solver depends on the widget DOM shape and the `+22px`
checkbox offset. Cloudflare can invalidate either at any time. Expect it, and
check a screenshot first when it breaks.

**ext.to's `totalHint` regex is unverified against the live site.** It
generically matches `"X - Y from Z"` anywhere in the page text rather than a
confirmed selector - low risk since `total` only feeds the non-load-bearing
`opensearch:totalResults`, but worth checking if that field ever starts
looking wrong.

**EZTV's blank-query browse bypasses the browser entirely.** It calls
`https://eztvx.to/api/get-torrents` with a plain `fetch()`, not
`gotoCleared()`. If that endpoint ever gets put behind Cloudflare, browsing
breaks (keyword search via the scrape flow would be unaffected).

**`xdo()` swallows errors.** Not currently causing problems, but if the
warm-up movement ever silently no-ops, the widget stays on "Verifying..." and
the click lands on nothing. Verify the mouse actually moves:

```js
execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: ':99' } })
```
