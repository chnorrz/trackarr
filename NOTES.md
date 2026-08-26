# Working notes

Hard-won facts about this project, condensed to what's still true today.
Several "obvious" theories here are recorded because they turned out to be
**wrong** - don't re-litigate section 5's "Ruled out" list without new
evidence.

---

## 1. What this is

A Torznab server making scraper-hostile torrent trackers usable as "Torznab
(Custom)" indexers in Prowlarr. One indexer per provider, one process
(shared browser + cache). TypeScript strict; `npm run build` ->
`dist/*.js`; the Docker image only runs compiled output, no `ts-node` at
runtime.

| File | Role |
|---|---|
| `server.ts` | Torznab endpoints: `/:provider/api`, `/:provider/download` |
| `lib/browser.ts` | Camoufox session, one persistent page per host, proxy routing, `cfFetch()` |
| `lib/challenge.ts` | Cloudflare detection + XTEST auto-solver |
| `lib/cache.ts` | TTL cache (search 5 min, magnets 1 h) |
| `lib/categories.ts` | Torznab category ids (71-entry vocabulary) + `categoriesXml()` |
| `lib/paging.ts` | `fetchPagedWindow()`/`fetchMergedBrowse()` - depth-capped pagination |
| `lib/types.ts` | `Provider`/`SearchItem`/`MagnetRef`/`ResolvedDownload` |
| `providers/*.ts` | Hand-written per-tracker, `export default {...} satisfies Provider` |
| `lib/cardigann/` | Prowlarr Cardigann v11 YAML loader + engine - section 17 |
| `definitions/*.yml` | Shipped Cardigann definitions - **never edited**, section 17 |
| `tools/tinyproxy.conf` | Proxy config, runs on the **host** (section 4) |

New hand-written tracker: `providers/<id>.ts` + register in
`providers/index.ts`. New Cardigann one: drop a `.yml` in `definitions/` or
name it in `config/trackarr.yml` - no code.

---

## 2. ext.to

Search: `https://ext.to/browse/?q=<query>` - **not** `/search/` (WAF
challenge). Blank-query browsing needs `age=4` too or it renders a
category-picker with 0 rows. Rows: `table.search-table tbody > tr`.
Title/detail: `a.torrent-title-link`. Id: `a.search-magnet-btn[data-id]`.
Size: `td[1] span:last`. Age: `td[3] span:last`'s `title` attr has the exact
date (text is relative).

**Category uses breadcrumb *hrefs*, not link text, at both levels**
(`.related-posted a[href^="/"]:not([href^="/user/"])` - that selector also
contains an uploader link in 3 different shapes). Text drifts
(`/books/audio-books/` renders "Audio books"); some categories only exist
at subcategory level. `CATEGORY_RULES` in `providers/ext-to.ts` is keyed on
full delimited href segments, most-specific-first. No XXX category exists.

**Magnets**: `/ajax/getSearchMagnet.php`,
`hmac = sha256(torrentId|timestamp|token)`, token from
`window.searchPageToken` + `<meta name="csrf-token">` - both **only exist
on a search/browse listing page, never an item's permalink** (confirmed
live, cost a Cardigann redesign - section 17). No detail-page visit needed:
`data-id` + a fresh token page is enough. Client logic
(`/static/js/advanced-search-list.js`) is Cloudflare-protected - fetch
through the browser, not curl.

---

## 3. 1337x

Lighter protection, no cookie. Search: `https://1337x.to/search/<query>/1/`.
Rows: `table.table-list tbody > tr`. Title: `td.coll-1.name
a[href^="/torrent/"]`. Size `td.coll-4.size` has a nested duplicate span -
strip children or get `"2.2 GB28818"`. Magnet on the detail page, no HMAC.
No exact dates.

**Category: use the row icon's `/sub/<id>/` href, never the CSS class** -
the class (`flaticon-hd` etc) drifted and now collapses TV into Movies.
`providers/1337x.ts` trims to `/sub/<id>/` and matches 1:1 (no substring
collision - `/sub/19/` can't match `/sub/190/`). No class fallback exists;
unrecognized ids land on `CATEGORIES.OTHER`.

**IPv4-banned, IPv6 clean but challenge-gated** - needs the host proxy
(section 4) via `DOMAIN_OVER_PROXY=1337x.to`.

---

## 4. IPv4 bans and the IPv6 proxy

Some trackers ban IPv4 while IPv6 stays clean - works in a desktop browser,
fails from the container. **Check this first.** Symptoms: Cloudflare error
1006 / a terse ~17-byte body (check response size, not just the "banned"
string), no Turnstile so the auto-solver can't help.

Diagnose: `dig +short AAAA <host>`; `curl -4`/`curl -6` compare; in-browser
control via `firefox_user_prefs: { 'network.dns.disableIPv6': true }`.
Colima's VM has no IPv6 egress, so enabling IPv6 in Docker does nothing -
traffic must leave via the **host**.

**Fix**: tinyproxy on the host, routed only for the banned domain via a PAC
script (`lib/browser.ts`'s `buildPacDataUri()`) driving Firefox's
`network.proxy.*` prefs directly - not Playwright's own `proxy` option,
which is proxy-by-default-with-bypass and can't express "direct except
these hosts". `CONNECT` only pipes bytes, so TLS/fingerprint are unchanged.

```bash
brew install tinyproxy
launchctl submit -l ext-tinyproxy -o /tmp/tp.log -e /tmp/tp.err \
  -- "$(which tinyproxy)" -d -c /path/to/tools/tinyproxy.conf
docker run ... -e PROXY_URL=http://192.168.5.2:8888 -e DOMAIN_OVER_PROXY=1337x.to ...
```

(`192.168.5.2` under Colima, `host.docker.internal` elsewhere. Use
`launchctl submit`, not `nohup`/`disown` - a tool-shell background process
dies with the shell; `setsid` doesn't exist on macOS.)

| Var | Meaning |
|---|---|
| `PROXY_URL` | e.g. `http://192.168.5.2:8888`. Unset = disabled entirely. |
| `DOMAIN_OVER_PROXY` | Comma-separated hostnames (+subdomains) routed through it. Unset = none. |

Routing is decided **per request** by the PAC script - opt-in per host, not
per provider. Don't proxy a domain that works directly: `cf_clearance` is
IP-bound, proxying invalidates an already-clear domain's clearance.

**Fixed gotcha, don't reintroduce**: a whole-context proxy (forcing *every*
connection) breaks Cloudflare's own Turnstile widget - its asset host can
be **IPv4-only**, so an IPv6-bound socket can't reach it and every
challenge hangs at the nav timeout. The per-request PAC fixes this since
only the banned hostname is ever forced onto the proxy.

---

## 5. Cloudflare: what is and isn't true

```js
isChallenge = html.includes('cf-turnstile') || html.includes('Just a moment')
isBlocked   = html.includes('Access denied') && html.includes('Cloudflare')
```

Never use `challenge-platform` as a marker - injected on perfectly cleared
pages too. `isBlocked` matters separately: a hard ban has no widget, so
`isChallenge` alone misses it and looks like "0 results". Wrap
`page.content()` in try/catch - throws mid-navigation. A Cloudflare
failure is often **transient** (rate-limiting) - the next request typically
self-heals via `cfFetch`'s own fast-path retry, so it's surfaced once
rather than silently retried in a loop.

**Ruled out as discriminators** (all measured, byte-identical to real
Firefox - don't re-litigate): headless detection, WebGL/fonts,
cookie/session reputation, Camoufox's own patches, `navigator.webdriver`,
TLS JA3/JA4, HTTP/2 fingerprint, header order, IP reputation.

**`cf_clearance` is bound to**: User-Agent exactly (Camoufox randomizes OS
per launch - pin `os` if persisting one), IP, and OS/TCP stack (a cookie
solved on macOS is rejected when replayed from Linux, even with identical
TLS/headers/UA/IP). **Not** TLS fingerprint browser-to-browser. Node's
`fetch`/undici has a different TLS stack and can't replay it at all -
every fetch, including POSTs, runs inside the browser page.

**Clearances are never persisted to disk, deliberately.** Persisting only
the UA desyncs it from the rest of Camoufox's fingerprint (a tell of its
own), and a mismatched clearance is *worse* than none (live-caught: "no
widget ever rendered" until a stale file was deleted). Also IP-bound
regardless, so persistence wouldn't fully fix it anyway. Measured lifetime
~359 days - expiry was never the real failure mode. Cost: one cold solve
per provider per restart, absorbed by keep-alive at boot (section 9).

---

## 6. The auto-solver

`lib/challenge.ts` (detection + XTEST loop), called from `lib/browser.ts`
on a challenged fetch. Fragile, empirically-derived:

1. **Never run page scripts during a solve - `page.evaluate()` resets the
   challenge.** Use Playwright *locators* (isolated world) instead;
   `page.content()` counts, it's `evaluate` underneath. Wrong: zero solves,
   ever. Fixed: 6-12s, 2-3 clicks. One `evaluate` remains
   (`mozInnerScreenX/Y`, cached after first read).
2. **Input via XTEST (`xdotool`), not `page.mouse`** - Turnstile ignores
   synthetic input in its cross-origin iframe unless COOP is disabled,
   which Camoufox itself flags as WAF-detectable.
3. **Page -> screen coordinate translation**:
   `screenY = window.mozInnerScreenY + rect.y` (Firefox chrome offset,
   ~57px). Varies per launch - don't pin the viewport to "fix" that.
4. **Display needs a real size** - Camoufox's `headless:'virtual'` is a 1x1
   Xvfb screen. Run `Xvfb :99 -screen 0 1280x900x24`, `headless: false`.
5. **Clamp coordinates >= 0** - `xdotool` reads a leading `-` as a flag and
   fails silently (swallowed, see section 14).

**Locating the widget**: closed shadow DOM, `shadowRoot` always `null`.
The only light-DOM anchor is a hidden, zero-size response input
(`input[name="cf-turnstile-response"]`) - walk up to the nearest ancestor
with a real box (`width>40, 20<height<120`), click its left edge (+~25px,
vertically centered).

**Ordering: poll, don't wait-then-navigate.** Every `POLL_INTERVAL_MS`
(250ms): is it gone already? If not and the click cooldown
(`CLICK_COOLDOWN_MS` 4s) elapsed, find and click the widget. "Not found
yet" isn't failure - only the overall budget (`SOLVE_BUDGET_MS` 45s)
running out is. Checking "already gone" first matters: a challenge can
clear *passively* mid-poll.

**"Humanized" mouse movement buys nothing** once #1 is fixed - an earlier
A/B favoring it was really measuring how long a self-resetting challenge
took to give up. Plain `mousemove`+`click` solves in 6-12s; added
jitter/easing made it slower with no better success rate.

**Knowing when it's actually done** - two protocol-level signals, both
required (DOM-selector detection is unreliable: Turnstile markup renders
2-4.5s *after* the interstitial paints, causing false "cleared" under 0.5s):
1. A nav response with **no `cf-mitigated: challenge`** header (status
   ignored - some sites clear via a 302 to a different URL).
2. URL carries **no `__cf_chl_tk`** (not `__cf_chl_rt_tk`, which fires
   ~100ms in and means nothing).

**After a solve, don't navigate** - Cloudflare has its own in-flight
client-side redirect; a fresh `page.goto()` races it and hangs. Just poll
for the exit signals, return; the caller's normal fetch picks up from
wherever Cloudflare's redirect landed.

**No challenge found on entry isn't an error** - two concurrent `cfFetch()`
calls share a page; the second may reach the solve mutex after the first
already cleared it. Banned (`isBlocked`) throws; real content with no
challenge markers returns success; unreadable page falls through to poll
(unknown, not "clear").

**1337x/EZTV clear passively (0 clicks)** usually; **ext.to needs the
click.** Don't assume a checkbox is always involved.

**Concurrent navigations to one host hang** - `page.goto()` itself needs
serializing (`serializeNav`, mirroring `serializeSolve` for XTEST input,
global to the X display), and the browser-launch singleton must cache the
in-flight *promise*, not just the resolved result, or concurrent first
callers each launch their own Camoufox.

---

## 7. Environment gotchas

- **Colima doesn't mount the host's `/tmp`** - `-v /tmp/x:/data` mounts a
  VM-local dir with stale files. Use named volumes or `docker cp`.
- **Docker builds exceed the tool timeout** - run detached, poll the log.
- **Keep `npx camoufox-js fetch` above the source `COPY`s** or every edit
  re-downloads 654 MB.
- **`DEBIAN_FRONTEND=noninteractive` is mandatory** - `x11vnc` pulls
  `tzdata`, blocking on an interactive prompt otherwise.
- **A full host disk corrupts containerd** - recovery: `colima delete
  --force`, remove `~/.colima/_lima/_disks`, `colima start` (destroys
  everything).
- **Background processes die with the tool shell** - `nohup`/`disown`
  aren't enough. Use `launchctl submit` (`setsid` doesn't exist on macOS).
- **Never cache empty results** - a transient failure got cached for the
  full TTL and kept being served after the fix, looking like a parser bug.

---

## 8. Debugging playbook

- **Never conclude "the site banned/escalated us" without a control** -
  wrong twice. Keep a known-good standalone script.
- **Screenshots are ground truth** for widget state.
- **Remove old test containers first** - each holds its own ~400-800MB
  Camoufox; Colima defaults under 2GB, easy to OOM-kill the one under test
  (`docker inspect -f '{{.State.OOMKilled}}'`).
- **Never `docker exec node -e "..."` against a live server container** -
  it launches its *own* Camoufox, fighting the running one for
  CPU/Xvfb. Use real HTTP against a live container; use a scratch
  long-lived debug container for one-off scripts:
  ```bash
  docker run -d --name dbg trackarr:test bash -c "Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX & sleep 3000"
  docker cp probe.js dbg:/app/probe.js && docker exec -e DISPLAY=:99 dbg node /app/probe.js
  ```
- **Test the real code path** (`import('/app/lib/browser.js')`'s real
  `cfFetch`), not a reimplementation.
- **`page.evaluate()` error stacks contain `juggler` frames** from the
  debugger harness - not visible to a real site.

**Before calling a provider done**: verify blank-query browse (`q=''`,
Prowlarr's Test/Save) returns real results for every claimed category - a
term good for one tracker can return zero on another.

---

## 9. Keep-alive

A cold solve costs ~20s - too slow inside a live search. A background task
visits each provider's `keepAlive.url` periodically via the same
`cfFetch()` a real fetch uses (checks rather than solves), also warming the
persistent page. Boot: ~19s with a solve; later ticks: <3s, no solve.
`KEEPALIVE_INTERVAL_MS` (default 15 min, `0` disables, ±20% jitter) is a
guess - real clearance lifetime was never measured, only estimated
15-30 min.

---

## 10. `cfFetch()`: the single fetch/cache/download primitive

`lib/browser.ts` exports one function everything goes through:
`cfFetch(url, opts?)` (`opts` shaped like `RequestInit`). No `providerId` -
the persistent page is keyed by `new URL(url).hostname`. Returns a
`CfResponse` (`text()`/`buffer()`, re-readable, optional `filename`) -
**auto-detects a normal page vs. a raw file download**, no caller decision
needed.

**Per-fetch caching, not a top-level result cache** - pagination made a
top-level `SearchResult` cache a bad fit (zero sharing between adjacent
offset pages; some sources rescan from page 1 regardless of offset). Each
`cfFetch()` is cached individually (`TTLCache<string>`, 5 min, key = hash of
`method+url+body` - a POST's response depends on its body too). Tradeoff:
the status page's "% cached" stat is always 0% for search now (caching
moved below where that's measured); the separate `magnetCache` (1h) is
unaffected.

**One persistent, already-cleared page per hostname**, reused: (1) fast
path - `page.evaluate(fetch(url, init))` through the page's own live
session, same cookies/fingerprint, skips navigation; (2) slow path (fetch
failed or looks challenged) - navigate to recover (section 6), retry.
Recovery is per-request, not tied to keep-alive's schedule.

**Auto-detecting a download.** `page.goto()` throwing
`"Download is starting"` for a direct file response **is** Firefox's own
`'download'` event signal (confirmed by reading playwright-core's source:
`_onDownloadCreated` fires that exact message at the point it dispatches
the event) - not a dead end. `navigateOrDownload()` arms
`page.waitForEvent('download')` before every plain-GET nav; if it fires,
real bytes + the real `Content-Disposition` filename come back directly -
no bencode parsing anywhere in this codebase. Download results are
**never cached** (cheap to re-fetch, normally one-shot). Two correctness
details:
- **A POST's warm-up nav must never be treated as a download**
  (`allowDownload = method==='GET' && !body`) - falls back to the old
  "warm the bare origin" behavior instead, or a download response on a POST
  url would silently skip the POST entirely.
- **A challenge-gated url that's also a cross-origin-redirecting download**
  needs one more nav after the challenge solves (the first nav only ever
  saw the challenge page) - retried once, only on the post-solve fetch
  failure, so the common case (challenge -> ordinary page) pays nothing
  extra. **Reasoned + unit-tested, not live-verified.**

**Rejected: `context.request` instead of the real Download API** - a
genuinely separate network stack from the browser (no fingerprint, and its
own proxy resolution ignores `DOMAIN_OVER_PROXY`'s PAC entirely, silently
egressing direct - confirmed live with a dead-port PAC test). **Rejected:
an `OPTIONS` probe** to pick a path first - same CORS problem it would
probe around, and doesn't reliably describe a subsequent GET anyway.
`page.goto()` already **is** the probe. A download-triggering nav is
confirmed non-destructive (URL/JS context/cookies untouched), so it's safe
on the shared persistent page.

`lib/cardigann`'s `Fetcher` is structurally identical to `CfResponse`, so
`providers/index.ts` passes `cfFetch` straight through with no adapter.

---

## 11. Pagination, blank-query browsing, per-provider categories

Blank `q` (Prowlarr Test/Save, Sonarr/Radarr "search all") passes straight
to `provider.search('', opts)` - no `testQuery` substitution. Every
provider implements a real "browse latest for category X" path.

`SearchOptions.categories?: number[]` (OR semantics). Blank `q`: each id
resolved through a provider's `CATEGORY_BROWSE` table; zero resolved ->
empty, 2+ -> `fetchMergedBrowse`. No `cat` at all -> each provider's own
general browse - ext.to/EZTV have a real "all categories, newest" listing;
1337x doesn't, so it mirrors Prowlarr's own reference Cardigann definition
instead of inventing behavior (a fixed 4-category page-1-only snapshot).
Real keyword search: `categories` becomes a result-level filter instead,
since none of these trackers filter server-side.

`fetchPagedWindow()` fetches only as many site pages as needed for
`[offset, offset+limit)` and caps `total` at `depthCap` (200) - Prowlarr's
client paginates indefinitely otherwise (`opensearch:totalResults` isn't
actually parsed by Prowlarr; the cap is what really bounds it). With a
category filter it sequentially scans from page 1 instead (match density
per page is unknown). `fetchMergedBrowse()` runs it per category source,
merges by `pubDate` descending, slices once.

`Provider.categories: number[]` declares exactly which ids a provider can
produce; `categoriesXml()` renders only those - previously every provider
advertised one shared global list regardless of what it could produce.

---

## 12. Torznab spec compliance

Audited against Torznab v1.3 draft. `t=` values unhyphenated (`t=search`,
not `t=tv-search` - that's only the caps *element* name). `cat` is
comma-separated OR, syntax-validated (`^\d+(,\d+)*$`, error `201`)
separately from unknown-but-valid ids (silently ignored). `limit` clamped
to `MAX_LIMIT=100`. Category XML nesting follows `X000`/`Xnnn` for every
subcategory. Errors are spec-shaped XML with **HTTP 200**
(`<error code="N" description="...">`): `100` bad apikey, `200` missing
param, `201` bad param, `203` unknown `t=`, `900` internal error.
`offset`/`limit` reject non-integer/negative with `201`.

---

## 13. Testing

`npm test` builds then runs `node --experimental-test-module-mocks --test
"test/**/*.test.ts"` (340 tests). `npm run typecheck` checks source+tests.
CI gates both; the release build depends on the `test` job. **No
browser/Docker/network needed** - the mock boundary is `cfFetch()`.

- **Providers**: mock `cfFetch` via `mock.module()`, assert against
  hand-built `test/fixtures/` (fake titles/hashes, real selector
  structure - never raw captured HTML).
- **`lib/challenge.ts`**: no mocking - covers markers + the paths that bail
  before touching a page; the click loop is only exercised live.
- **Server**: `createApp(providers, opts?)` is a pure factory - tests hit
  `app.listen(0)` with real `fetch()`, fresh `TTLCache`s per call.

`mock.module()` gotchas: needs `--experimental-test-module-mocks`; register
**once per file** (re-registering throws `ERR_INVALID_STATE` - use
`.mock.mockImplementation()` to vary behavior instead); mock by absolute
`path.join(ROOT, 'dist', ...)`; an untyped `mock.fn()` infers its signature
from the first implementation - type it explicitly if a later
`mockImplementation()` changes shape.

Tests import **compiled** `dist/*.js`, never raw `.ts` (production
`.js`-extension imports don't remap under Node's native TS execution) -
except sibling test helpers, which use explicit `.ts`. Use the quoted glob
`node --test "test/**/*.test.ts"` - bare `test/` or unquoted `**` fail to
discover correctly.

---

## 14. Known open issues

- Solver depends on the widget DOM shape and a `+22px` offset - Cloudflare
  can invalidate either any time; check a screenshot first.
- ext.to's `totalHint` regex is unverified live - low risk, only feeds
  non-load-bearing `opensearch:totalResults`.
- EZTV's blank-query browse bypasses the browser/Cloudflare entirely -
  breaks if that endpoint ever gets protected.
- `xdo()` swallows errors - a silent no-op click has no visible signal;
  verify via `xdotool getmouselocation`.
- Section 10's challenge-gated-download rescue path is reasoned/unit-tested
  only, never live-verified.

---

## 15. Page recycling: a browser tab can die without closing

Symptom hit live: one provider failed every keep-alive for 14 hours while
others kept working - looked like a proxy regression or Cloudflare
withdrawing the widget; both ruled out (a `curl` through the same proxy
worked in 47ms; exactly one browser process running, not a launch race).
Root cause: a tab had stopped navigating **without ever closing**, and the
persistent-page cache only evicted on `isClosed()` - the dead tab was
handed to every caller forever.

Fix: `recyclePage()` - any throw out of `cfFetch()` drops that page from
the map and closes it. Delete from the map *before* `close()` (which can
itself hang on a wedged page - don't block recovery on it); evict by page
identity, not hostname (a slow failure can arrive after a sibling call
already replaced the entry). No retry threshold - `cf_clearance` lives on
the browser context, not the page, so a replacement costs one navigation,
no re-solve.

If this recurs and recycling doesn't fix it: check for a poisoned
connection pool instead (Firefox pools per-profile, a new tab wouldn't
help) - needs a full relaunch, which today has two unfinished
prerequisites (`closeBrowser()` doesn't clear the launch-promise cache;
`lib/challenge.ts`'s cached screen offset would survive a relaunch,
harmless only because `WINDOW_SIZE` is pinned).

---

## 16. EZTV

Two response layouts depending on a site preference: **links revealed** (6
`<td>`s) vs **hidden** (5 `<td>`s, magnet cell *omitted* not emptied -
shifts every later column, so positional selectors read the wrong cell).
Size comes from `a.epinfo`'s `title` attr, layout-independent; seeds from
`td.forum_thread_post_end` (class, not position). **No leechers column in
either layout** - always `0`, so `peers === seeds`.

Links revealed via a single cookie on an ordinary GET
(`layout=def_wlinks`, matching Cardigann's own definition), applied via
`registerDomainCookies()` -> `context.addCookies()` at session launch (not
just boot, so a relaunch after recycling doesn't drop it). Rows with no
magnet at all are skipped even with the cookie set -
`parseSearchRows()` throws if rows were present but all got skipped
(a silently non-applying cookie would otherwise look identical to "no
matches").

Title cleanup deviates from Cardigann's own greedy
`re_replace: ["\(.*\)$", ""]` (destroys everything from the *first* paren
onward on a title with an earlier one, e.g. a year) - uses an anchored
`/\s*\([^()]*\)\s*$/` instead. Blank-query browse (`browseLatest()`) hits
`/api/get-torrents` with a plain `fetch()` - not Cloudflare-protected, not
touched by any of the above.

---

## 17. Cardigann support (`lib/cardigann/`)

Lets a tracker be added by dropping a Prowlarr Cardigann v11 YAML into
`definitions/` (or naming a `source:` pin/URL in `config/trackarr.yml`)
instead of hand-writing a provider. Fully wired into `server.ts`'s boot -
a configured indexer is a real `/<id>/api` Torznab endpoint.

**Hard policy: vendored `.yml` definitions are never edited**, ever -
byte-identical to upstream forever (diff against a fresh re-fetch if in
doubt). **Every fix belongs in the engine, never the YAML** - so any
Prowlarr-authored definition can be dropped in and work unmodified.
`schema-extensions.json` (an RFC 6902 patch via `fast-json-patch`) is the
one sanctioned way to accept trackarr-only syntax (`sha256`/`concat`
filters, `search.vars`, `download.before.vars`/`allowEmptyInputs`) beyond
upstream's schema - a definition needing any of it validates only against
the *extended* schema and is marked `portable: false`.

**Two validation gates.** Schema-valid (vendored Prowlarr v11 schema,
Ajv2019 + `ajv-formats`) doesn't mean runnable - `capability.ts` rejects
what the engine can't execute: `type: private`/`semi-private` + any
`login` block (deliberately out of scope), `rows.dateheaders`/`rows.after`
(rare, deferred), any filter outside the ~26 implemented (`jsonjoinarray`
is the one gap). Settings in general, and
`fields.infohash`/`download.infohash`/`download.before`, are **not**
blockers, despite looking like they should. Last full-corpus scan (547
upstream v11 definitions): 76 runnable end to end - re-run
`npm run validate:definitions` on a fresh clone if this number matters
again, it drifts with upstream. `yaml`, not `js-yaml`, is the parser: the
latter's default schema turns ISO-date-looking scalars into `Date` objects,
failing `type: string`.

**Config (`config/trackarr.yml`)**: keyed by instance name (also the
route). Two instances can share one `definition:` (different `config:`
overrides) - each gets its own in-memory cache, never shared. Resolution
order: `DEFINITIONS_DIR` volume (wins even over an explicit `source:`) ->
`source:` pin/URL (fetched, disk-cached under `CARDIGANN_CACHE_DIR`, falls
back to the cache on fetch failure) -> bundled `definitions/`. `source:`
pins resolve to a **commit SHA**, never a branch - reproducibility. A
schema-invalid config, or any of four cross-checks needing both documents
at once (instance id collides with a built-in provider; `link:` isn't in
the definition's own `links[]`; a `config.<key>` isn't a declared setting;
a `select` value isn't a declared option) - all **fatal, refuse to boot**.
One indexer entry's own resolution/capability failure is logged and
excluded; everything else still boots.

**Engine** (`filters,template,select,engine,extract.ts`) - pure functions,
**no network I/O**; `runSearchAll(definition, body, ctx)` takes an
already-fetched body. ~26 filters implemented (date/time via a hand-rolled
.NET-token-to-regex compiler). A hand-written Go `text/template` subset
(`if/else`, `or`/`and` real-value semantics, `eq`/`ne`, `join`, `range`,
inline filter calls, recursive parenthesized groups) - scoped to exactly
what the wiki documents. Selectors: one `Row` interface over HTML/XML
(cheerio) and JSON (a small hand-written recursive-descent parser for
Cardigann's own `:has()/:contains()`-on-path-segments grammar - not general
JSONPath). `case` blocks work oppositely: HTML keys are CSS selectors,
first match wins; JSON keys are value-compared against a sibling
selector's result. `remove` mutates the row for every later field on it.
Field extraction runs in declared object order (needed for `.Result.*`
cross-references between fields). Category mapping happens once after
extraction and isn't written back into `.Result`.

Trackarr-only extensions, all schema-patched: `search.vars` (`.Vars.*`,
once per response, for a page-level token every row needs);
`sha256`/`concat` filters (HMAC-signed links); `.Now` (bound once per
response so a body timestamp and a hash of it can't observe different
clock reads); `download.headers` reaching the network; `$`-prefixed
download selectors reading JSON; `download.before.vars`/`allowEmptyInputs`
(the `search.vars` mechanism, scoped to download resolution).

**Adapter** (`adapter.ts`) - `createCardigannProvider()` ties it all
together with an injected `Fetcher` (real callers pass `cfFetch`
directly). `requestDelay` gates every HTTP call through one wrapper.
Multi-path searches concatenate every unrestricted path unconditionally,
filter by requested categories, slice offset/limit once (not per-path, or
items could be missed across a page boundary). Magnet priority at listing
time (cheapest first): bare `magnet:` field, then a `download:` field
already starting with `magnet:`, then bare `infohash:`.
`resolveMagnet()`'s cache-miss path only has `{id, url}` - falls back to
the row's own captured download URL via a second small cache
(`downloadUrlCache`), so it doesn't silently re-fetch the detail page
instead when the two differ. `.Config.sitelink` is always the resolved
base URL, injected after `entry.config` so it can't be overridden.
`caps.settings[].default` seeds `.Config`; a boolean setting coerces to
`''`/`'True'` (matching `.False`/`.True`), not `String(v)` (which would
render `false` as truthy `"false"`).

**`download.ts`** implements `before -> selectors -> infohash`.
`selectors[]` is an ordered **fallback list by design** - a selector that
matches but points at a dead link falls through to the next, only an
empty match used to abort. A resolved non-magnet link is fetched for real
bytes via the same `Fetcher`; first byte must be ASCII `'d'` (every
`.torrent` is bencoded) or it throws with a clear reason.
`sanitizeFilename()` prefers the fetcher's real `Content-Disposition` name,
falling back to the item title only if empty (`resolveMagnet`'s
cache-miss path always passes `itemTitle: ''`). No canonical tracker list
exists in the format's docs for `infohash`-built magnets - the four used
here came from a real, live-captured magnet URI.

**Live-verified today**: `kickasstorrents-to.yml`, `ext-to.yml`
(redesigned during its live test to zero extra fetches - the whole signed
AJAX request is built into `fields.download` as a template) and vendored,
unmodified `1337x.yml`/`eztv.yml` all resolve real search results and real
magnets/`.torrent` bytes against their live sites, including in Docker
under the real Linux `headless:false`+Xvfb path. Hand-written
`providers/{ext-to,1337x,eztv}.ts` are untouched and still the live routes
- whether to retire them now that their Cardigann equivalents are proven
correct is still open.
