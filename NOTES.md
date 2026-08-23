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
| `lib/browser.ts` | Camoufox session, one persistent page per host, proxy routing, cached fetch |
| `lib/challenge.ts` | Cloudflare challenge detection and the XTEST auto-solver |
| `lib/cache.ts` | TTL cache (search 5 min, magnets 1 h) |
| `lib/categories.ts` | Torznab category ids + `categoriesXml()` (per-provider caps rendering) |
| `lib/paging.ts` | `fetchPagedWindow()` - offset/limit pagination with a depth cap |
| `lib/parse.ts` | Shared size-string parsing |
| `lib/types.ts` | `Provider`/`SearchItem`/`MagnetRef` shared interfaces |
| `providers/*.ts` | Per-tracker, each `export default {...} satisfies Provider` |
| `lib/cardigann/` | Prowlarr Cardigann YML definition loader/validator - see section 17 |
| `definitions/*.yml` | Shipped Cardigann definitions (also read from `DEFINITIONS_DIR`) |
| `tools/tinyproxy.conf` | Proxy config, runs on the **macOS host** (see 1337x) |

Adding a hand-written tracker: write `providers/<id>.ts`, register in
`providers/index.ts`. Adding a Cardigann-defined one: drop a `.yml` file in
`definitions/` or `DEFINITIONS_DIR` - see section 17.

---

## 2. ext.to

### Search

- URL: `https://ext.to/browse/?q=<query>` — **not** `/search/`, that path
  triggers a WAF challenge.
- Bare `/browse/` without `?q=` does **not** render `searchPageToken`. If you
  just need a token, use a realistic query.
- Bare `/browse/` with **no `q` and no `cat`** (the "all categories, newest"
  general listing used by blank-query browsing - see section 11) also needs
  `age=4` or it renders a category-picker landing page instead of a results
  table entirely (0 rows, no `<table>` at all in the response) - confirmed
  live. This is exactly what made Prowlarr's blank-query "Test" button fail
  with "no results were returned from your indexer" until fixed.
  `generalBrowsePage()` in `providers/ext-to.ts` sends it.
- Rows: `table.search-table tbody > tr`

| Field | Selector |
|---|---|
| title / detail URL | `a.torrent-title-link` (text, href) |
| torrent id | `a.search-magnet-btn[data-id]` |
| size | `td[1] span:last` (e.g. `1.98 GB`) |
| files | `td[2]` |
| age | `td[3] span:last` — **`title` attr** holds the exact date; the text is relative ("5 days ago") |
| seeds / leechers | `td[4]` / `td[5]` |
| category | `.related-posted a[href^="/"]:not([href^="/user/"])` **hrefs**, both breadcrumb levels, matched against `CATEGORY_RULES` (real search only — blank-query browsing already knows its category, see section 11) |

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

`CATEGORY_RULES` in `providers/ext-to.ts` is keyed on full, delimited href
segments now (`/tv/`, `/music/`, `/books/audio-books/`, etc), not bare
words - every keyword is the complete path fragment, not a loose substring
of it, for the same precision reason as 1337x's rules (section 3). Order
still matters: `/books/audio-books/` must stay above the generic `/books/`
rule, since it also contains `/books/`. `parseListing()` also gained an
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
- Category: from the sub-category id embedded in `td.coll-1.name a.icon`'s
  `href` (`/sub/<id>/...`) — the icon **CSS class** (`flaticon-movies`,
  `flaticon-tv`, ...) isn't used at all any more, since it's been observed
  to drift (live TV rows render `flaticon-hd`, identical to HD movies —
  see section 3's own "Category drift" note below, and section 11's
  `knownCategory` design for how blank-query browsing sidesteps category
  detection entirely by already knowing which category it asked for).
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
stable signal than the CSS class. `providers/1337x.ts` matches this the
same way ext.to matches its own category breadcrumb (`CATEGORY_RULES` +
`matchCategory()` - see section 2), for consistency between the two
providers rather than two different lookup mechanisms: the href is first
trimmed with a regex down to just the `/sub/<id>/` segment (dropping the
trailing page number, `/sub/19/0/` -> `/sub/19/`), so what reaches
`matchCategory()` is exactly the meaningful part and nothing else -
`CATEGORY_RULES`' ~70 entries are then each a single fully-delimited
keyword (`['/sub/19/'], CATEGORIES.PC_MAC`), so the match is a clean 1:1
lookup rather than a fuzzy substring search: `/sub/19/` can never be a
substring of `/sub/190/` (the character after "19" would have to be `/`,
not another digit), so this has zero collision risk despite using the same
substring-matching primitive ext.to's rules use, and rule order genuinely
doesn't matter here (unlike ext.to's, which need specific-before-generic
ordering for ambiguous text keywords) since every keyword already
identifies exactly one id. Table transcribed from 1337x's own live category
sidebar HTML for every top-level category — Movies/TV/Anime/Music/XXX/
Games/Apps/Other. A handful of "Other"-bucket sub-categories have no clean
1:1 Torznab equivalent and were mapped by judgment call (e.g. Comics ->
Books, Emulation -> Console/Other, Nulled Script -> generic PC) — check
`CATEGORY_RULES`' comments if a new one needs adding.

**The icon-class fallback was removed entirely**, not just demoted - it's
what drifted in the first place, so falling back to it for an unrecognized
sub id risks the exact same silent misclassification. `matchCategory()`
itself already defaults to `CATEGORIES.OTHER` (8000) when nothing matches,
so a sub id not yet in the table (a future 1337x subcategory) lands there
automatically rather than needing an explicit fallback.

Live-verified after the fix: the no-cat browse snapshot (see section 11)
went from 37/0/0/32+11 (Movies/TV/Anime/Other, badly misclassified) to an
exactly correct 20/20/-/20 split across Movies/TV/Music/Other.

### Reachability

1337x has banned our **IPv4** address; our IPv6 is clean. It therefore works
in a desktop browser but not from the container, and needs the host proxy —
see [section 4](#4-ipv4-bans-and-the-ipv6-proxy).

**Re-confirmed since, with a refinement.** IPv4 still returns the ban, but as
a terse 17-byte `error code: 1006` body that does **not** contain the
`banned your IP` string section 4's recipe greps for — that check can
false-negative, so also check the response size. IPv6 is no longer "clean" in
the sense of sailing through: it now gets a **Cloudflare challenge**. That is
a much better outcome than a ban, because a challenge is solvable — it
self-clears in ~7s (see section 6). The proxy is still required and still
working; traffic demonstrably reaches 1337x through it. Unlike other providers,
`providers/1337x.ts` requests nothing proxy-related itself - routing is
decided entirely by `lib/browser.ts`'s `DOMAIN_OVER_PROXY` (unset by
default), matched against the hostname of whatever URL is being fetched.

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
docker run ... -e PROXY_URL=http://192.168.5.2:8888 -e DOMAIN_OVER_PROXY=1337x.to ...
```

`tools/tinyproxy.conf` restricts access to localhost plus the Docker/Colima
ranges. Without those `Allow` lines it is an open relay on the LAN.

### Configuration (env)

| Var | Meaning |
|---|---|
| `PROXY_URL` | e.g. `http://192.168.5.2:8888`. **Unset = proxy disabled**, everything direct. |
| `DOMAIN_OVER_PROXY` | Comma-separated hostnames routed through it (a listed entry matches itself and its subdomains). **Unset or empty = none.** |

Deliberately opt-in, not opt-out: `PROXY_URL` alone does nothing - a hostname
has to be named in `DOMAIN_OVER_PROXY` too, or it goes direct regardless.
Not baked into `docker-compose.yml`'s defaults either - needing this at all
is specific to whichever tracker banned your IP, not something every
deployment should silently opt into.

Routing is decided **per request**, not per provider. `lib/browser.ts`
builds a PAC (Proxy Auto-Config) script from `DOMAIN_OVER_PROXY` and drives
Firefox's own `network.proxy.type`/`network.proxy.autoconfig_url` prefs with
it directly (bypassing Playwright's own `proxy` launch option entirely,
which only supports the opposite shape - proxy-by-default with a `bypass`
exception list, no way to express "direct by default, except these hosts").
Firefox then evaluates the PAC script for *every* request it makes, main
navigation and every embedded sub-resource alike - see the "Gotcha" below
for why that per-request granularity, rather than a per-provider flag, is
what actually matters here.

Cookies are no longer persisted at all (section 5), so the old rule about
keeping a proxied domain's `cf_clearance` out of the shared file - and the
`usingProxy`/`domainUsesProxy` plumbing that enforced it - is gone. Each
hostname's clearance simply lives in the browser jar for the life of the
process. Note the claim that used to be here was false in practice anyway:
`context.cookies()` with no argument returns *every* domain's cookies, so a
proxied domain's clearance did get written whenever a direct domain saved.

**Do not proxy a domain that works directly.** `cf_clearance` is bound to
the egress IP (section 5), so routing ext.to through the proxy would
invalidate the clearance it already holds for its direct egress.

### Gotcha: a whole-context proxy strands Cloudflare's own challenge assets

The naive version of this feature - route a banned tracker's *entire*
browser context through a `FORCE_IPV6`-bound tinyproxy - breaks on first
contact with reality. Even with a genuinely working `Bind` (confirmed
reaching the internet: a keepalive tick solved the Turnstile challenge and
succeeded once), every *subsequent* attempt failed, tinyproxy logging:

```
ERROR opensock: Could not establish a connection to hagen.challenges.cloudflare.com:443
```

...surfacing up the stack as the browser's own `page.goto` timing out at
60000ms, since the page's `load` event never fires while a render-blocking
Cloudflare script hangs mid-request.

**Cause**: a whole-context `Bind` forces *every* connection through tinyproxy
onto IPv6 - not just the request to the banned tracker. 1337x.to itself
embeds Cloudflare's own Turnstile widget, which loads its assets from a
Cloudflare-owned challenge subdomain (in this case
`hagen.challenges.cloudflare.com`). That subdomain can be **IPv4-only**:

```bash
dig AAAA hagen.challenges.cloudflare.com +short   # (nothing)
dig A hagen.challenges.cloudflare.com +short      # 104.18.8.208, 104.18.9.208
dig AAAA challenges.cloudflare.com +short         # has AAAA - the umbrella
                                                   # domain is dual-stack,
                                                   # but that's not the host
                                                   # actually being requested
dig AAAA 1337x.to +short                          # still has AAAA - the
                                                   # tracker itself is fine
```

An IPv6-bound socket cannot connect to an IPv4-only destination, so the
challenge widget's own asset fetch is permanently unroutable through the
proxy - not flaky, not transient, every single attempt fails identically.
The one early success was luck: that particular challenge instance happened
to get routed to a dual-stack Cloudflare edge host that time; subsequent
challenges got pinned to the IPv4-only one.

Two fixes were tried and rejected before landing on the PAC approach
described above:

1. **App-level bypass list** (`proxy.bypass` in `lib/browser.ts`, hardcoding
   Cloudflare's own domains to exclude). Works, but puts network-topology
   knowledge in application code where it doesn't belong, and only covers
   domains someone thought to list - a different, not-yet-seen IPv4-only
   asset host reproduces the bug again.
2. **Two chained tinyproxy instances** (`tinyproxy-edge` dual-stack +
   `tinyproxy-v6` forced, with an `Upstream` rule chaining only the banned
   domain to the forced one). Correctly scoped and validated working
   end-to-end, but needs a second proxy process/container just to express a
   routing decision Firefox can already make per-request on its own via PAC
   - once that was confirmed working, the second instance became pure
   overhead.

Neither is what's actually deployed now (see "Configuration (env)" above) -
kept here because the reasoning ruling them out is itself useful if this
resurfaces for a different tracker.

This also isn't the same as a generic "try IPv6, fall back to IPv4 if it
fails" policy, which would not work for the banned host regardless of which
layer implements it: 1337x.to's IPv4 *does* accept the TCP/TLS connection,
Cloudflare just serves a block page over it, so a naive fallback would never
even detect a failure worth falling back from - it would happily use the
banned v4 path. `DOMAIN_OVER_PROXY` sidesteps that: the banned host is
*always* forced onto v6 (no fallback, ever), while literally everything else
gets normal dual-stack behavior with no special casing needed.

Validated end-to-end with a real trackarr container against a genuinely
IPv6-forced tinyproxy (bound to a real routable address, not Colima's
non-routable one - see "Why enabling IPv6 in Docker does not help" above):
without domain-scoped routing, tinyproxy logs `opensock: Could not establish
a connection to hagen.challenges.cloudflare.com:443` on every run; with it
(first via the two-instance chain, then confirmed identically via the PAC
script talking to a single instance), that error never appears - confirmed
across repeated trials, tinyproxy's own log used as ground truth for which
hostnames actually reached it.

**Caveat found during that same testing, still open**: even with this fixed,
the Turnstile auto-solve step (`autoSolveChallenge()`) itself is separately
flaky - `still challenged` / `Cloudflare challenge did not clear (auto-solve
failed)` can still happen with zero proxy errors involved, i.e. the network
path was fine and the click-based solve simply didn't register or Cloudflare
didn't accept it. Possibly worse after repeated automated solves against the
same tracker in a short window (bot-score creeping up), possibly just
inherent Turnstile flakiness. Not something this fix addresses - if it
persists after deploying, that needs its own investigation.

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

**A Cloudflare failure is often transient** - live-observed a request fail
with "Blocked by Cloudflare (IP ban/rate limit)" and then succeed on a
plain retry a few seconds later, with nothing else changed. Looks more
like short-lived rate-limiting than an actual ban.

There used to be an inline retry for this (`navigateAndClear()` retried the
whole navigation once on any Cloudflare-related failure). It's gone, along
with that whole function: a failed solve now surfaces to the caller
directly. Two reasons. The retry doubled worst-case latency on exactly the
requests that were already slowest, and the fetch-first design means the
*next* request self-heals anyway - it tries a cheap same-origin `fetch()`
through the still-open page first, so a session that recovered in the
meantime costs nothing to pick back up. Live-confirmed: a failed EZTV
request followed by an immediate retry served real results in 0.95s with no
solve at all.

The tradeoff is real and was taken deliberately - a transient failure that
would previously have been absorbed silently is now one visible error in
Prowlarr, with recovery on the following request.

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

### Why cf_clearance is not persisted

Clearances live in the browser's own jar for the life of the process and are
**never written to disk**. There is no `.cf-cookies.json`, no `.cf-ua.txt`, no
`DATA_DIR`, and the image declares no volume. This was removed deliberately —
don't reinstate it without reading this.

The persistence never worked. `UA_FILE` arrived with the VNC solver
(`3b08b1e`); deleting that flow took the *writer* with it and left
`loadUserAgent()` reading a file nothing ever created. So every restart
replayed a stored clearance under a freshly randomised Camoufox fingerprint,
which is exactly what the list above says Cloudflare rejects.

**And a mismatched clearance is worse than none.** Live-caught: after a
container restart EZTV failed three times running with `no widget ever
rendered and the challenge never self-cleared` (full 45s budget each), then
succeeded immediately once `/data/.cf-cookies.json` was deleted.

Fixing it properly would have meant persisting the **whole fingerprint**, not
the UA. Camoufox generates a BrowserForge fingerprint where `userAgent` is one
field of `NavigatorFingerprint`, alongside `userAgentData`, `oscpu`,
`platform`, the header set, screen metrics, WebGL and fonts — all mutually
consistent. Overriding just the string via `newContext({ userAgent })`
desynchronises it from the rest, which is a detectable tell in its own right.
Camoufox does expose `fingerprint?: Fingerprint` for this, but
`generateFingerprint` is not in camoufox-js's public exports (only `Camoufox`,
`NewBrowser`, `launchOptions`, `launchServer`), so it needs a deep import or a
direct `fingerprint-generator` dependency, plus a version guard so a persisted
fingerprint doesn't outlive the Firefox build it describes.

Even then it could not be reliable: the clearance is bound to the **IP** too,
so any egress change silently invalidates it regardless of fingerprint.

Measured expiry, for the record: `cf_clearance` is issued with a **~359 day**
lifetime on all three trackers, so expiry is never the failure mode — the
fingerprint and IP bindings are.

Cost of dropping it: one cold solve per provider per restart, which the
keep-alive already performs at boot before Prowlarr asks (section 9: 19.3s /
17.3s at boot, sub-second after). That is what was happening in practice
anyway. It also deleted `usingProxy`/`domainUsesProxy`, which existed solely
to decide whether a proxied domain's clearance was safe to write to the shared
file.

---

## 6. The auto-solver

Lives in `lib/challenge.ts` (detection markers + the XTEST solve loop);
`lib/browser.ts` owns the session and calls into it when a fetch comes back
challenged.

This is the fragile heart of the project. Five non-obvious requirements,
all found empirically:

**1. Never run page scripts during a solve — `page.evaluate()` resets the
challenge.** Measure with Playwright *locators* instead: they resolve in an
isolated world and leave the page's own scripts alone. This is the single
most important fact in this document.

Symptom when violated: the widget never leaves "Verifying...", the Turnstile
iframe is created and destroyed in a loop, and the solver spends its whole
budget clicking a spinner. The poll loop asks several times a second, so a
single `evaluate` in the wrong place is enough to make the challenge
permanently unsolvable. **`page.content()` counts** — it is `evaluate`
underneath. Same constraint documented by byparr
(github.com/ThePhaseless/Byparr, `src/challenge.py`).

Cost of getting this wrong, measured: zero successful solves in ~100
attempts across ext.to/EZTV/1337x over several hours, on IPv4 and IPv6
alike, on every Camoufox version tried. After the fix, cold solves land in
6-12s and 2-3 clicks. It presents exactly like an IP/fingerprint reputation
problem, which is what cost the time — see section 5 before blaming the site.

Only one `evaluate` remains, for `mozInnerScreenX/Y` (requirement 3), and it
is read once and cached rather than per measurement.

**2. Input must be injected at the X server level (XTEST / `xdotool`).**
Turnstile ignores Playwright's `page.mouse` clicks *unless* COOP is disabled
(`disable_coop: true`), because the checkbox sits in a cross-origin iframe
that COOP keeps synthetic input out of. XTEST goes through the real input
stack and needs no such flag — and Camoufox warns that disabling COOP is
itself WAF-detectable.

Both were measured working once requirement 1 was fixed (`page.mouse` +
`disable_coop`: 10-12s; xdotool: 6-12s), so this is a choice, not a
constraint. xdotool is kept because it adds no detectable tell.

**3. Coordinates must be translated page → screen.**
`getBoundingClientRect()` is page space; `xdotool` is screen space. Firefox's
chrome offsets the content area:

```js
screenX = window.mozInnerScreenX + rect.x     // typically 0
screenY = window.mozInnerScreenY + rect.y     // typically 57
```

Getting this wrong clicks ~57px above the checkbox and silently does
nothing. Coordinates are computed dynamically and vary per launch (observed
`214,395`, `317,395`, `374,395`, `534,395` — all correct). **Varying
coordinates are not a bug; do not "fix" this by pinning the viewport.**

`mozInnerScreenX`/`Y` are Firefox-only and absent from `lib.dom.d.ts` (which
models a Chromium-shaped `Window`), so the `page.evaluate()` callback needs
a local interface and an `as unknown as` cast to reach them. They are
genuinely present at runtime - the callback only ever runs inside Firefox.

**4. The display must have a real size.**
Camoufox's built-in `headless: 'virtual'` uses a **1x1** Xvfb screen —
nowhere to render or click. Run our own `Xvfb :99 -screen 0 1280x900x24` and
launch with `headless: false`.

**5. Coordinates handed to `xdotool` must never be negative.**
`xdotool`'s own argument parser reads a leading `-` as the start of an
option, not as a negative number: `mousemove -38 100` fails with
`unrecognized option '-38'` instead of moving anywhere. Because `xdo()`
swallows failures (see section 14) this is **silent** — the mouse simply
doesn't move and the click lands wherever it happened to be.

Live-hit via the click-approach offsets, which step in from as far as
`-150,-80` before landing on the checkbox: any widget rendered near the top
or left edge pushes `cx+dx`/`cy+dy` below zero. Every `mousemove` therefore
clamps with `Math.max(0, …)`. Clamping rather than an escaping trick (e.g.
`--` end-of-options) is deliberate: there is no meaningful off-screen
position on a single-screen Xvfb display, so 0 is both a safe substitute and
never ambiguous with a flag.

### Locating the widget

The widget is in a **closed shadow DOM**. `document.querySelectorAll('iframe')`
returns `[]` and `element.shadowRoot` is `null` — you cannot reach the
checkbox or its iframe directly. Container ids are randomised per page load
(`#mZiFs3` etc.) — never hardcode them.

The only light-DOM element Cloudflare leaves behind is the hidden response
input, and **it has no dimensions**. Selecting it and using its rect is the
trap: `[id^=cf-chl-widget]` matches
`<input type="hidden" id="cf-chl-widget-XXX_response">` first, giving a
zero-size rect at the origin. That computes to `offX+22, offY+0` and clicks
empty page background — the "clicking checkbox at screen 22,57" signature,
repeated until the budget runs out. It fails silently and looks identical to
a widget that never rendered.

The shadow *host* does lay out normally, so walk up from the input to the
nearest ancestor with a widget-shaped box, and click its left edge:

```
input[name="cf-turnstile-response"] >> xpath=ancestor::div[N]   // N = 1..4
// accept: width > 40, 20 < height < 120   (a real widget row is ~65-70px tall)
// checkbox ≈ left edge + 25px, vertically centred
```

Bounds are load-bearing in both directions. Too small: the zero-height input
and its equally flat wrappers. Too large: while the widget is still
rendering every ancestor near the input is zero-height, so an unbounded walk
runs past them into the page's main content block — live-observed at
`960x176`, whose left-edge/centre point lands in the middle of the
interstitial's paragraph text.

Measure via locators, not `evaluate` (requirement 1) — `boundingBox()` gives
the same rect without touching the page.

**A rendered checkbox and a spinner have the same box.** Height cannot tell
them apart. If you need to know which is showing, screenshot the clip twice
~300ms apart and compare the buffers: the spinner animates, the checkbox is
static. Not needed by the current solver (it just retries on a cooldown), but
it is the only reliable signal found.

### Ordering: poll, don't wait-then-navigate

Working sequence: load → check for a challenge → then a tight poll loop,
once per `POLL_INTERVAL_MS` (250ms): is the challenge already gone? If not,
and enough time has passed since the last click attempt, look for the widget
and click it if found. "Widget not found yet" is **not** a failure - it just
means probe again sooner (`PROBE_INTERVAL_MS`, 500ms) instead of waiting out
the full click cooldown (`CLICK_COOLDOWN_MS`, 4s). Only the overall solve
budget (`SOLVE_BUDGET_MS`, 45s) running out is failure. This mirrors another
Turnstile solver's approach (byparr, github.com/ThePhaseless/Byparr) rather
than a fixed click-count loop.

**Mouse movement beyond the click itself buys nothing — superseded finding.**
There used to be a `wanderFor()` keeping the cursor moving at 100ms cadence
for the whole solve, plus a ~30-move warm-up before the first widget check,
justified by an 18-run A/B that showed the warm-up inverting the click count
(7 of 9 one-click solves with it, 2 of 9 without). **That measurement is no
longer valid**: it was taken while the solver was resetting the challenge
under itself on every poll (requirement 1), so both arms were really
measuring how long a doomed challenge took to give up. Movement helped
because it *slowed the poll loop down*.

With the reset fixed, a plain `mousemove x y` + `click 1` — no warm-up, no
wander, no easing, no jitter, no press-hold — solves in 6-12s with 2-3
clicks. Re-adding an interpolated approach and inter-attempt wander made it
*slower* (~18s) with no better success rate. All of that machinery is gone.

If this section ever tempts you to re-add "humanized" movement, re-measure
first, and check requirement 1 is still holding.

This replaced an earlier design with three separate nested timing loops (a
fixed warm-up, then a bounded widget-search retry, then a fixed
`MAX_CLICKS`/`CLICK_INTERVAL_MS` click loop) - collapsing them into one poll
loop fixed a real bug: the old design did its widget lookup exactly once,
right after the warm-up, and returned failure immediately if the challenge
happened to clear *passively* during that window (no widget to click,
because there was no longer a challenge) - live-observed on EZTV, twice.
Checking "is the challenge gone" first, every iteration, instead of only
inferring it from a successful click, fixes that: a passive clear during the
warm-up now resolves instantly rather than reporting a false failure.

### Knowing when the challenge is actually done

Use Cloudflare's own protocol-level signals. **Two, and both are required:**

1. A main-frame **navigation response without `cf-mitigated: challenge`** -
   Cloudflare saying it let that navigation through. Status is deliberately
   ignored: EZTV clears via a **302**, not a 200, and lands on a *different*
   URL than the one requested (`/search/?q1=the` → `/search/the`).
2. The current URL carries **no `__cf_chl` token**.

Cloudflare uses two different tokens, and confusing them is a trap:

| Token | When | Meaning |
|---|---|---|
| `__cf_chl_rt_tk` | ~100ms in, immediately | nothing - fires before anything is solved |
| `__cf_chl_tk` | at the end | the hop that actually completes the challenge |

Measured live, all three providers, each showing why one signal alone fails:

| | `__cf_chl_rt_tk` hop | URL clean again | genuinely cleared |
|---|---|---|---|
| ext.to | +378ms | **+455ms** | +12653ms |
| 1337x | +867ms | **+962ms** | +7553ms |
| EZTV | +307ms | **+368ms** | +8078ms |

So "URL had a token, now it doesn't" reports success in under half a second.
And the clearing *response* arrives while the page is still sitting on the
`__cf_chl_tk` URL, about to navigate once more - so trusting the header alone
hands the caller a page that navigates out from under its next fetch. Require
both and the verdict lands exactly right: **1337x 7.4s, EZTV 6.3s, ext.to 8.0s**,
each confirmed by checking the interstitial markup was really gone.

`page.on('response')` and `page.url()` are not page scripts, so this is safe
under requirement 1.

**This replaced DOM-selector detection, which was silently broken.** The old
exit check was `input[name="cf-turnstile-response"], .cf-turnstile,
#challenge-form, #challenge-running` - all Turnstile-specific. But **the
Turnstile markup is injected ~2s after the interstitial paints** (measured:
1337x +2.3s, EZTV +2.5s, ext.to +4.5s), so for the first couple of seconds
every selector returned 0 and the solver declared victory on a challenge that
had barely started. Entry used text (`isChallenge()`: `'cf-turnstile'` or
`'Just a moment'`) and matched fine, so the two checks disagreed. Live
signature: `challenge cleared after 299-342ms` followed by `fetch failed even
after session recovery`, repeated for 7 hours across every 1337x keep-alive.

It also removed the old fixed-floor-plus-quiescence wait (`CLEAR_SETTLE_MS`,
`NAV_QUIET_MS`). Those existed to guess when the redirect chain had settled;
signal 2 answers that exactly, so the guess is gone. All that remains after
clearing is `waitForLoadState('load')`.

### "No solvable challenge" is usually a race, not a failure

`solveChallenge()` must **not** treat "the page shows no challenge" as an
error. Concurrent `cfFetch()` calls for one host share a single persistent
page, and `serializeSolve` lets only one solve at a time - so the second
caller reaches the mutex *after* the first already cleared the page, reads
real content, and used to throw `no solvable challenge`.

Live-caught on multi-category browse (`fetchMergedBrowse` fires one fetch per
category): `htmlLen=622095` - a full 622 KB ext.to listing - reported as if it
were a hard block. Every blank-query browse failed this way after a restart.

The entry check now distinguishes three cases:

| Page content | Action |
|---|---|
| `isBlocked()` | throw - a ban page has no widget, clicking cannot help |
| real content, no challenge markers | **return the clearance** - someone else already solved it |
| empty (`page.content()` threw) | fall through to the poll loop - "unknown", not "clear" |

The empty case matters: the loop keys off the `cf-mitigated` header and the
URL token, neither of which needs a readable document, so an unreadable page
is still solvable. Returning success there would be a lie; throwing would
give up on a solvable challenge.

Returning optimistically is safe because `cfFetch()` always re-validates with
its own `tryFetch()` immediately afterwards and raises `fetch failed even
after session recovery` if the session really is bad.

### 1337x and EZTV clear passively - don't assume a checkbox

Both currently self-clear with **zero clicks** (1337x ~7.4s, EZTV ~6.3s). A
Turnstile input does get injected, but is never interacted with and the
challenge completes anyway. A screenshot at 0.6s shows "Performing security
verification" with a spinner and no checkbox. The interstitial's `<title>` is
still `Just a moment...`, which is why `isChallenge()` matches it.

**ext.to genuinely needs the click** - live-confirmed it does not clear on its
own within 40s, and clears ~8s after clicking. So the click loop stays.

Consequence worth knowing: `createPointer()` returning null (no
`DISPLAY`/xdotool, e.g. macOS local dev) makes `solveChallenge()` throw
immediately - even for a challenge that would have cleared on its own had it
waited. Not a problem in Docker, where DISPLAY always exists.

### After the solve: don't navigate, just wait

Clearing the challenge only means the interstitial is gone. Cloudflare
*separately* client-side redirects the current page to the URL originally
asked for - a real, in-flight navigation that already exists.

An earlier version tried to speed this up by discarding that and issuing its
own `page.goto(url)` reload immediately after a successful solve, on the
reasoning that `cf_clearance` is already set by the time the solve completes
(confirmed true via a live cookie check) so a fresh request should be safe.
**This was wrong in practice**: that `goto()` can race Cloudflare's own
already-in-flight redirect and hang for the full 60s `page.goto` timeout -
the same class of bug documented below for concurrent navigations generally,
just self-inflicted this time. Live-observed repeatedly on ext.to and 1337x
as `TimeoutError` right after a successful-looking solve.

The fix is to not navigate at all: the poll loop above just keeps checking
for the challenge markers (with a `POLL_INTERVAL_MS`-apart double-check,
since a page caught mid-redirect can transiently read as cleared), then
returns without touching navigation. Whatever page Cloudflare's own redirect
lands on, `cfFetch`'s own `tryFetch()` picks it up from there - the same
fetch that already runs after every fast-path failure regardless.

**But it must wait for that redirect to finish before returning** - the chain
can have several hops, and handing back a mid-chain page kills the caller's
next fetch ("fetch failed even after session recovery").

This used to be a fixed 1.5s floor plus a navigation-quiescence window, both
required because each was insufficient alone. **Both are gone**, replaced by
the `__cf_chl` URL check in "Knowing when the challenge is actually done"
above, which answers the same question exactly rather than by timing. Kept
here only because the reasoning explains why a naive `waitForLoadState('load')`
on its own is not enough: a hop can complete before the next begins.

### Concurrent navigations hang - `page.goto` needs serializing too

Multi-category requests (`fetchMergedBrowse`, 1337x's no-cat 4-category
snapshot - see section 11) fire several `cfFetch()` calls at
once via `Promise.all`. Live-tested against 1337x through the proxy: a
single concurrent navigation works fine, 2+ concurrent navigations to the
same Cloudflare-protected host reliably hang until the 60 s `page.goto`
timeout - reproduced deterministically. Two separate causes, both in
`lib/browser.ts`:

1. Only the xdotool **solve** step was serialized (the pre-existing
   `serializeSolve()` promise-chain mutex). `page.goto()` itself was not -
   concurrent navigations to the same host raced each other and Cloudflare
   appears to treat simultaneous connections from one client as suspicious
   and gets stuck rather than erroring cleanly.
2. `getPersistentContext()` was a lazy singleton with no guard against
   concurrent first calls - each could see the cache as still empty and
   launch its own Camoufox browser instance simultaneously (confirmed via
   logs: multiple `[cf] launching browser` lines for one request), starving
   the shared Xvfb display and causing `NS_ERROR_NET_TIMEOUT`.

Fix: `serializeNav()` - a second promise-chain mutex, mirroring
`serializeSolve`'s existing pattern. Now that the solve path no longer
navigates at all (see above), `serializeNav` wraps the one navigation that's
left - the cheap `about:blank` origin-establishing pre-nav in
`cfFetch` - while `serializeSolve` wraps the whole
`solveChallenge()` poll loop (XTEST input is global to the X display, so two
solves running at once still fight over the same virtual mouse). Plus:
`getPersistentContext()` now caches the **in-flight launch promise**, not
just the resolved context, so concurrent callers await the same launch
instead of racing (cache is cleared on launch failure so a later call can
retry). One browser now handles both direct and proxied traffic (routing is
per-request via a PAC script - see section 4), so there's a single nav
chain, not one per egress path as there briefly was.

Live-verified after the fix: a 4-fetch concurrent snapshot produces exactly
one `[cf] launching browser` line, one solve, and sequential navigations -
completes in ~24 s instead of hanging. Tradeoff accepted: multi-category
blank browsing is now ~N × single-fetch time instead of running in
parallel.

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

**Every request is logged** (`server.ts`, a global `app.use()` middleware
before the routes): `[req] <client ip> "<User-Agent>" <method> <url>`,
apikey redacted from the URL. Useful for confirming who's actually hitting
the server (Prowlarr/Sonarr/Radarr all send an identifiable UA) and with
what params, without needing to reproduce a request by hand.

**Remove old test containers before drawing any conclusion.** The same
resource-contention trap as below, one level up: several `trackarr` containers
left running each hold their own Camoufox (~400-800 MB), and Colima's VM
defaults to under 2 GB. Three at once was enough to OOM-kill the one under
test. Symptoms look exactly like a code or reputation problem:

- `docker inspect -f '{{.State.OOMKilled}}'` reports `true`
- `t=caps`, which touches no browser at all, takes **seconds** instead of ~0.1s
- `page.goto` times out at 15s against a host `curl` fetches in 0.5s
- solves burn their full budget and report `no widget ever rendered`

Worse if a stale container has `KEEPALIVE_INTERVAL_MS` set low - one was found
hammering all three trackers every 60s for two hours, wrecking both the local
VM and the IP's bot score. Check `docker ps` first: `docker stats --no-stream`
and the `oom` flag distinguish this from a real bug in seconds.

**Never `docker exec node -e "..."` a debug script against the live server
container.** It's a brand new Node process - it imports `lib/browser.js`
fresh and launches its *own* Camoufox browser, completely separate from the
running server's. Two browsers fighting for CPU/Xvfb/disk on the same
container causes exactly the kind of hang/timeout/false "still challenged"
symptoms that look like a real bug (confirmed - wasted real debugging time
on this twice). Use the real HTTP API (`curl` against the running
container) to investigate a live server instead; use the "Fast iteration"
long-lived debug container below only when you need a scratch script.

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
    const { cfFetch, closeBrowser } = await import('/app/lib/browser.js');
    try { const html = await cfFetch('https://ext.to/browse/?q=yify');
          console.log('CLEARED', html.length); }
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
no `testQuery` substitution any more (see section 11) - a blank `q` is
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

It **checks rather than solves**: calls the same `cfFetch()`
a real listing-page fetch would (see section 10 for the full design) -
solving only happens when actually challenged, so a visit with a valid
cookie/session is cheap. This doubles as warming the provider's persistent
page for real traffic, not just a throwaway check. Measured on a fresh
volume with a 1 min interval:

| Tick | ext.to | 1337x | Solve? |
|---|---|---|---|
| boot warm-up | 19.3 s | 17.3 s | yes, one each |
| later ticks | 1.7 s / 2.3 s | 0.75 s / 0.87 s | no |

Searches afterwards ran in **1.9 s / 2.4 s with zero solves** on the request
path, versus ~19 s cold.

`KEEPALIVE_INTERVAL_MS` (default 15 min, `0` disables) with ±20% jitter so
we're not hitting trackers on an exact schedule. Providers opt in by
exporting `keepAlive: { url }`.

**The interval is a guess.** The real clearance lifetime was never measured —
only estimated at roughly 15–30 min. If challenges start appearing on the
request path, lower it.

---

## 10. Caching: `cfFetch()` instead of a top-level result cache

`server.ts` used to cache whole `SearchResult`s, keyed on
`provider:q:sortedCat:offset:limit`. That's gone. Pagination made it a bad
fit: every distinct `offset`/`limit` was its own cache entry with zero
sharing between adjacent pages of the *same* query - a client walking
several offset pages within the TTL window (exactly the scenario that
originally motivated depth-capping in section 11) re-fetched/re-scraped the
same underlying site pages repeatedly instead of reusing them. Worst case
was ext.to/1337x's real-search-with-`cat` filtering (`fetchFilteredWindow`
in `lib/paging.ts`), which always restarts scanning from site page 1 on
every call regardless of `offset` - and EZTV's real keyword search, which
re-scraped the *entire* site on every single offset call, no reuse at all.

### The fix: cache each fetch itself, not the assembled result, via one general function

`gotoCleared()` is **gone entirely** - `lib/browser.ts` now exports a
single function, `cfFetch(url, opts?)`, that every provider
uses for everything: listing/search pages, magnet resolution, even POST
endpoints (ext.to's HMAC magnet lookup, EZTV's wlinks-reveal). `opts`
extends the standard `RequestInit` (`method`/`headers`/`body`, same shape
as the global `fetch()`) - it's a
drop-in-ish replacement for `fetch()` that resolves the body text directly
(never a live `Response`/`Page` - nothing needs one any more, confirmed by
grepping for `page.evaluate`/`gotoCleared` across every provider: zero
hits).

No `providerId` parameter either - the persistent page (below) is keyed by
`new URL(url).hostname`, derived automatically rather than passed in and
kept in sync by every caller. Every current provider only ever talks to
one hostname, so this partitions identically to the old id-keying while
removing a redundant parameter.

Results are cached (`TTLCache<string>`, same `CACHE_TTL_MS` env
var/default as the old result cache, 5 min), keyed by a **hash of
method+url+body**, not just the URL - a GET is idempotent so the URL alone
would be a fine key, but a POST's response depends on its body too (ext.to's
magnet POST carries a different torrent id and a fresh per-call HMAC on
every request to the *same* endpoint URL - caching by URL alone would serve
one torrent's magnet response for a completely different torrent). In
practice this makes the magnet-POST cache a permanent no-op (the body's
never identical twice) - accepted, since correctness is what the cache key
guards here, not a hit rate. A coarser "release -> magnet" cache is a
plausible future addition; `server.ts`'s separate `magnetCache` (id-keyed,
1 h TTL) already covers the common case of *re-requesting the same grab*.

**One persistent, already-cleared page per hostname** (not a fresh
`context.newPage()` per call), reused across many requests:

1. **Fast path**: try `page.evaluate(() => fetch(url, init))` through that
   persistent page's own live session - same-origin `fetch()` carries its
   cookies and runs through the real browser's network stack (same TLS
   fingerprint), which is exactly why this is safe against Cloudflare.
   Skips the full navigation/render cost of `page.goto()` entirely when
   the session's still good.
2. **Slow path** (fetch failed outright, or the response looks like a
   challenge/block page): navigate to re-establish the session, via
   `navigateAndClear()` (the shared challenge-detect/XTEST-auto-solve
   logic, still behind the existing `serializeSolve`/`serializeNav`
   mutexes so two requests hitting a stale session at once don't both try
   to solve it) - **then always do a fresh `fetch()` for the actual
   target afterward**. The recovery navigation's own returned HTML is
   *never* trusted directly, for GET or otherwise - a page fresh off a
   solved challenge can still be mid-redirect/mid-render in ways the
   `networkidle` wait inside `navigateAndClear` doesn't always fully close
   out (this used to be trusted for the GET case specifically; changed
   after reasoning through the risk generally, not from a caught live
   bug). What to navigate *to* differs by method:
   - **GET**: the target `url` itself - also gives the page real same-path
     context some endpoints require (see EZTV below), not just cookies.
   - **Anything else**: `url` may be a POST-only AJAX endpoint that isn't
     navigable at all, so reload wherever the page's already sitting
     instead - falling back to the request's own origin root if it has no
     real history yet (`about:blank`, a brand-new persistent page whose
     very first call happens to be non-GET).

Recovery is **per-request, not tied to the keep-alive schedule** - if a
session goes stale between keep-alive ticks, the very next real request
self-heals inline via the slow path instead of waiting for the next
scheduled check. Keep-alive (section 9) is just this same function called
proactively on a timer, warming the same persistent page real traffic uses.

### EZTV's reveal-POST needs a real prior GET to the same page - live-caught bug

`searchByKeyword()`'s reveal POST (`layout=def_wlinks` back to
`/search/?q1=...`) does return the full page with magnet links unlocked in
one shot when the session already has real context from having visited
`/search/` itself - confirmed live. But dropping the priming GET entirely
(relying on the POST's own fast/slow path to self-heal) broke on a live
cold-session test: the fast path failed, the generic recovery reloaded
wherever the page was *currently* sitting (the homepage, from keep-alive's
last visit - not `/search/`), and the retried POST still failed even after
that reload. Unlike ext.to's magnet endpoint (any same-origin page's
cookies are enough), EZTV's reveal POST apparently needs the page to have
actually navigated to `/search/` itself first - a referer/session-context
check, not just a cookie check.

Fixed by restoring an explicit `await cfFetch(searchUrl)` (a
plain GET, result discarded - only its side effect of putting the page on
the right path matters) immediately before the reveal POST. This also
means the POST's own recovery path (if it ever fires) reloads `searchUrl`
too, since that's now genuinely where the page was left.

`browseLatest()` still doesn't go through `cfFetch()` at all -
EZTV's JSON API isn't Cloudflare-protected to begin with, so a plain
server-side `fetch()` is fine and cheaper. Both `searchByKeyword()` and
`browseLatest()` keep their own small local caches on top
(`keywordSearchCache`, keyed by `q`, caching the whole parsed result list -
this is what actually fixes EZTV's worst-case "re-scrape everything per
offset page" problem; `apiCache`, keyed by the exact `/api/get-torrents`
URL) since neither fits being cached at the single-fetch level the way a
plain listing GET does.

### Known tradeoff: the status page's "cached" stat

`server.ts` can no longer tell whether a request was served from a lower-
level cache - that visibility only existed because caching used to happen
at the top level. The status page's "X% cached" stat (`lib/status.ts`'s
`ProviderStatusTracker`) is therefore now always 0% for **search**
requests, even when the underlying fetch was a cache hit. **Downloads are
unaffected** - `server.ts`'s separate `magnetCache` (1 h TTL, unrelated to
any of the above) still works exactly as before, and still reports real
cache-hit stats.

### Verify concurrency live before trusting it

Multiple concurrent fast-path `page.evaluate(fetch(...))` calls against the
*same* persistent page (e.g. `fetchMergedBrowse`'s parallel category
fetches) are same-origin AJAX, not navigation - a fundamentally different
thing from the concurrent-navigation hang fixed earlier (section 6's
`serializeNav`). Expected to be safe by the same reasoning that already
justified the magnet-POST/wlinks-POST pattern, but that reasoning alone did
NOT catch the navigation-concurrency bug either, nor the EZTV reveal-POST
bug above - only live Docker testing caught both. Don't trust any change
here is safe against the real sites without the same live verification.

---

## 11. Pagination, blank-query browsing, and per-provider categories

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
`fetch()` (not the browser path - accepted risk if Cloudflare ever
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
rendered for spec-compliance only (see section 12); the real fix for runaway
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

## 12. Torznab spec compliance

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

## 13. Testing

`npm test` (builds first, then runs `node --experimental-test-module-mocks
--test "test/**/*.test.ts"`). `npm run typecheck` type-checks source +
tests without emitting (`tsconfig.test.json`). CI (`.github/workflows/ci.yml`)
runs both on every push/PR; `docker-publish.yml` also gates the release build
on the same `test` job (`needs: test`), so a broken suite can't ship.

**No browser, no Docker, no network needed to run the suite at all** -
verified decisively by running `CAMOUFOX_INSTALL_DIR=/tmp/nonexistent npm
test` and getting all tests passing anyway. The mock boundary is
`lib/browser.ts`'s `cfFetch()` - provider tests never import
camoufox-js for real.

### Mock boundary

- **Providers**: mock `cfFetch` (via `node:test`'s
  `mock.module()`), assert against hand-built fixtures in `test/fixtures/`.
- **`lib/challenge.ts`**: no mocking needed at all - it imports only
  `child_process` and a playwright-core *type*, so `challenge.test.ts`
  loads it standalone and covers the marker functions plus the
  `solveChallenge()` paths that bail before touching a page (nothing to
  solve, unreadable page, no `DISPLAY`). The click loop itself still needs
  a real X display and is only exercised live.
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
2. Mock `cfFetch` once at the top of
   `test/providers/<id>.test.ts` (copy the pattern from `1337x.test.ts` or
   `ext-to.test.ts`).
3. Cover at minimum: a successful `search()` parse (title/size/category/etc),
   a malformed-row edge case, `resolveMagnet()` success, and its failure
   modes (missing id/url, no magnet found on the page).
4. This does **not** replace the blank-query-browse-against-the-real-site
   check in section 8 - fixtures catch parsing regressions, not "the live
   site changed its markup" or "this category returns zero results on this
   tracker".

---

## 14. Open issues

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
`cfFetch()`. If that endpoint ever gets put behind Cloudflare,
browsing breaks (keyword search via the scrape flow would be unaffected).

**`xdo()` swallows errors.** Not currently causing problems, but if the
warm-up movement ever silently no-ops, the widget stays on "Verifying..." and
the click lands on nothing. Verify the mouse actually moves:

```js
execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: ':99' } })
```

---

## 15. The wedged page: a browser tab can die without closing

**Symptom.** 1337x failed **55 consecutive keep-alives over 14 hours**, from
2026-08-22T17:01 onwards, with zero successes. ext.to and EZTV kept working
the entire time. Two failure modes, arriving in runs of 4-7 rather than
randomly:

- 34x `page.goto: Timeout 15000ms exceeded` — `waiting until "commit"`
- 20x `Cloudflare challenge did not clear after 45000ms`, mostly
  `no widget ever rendered`
- 1x `page.goto: NS_BINDING_ABORTED`

`isBlocked()` never fired, and not one `cf_clearance obtained` appeared in
the whole log.

### Theories that were wrong

**"The IPv6 proxy path broke."** The obvious read, given section 4, and
false. A `curl` through the *same* tinyproxy container, from a throwaway
container on the same Docker network, reached 1337x in **47ms**:

```bash
NET=$(docker inspect trackarr -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | grep trackarr-net)
docker run --rm --network "$NET" curlimages/curl:latest \
  -s -m 25 -x http://tinyproxy:8888 -D - -o /dev/null \
  -w 'CODE=%{http_code} TIME=%{time_total}\n' https://1337x.to/
# HTTP/2 403 / cf-mitigated: challenge / CODE=403 TIME=0.047
```

A `403` with `cf-mitigated: challenge` is the *good* outcome — a solvable
challenge, not a ban. Egress was a global IPv6 in the expected prefix, so
`FORCE_IPV6` was working too.

**"Cloudflare withdrew the interactive widget."** Suggested by
`no widget ever rendered` dominating the later failures. Also false — see
below, the widget rendered fine on a fresh browser.

**"The launch race is back"** (the one section browser.ts:27-33 documents).
Ruled out by process inspection: exactly one `camoufox-bin`, not several
fighting over one Xvfb display.

```bash
docker exec trackarr sh -c 'ps -eo pid,etime,rss,comm | grep -iE "firefox|camoufox"'
# 27  18:22:51  889660  camoufox-bin
```

Note the elapsed time: **18h22m**, matching container uptime exactly, with
`restarts=0`. The browser launched at boot and was never replaced.

### What it actually was

`docker restart trackarr` fixed it instantly:

```
[cf] challenge cleared after 6643ms (2 clicks).
[cf] cf_clearance obtained (4mqznmM1...).
[keepalive] 1337x ok (14226ms)
```

Same proxy, same Cloudflare, same click coordinate. The only variable was
browser age. A tab had stopped navigating **without ever closing**, and
`getOrCreatePersistentPage()` only recycles on `isClosed()` — so the dead
tab was handed back to every subsequent caller, forever. Nothing in the
process could recover it.

`no widget ever rendered` was a *symptom*, not a second cause: a page that
cannot navigate also cannot load Cloudflare's challenge assets. One root
cause explained both failure modes.

### The fix

`recyclePage()` in `lib/browser.ts`: any throw out of `cfFetch()` drops the
page from `persistentPages` and closes it, so the next call builds a clean
one. Two details are load-bearing:

- **Delete from the map before closing.** `close()` on a wedged page can
  hang too. Recovery must not wait on it — a leaked tab on an
  already-failing path is the cheaper trade.
- **Find the entry by page identity, not by hostname.** By the time a slow
  failure (a 15s `page.goto` timeout) reaches `recyclePage()`, a sibling
  call may already have recycled that page and a third call replaced it.
  Deleting by hostname would evict the healthy replacement and leak it —
  the same class of tab leak commit 9b3aefe fixed one level up.

No counter and no threshold, deliberately: `cf_clearance` lives on the
`BrowserContext`, not the page, so a replacement page normally costs one
navigation and no solve. Recycling on every failure is cheap enough that
tuning a threshold would be more code than it saves.

### If this recurs

Recycling the page fixes a dead *tab*. It will **not** fix a poisoned
connection pool, because Firefox pools connections per profile, not per
tab — a new tab reuses the same sockets. If the logs ever show
`[cf] recycling page for ...` repeatedly with no recovery, that is the
signal to escalate to a full browser relaunch. Two things need fixing
first:

- `closeBrowser()` nulls `sharedBrowser` and `sharedContext` but **not**
  `persistentContextPromise`, so `getPersistentContext()` would hand out a
  resolved promise pointing at a dead context. Harmless today (it only runs
  at shutdown), fatal for a relaunch path.
- `cachedOffset` in `lib/challenge.ts` survives a relaunch and would be
  measured against the old window geometry. `WINDOW_SIZE` is pinned, so in
  practice it would be identical — but it is not guaranteed.

### Diagnostic lesson

"Provider down for hours" looked like a tracker-side or network-side
problem and was neither. The question that cut through it fastest was
**"can something *other than the browser* reach the site right now?"** —
one `curl` through the same proxy, which took 47ms and eliminated half the
hypothesis space. Ask it first.

---

## 16. EZTV

Unlike ext.to and 1337x, EZTV's search page hides download links behind a
site preference, and the response shape changes depending on it. This
section exists because it was undocumented until seeds were found to be
hardcoded to 0 with no rationale anywhere in this file or the commit
history that added it — the gap outlived the original author's context.

### Two response layouts

- **Links revealed** (magnet visible): 6 `<td>`s per row — show-info icon,
  title, magnet + mirror links, size, released, seeds.
- **Links hidden**: 5 `<td>`s — the magnet `<td>` is **omitted entirely**,
  not emptied. This shifts every later column's position by one, so a
  positional selector (`nth-child(n)`) reads the wrong cell depending on
  which layout rendered. Confirmed against two real captured rows of the
  same torrent, one in each layout.

| Field | Selector |
|---|---|
| title / detail URL | `a.epinfo` (`title` attr / `href`) |
| size | parsed from the trailing `" (412.60 MB)"` in `a.epinfo`'s `title` attr, not a `<td>` — layout-independent, unlike the size cell |
| magnet | `a.magnet[href^="magnet:"]` |
| seeds | `td.forum_thread_post_end` (**class, not position** — see above) |

**Leechers are not available.** There is no leechers column in either
layout. `leechers` is always `0`, so Torznab's `peers = seeds + leechers`
equals `seeds` for every EZTV result — a known imprecision, not a bug.

### Revealing links: a cookie, not a POST

Cardigann's own definition
(`definitions/v11/eztv.yml`) sends a single cookie on an ordinary GET:

```yaml
headers:
  cookie: ["sort_no=100; q_filter=all; q_filter_web=on; q_filter_reality=on; q_filter_x265=on; layout=def_wlinks"]
```

`providers/eztv.ts` matches this: `lib/browser.ts` exposes
`registerDomainCookies()`, applied via `context.addCookies()` inside
`launchSession()` — not once at boot, so a session discard/relaunch (see
section 15) doesn't silently drop the cookie. `providers/index.ts`
registers each provider's declared `cookies` at startup.

This replaced an older two-request flow: a priming GET to `/search/`
followed by a POST with `layout=def_wlinks` as the body, discarding the
priming response and relying only on its side effect. The cookie halves
Cloudflare round-trips per uncached search to one.

### Rows with no download link are skipped, not listed

Even with the cookie set, some EZTV torrents render with no magnet `<td>`
at all — Cardigann's own row selector filters these too
(`:has(a.magnet)`, commented *"some torrents don't have any download
links so skip them"*). `parseSearchRows()` does the same: a row without
`a.magnet[href^="magnet:"]` is dropped. Listing it would only produce a
grab that fails later — `resolveMagnet()`'s detail-page fallback finds
nothing there either, since the site itself has no link for that torrent.

**This makes the cookie load-bearing in a new way.** If it ever stops
applying, every row loses its magnet `<td>` and gets filtered, so a
working search silently returns zero items — indistinguishable from "no
matches" without the check below. `parseSearchRows()` guards against
this explicitly: if rows were present but all were skipped, it throws
instead of returning `[]`.

### Title cleanup

Aligned with Cardigann's `title` filters — `[eztv]` stripped, then the
trailing size parenthetical stripped, then trimmed. One deliberate
deviation: Cardigann's second filter is `re_replace: ["\(.*\)$", ""]`,
which is **greedy** and matches from the *first* `(` in the title to the
last `)`. On a title containing an earlier parenthetical (e.g. a year,
`Show (2019) S01E01 ... (1.2 GB)`), that destroys everything from the
first paren onward. `parseSearchRows()` uses an anchored,
non-capturing-group form instead — `/\s*\([^()]*\)\s*$/` — which only
strips the final parenthetical and produces identical output on
well-formed titles.

### Keyword-search vs. blank-query browse

Only `searchByKeyword()` (the HTML scrape path) is affected by any of the
above. Blank-query browsing (`browseLatest()`) calls `/api/get-torrents`
with a plain `fetch()` — a different endpoint, not behind Cloudflare,
already carrying real `seeds`/`peers` fields, and never touched by the
cookie jar. Cardigann's own definition routes blank-query search through
the HTML `home` page instead of an API, so `sort_no=100` (raising the
keywordless result count to 100) does something for Cardigann that it
cannot do here — worth knowing if EZTV's blank-query yield is ever
compared against another Torznab indexer.

---

## 17. Cardigann definitions (`lib/cardigann/`)

Lets a tracker be added by dropping a Prowlarr Cardigann v11 YAML definition
into `definitions/` (or the `DEFINITIONS_DIR` volume - see the loader) instead
of hand-writing a `providers/<id>.ts`. Phase 1 only: the loader and the two
validation gates. The execution engine (phase 2+) doesn't exist yet - nothing
in this section is wired into `server.ts` or `providers/index.ts`.

### Two gates, not one

Schema-valid does not mean runnable. `lib/cardigann/schema.json` is the
**vendored, pinned** Prowlarr v11 schema (`additionalProperties: false`,
draft/2019-09 - needs `ajv/dist/2019`, not Ajv's default draft-07 export).
It accepts private trackers, login flows, and filters this engine will never
implement. `lib/cardigann/capability.ts` is the second gate: it walks an
already-schema-valid definition and names every feature we can't execute.

```
npm run validate:definitions [dir]   # defaults to ./definitions
```

### YAML parser choice is load-bearing

`js-yaml`'s default schema resolves ISO-8601-looking scalars to JS `Date`
objects, which then fails the schema's `type: string` checks. The `yaml`
package's default (YAML 1.2 core) leaves them as strings - verified directly,
not assumed (`YAML.parse('a: 2016-07-15')` → `{ a: "2016-07-15" }`, not a
`Date`).

One real gap `yaml` does *not* paper over: an unquoted `true`/`false` inside
an `options:`/`case:` map parses as a JS boolean, but the schema requires
strings there (`options: { hd: true }` needs to mean the string `"true"`).
This is the same quirk Prowlarr's own Python validator documents and
auto-corrects (`CONTRIBUTING.md`). `load.ts`'s `normalizeBooleanMaps()`
mirrors it, scoped to `options`/`case` keys only so genuinely boolean-typed
schema fields elsewhere (`caps.allowrawsearch`) are left alone. Numeric/
boolean YAML *keys* (`options: { 1: "x" }`) are a non-issue in JS - unlike
Python dicts, `Object` keys are always coerced to strings, confirmed
directly rather than assumed.

`ajv-formats` is required alongside Ajv - without it, `format: "uri"` etc. on
`links`/`legacylinks` is silently skipped rather than enforced (Prowlarr's
own documented `ajv-cli` usage pairs the two for the same reason). Its CJS
export shape resolves to a non-callable type under `moduleResolution:
NodeNext` despite being callable at runtime (verified against the compiled
`dist/index.js`) - a known ajv-formats/NodeNext friction point, worked around
with a documented cast in `load.ts` rather than fighting the resolver.

### What the capability gate actually rejects, and why the list is short

Every rejection reason was checked against the real wiki docs
(wiki.servarr.com/prowlarr/cardigann-yml-definition) and real upstream
definitions before being added - guessing what a Cardigann feature does and
rejecting based on the guess is exactly the mistake the EZTV seeds bug (this
file, section 16) came from.

- **`type` must be `public`.** No `semi-private`/`private`.
- **No `login` block.** Five auth methods, session/cookie lifecycle,
  captchas - a real feature, deliberately out of scope for now.
- **`search.rows.dateheaders` and `search.rows.after` are unsupported.**
  Distinct parsing modes (previous-sibling date rows; N-following-rows
  merged into one before field extraction), not just filters. Rare in
  practice (3 and 14 hits respectively across the full corpus - see below).
- **Any filter name outside the 24 implemented ones.** The schema's
  `FilterBlock`/`RowFilterBlock` `name` enums are closed, finite lists (25
  field filters + 2 row filters), transcribed from the wiki with exact
  argument semantics for phase 2. Only `jsonjoinarray` is deliberately
  unsupported - it needs a JSONPath dependency for one rare use
  (`preprocessingfilters` on JSON APIs) and nothing in the addressable corpus
  needs it.
- **`settings[].type: multi-select`** - broken even in Prowlarr's own engine
  per the wiki ("Using this type will throw a runtime error").

**Deliberately *not* rejected, after checking real definitions instead of
assuming:**

- **`settings` in general.** First pass rejected any non-`info_*` setting,
  which blocked hundreds of definitions purely for having an optional
  `sort`/`type`-order dropdown with a documented `default` (e.g. `1337x.yml`'s
  `sort: { type: select, default: time, ... }`, referenced as
  `.Config.sort` in the search URL template). Second pass allowed settings
  with a `default`. Checking real usage (`1337x.yml`'s `uploader` filter:
  `{{ if .Config.uploader }}...{{ else }}{{ end }}`) showed the *standard*
  Cardigann idiom already guards optional settings this way - so once `type`
  is `public` and no `login` block exists (nothing else could ever treat a
  setting as a mandatory credential), settings are never a capability
  blocker. Unset `.Config.$name` will resolve to `""` in the phase 2 engine,
  which is exactly what an unguarded reference would evaluate to anyway.
- **`fields.infohash` / `download.infohash`.** Not a bencode/`.torrent`-file
  hash computation as first assumed - it's a magnet URI built from a
  `hash` selector + a `title` selector, explicitly documented as
  Public/Semi-Private-only (private trackers need a tracker-exclusive magnet
  with DHT off, which this can't produce). Simple, will be implemented.
- **`download.before`.** A documented, bounded multi-step fetch (either a
  templated `path`+`inputs` request, or a `pathselector` extracted from the
  current page) before resolving the actual download link - structurally the
  same shape as EZTV's old priming-GET (section 16), just declared instead of
  hand-written. Will be implemented.

### Coverage against the full upstream corpus (547 v11 definitions, one snapshot)

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/Prowlarr/Indexers.git <dir>
cd <dir> && git sparse-checkout set definitions/v11
node dist/lib/cardigann/cli.js <dir>/definitions/v11
```

| | Count |
|---|---|
| Schema-invalid | 0 |
| Schema-valid | 547 |
| Blocked by `type: private`/`semi-private` + `login` | 468 (excluded by design) |
| Blocked by `rows.after` / `rows.dateheaders` | 14 / 3 (deferred, rare) |
| **Runnable end to end** | **76** |

76 includes real, well-known public trackers: `1337x.yml` (Cardigann's own -
distinct from our hand-written `providers/1337x.ts`), `thepiratebay.yml`,
`yts.yml`, `nyaasi.yml`, `eztv.yml` (distinct from `providers/eztv.ts`),
`limetorrents.yml`, `rutor.yml`, `showrss.yml`, `internetarchive.yml`.

This number is upstream-dependent and will drift; re-run the two commands
above (with a fresh clone) to get a current figure, and re-check `VERSIONS`
(`MIN=MAX=CURRENT=11` at time of writing, `v12` in development) before
assuming the vendored `schema.json` is still current.
