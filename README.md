# trackarr

A small self-hosted server that exposes scraper-hostile torrent trackers to
**Prowlarr** as ordinary Torznab indexers.

Prowlarr ships definitions for hundreds of trackers, but some can't be
described by a Cardigann YAML definition at all - they sit behind Cloudflare
and sign their download links with JavaScript. This bridges that gap: it
drives a real browser, does the site-specific work, and hands Prowlarr a plain
Torznab feed.

Currently supported:

| Provider | Endpoint path | Notes |
|---|---|---|
| ext.to | `/ext-to/api` | General catalog; magnet via signed API |
| 1337x | `/1337x/api` | General catalog; magnet embedded in detail page |
| EZTV | `/eztv/api` | TV only; magnet embedded in search results |

---

## Why this exists

Two problems make these trackers unusable through Prowlarr's normal
definition format:

1. **Cloudflare.** Plain HTTP requests get a `403`. The search pages sit
   behind a Turnstile challenge that has to be cleared by something that
   looks and behaves like a real browser.
2. **Signed magnet links.** ext.to doesn't put magnets in the HTML. The page
   asks an internal API for them, signing each request with
   `sha256(torrentId|timestamp|pageToken)` where the token is a per-page-load
   nonce. A YAML definition cannot compute that.

FlareSolverr-style proxies only solve the first problem. This solves both, by
keeping the whole flow inside one browser session.

## How it works

```
Prowlarr  ──HTTP──>  trackarr  ──> headless Firefox (Camoufox)  ──> tracker
   Torznab XML        Express         clears Cloudflare, scrapes,
                                      calls the site's own magnet API
```

- **One persistent browser.** A single [Camoufox](https://github.com/daijro/camoufox)
  (a fingerprint-hardened Firefox) instance is reused across requests, so
  there's no per-request browser startup, and one Cloudflare clearance
  benefits every subsequent request.
- **Challenges are solved automatically.** When a Turnstile challenge appears,
  the server clicks the checkbox itself. This requires injecting input at the
  X server level rather than through the automation API - see `NOTES.md` if
  you need the details.
- **Everything runs inside the browser page.** Cloudflare's clearance cookie
  is tied to the browser's TLS fingerprint, so even the magnet API call is
  issued from inside the page rather than from Node.
- **Magnets are resolved lazily.** Search results link back to this server;
  the magnet is only fetched when Prowlarr actually grabs a release. Resolving
  50 results eagerly would mean 50 page loads per search.
- **Results are cached** (searches 5 min, magnets 1 h) to keep traffic to the
  trackers low.
- **Clearance is kept warm in the background.** Solving a challenge takes
  ~20 s, and paying that during a Prowlarr search can make the search time
  out. A periodic task visits each tracker to keep the cookie fresh, so
  searches stay in the low seconds.

`.cf-cookies.json` in the data volume holds the Cloudflare clearance, so
restarts don't trigger a fresh challenge.

---

## Quick start

Pull the published image:

```bash
docker volume create trackarr-data

docker run -d --name trackarr \
  -p 9117:9117 \
  -e API_KEY=pick-something-random \
  -v trackarr-data:/data \
  ghcr.io/chnorrz/trackarr:latest
```

Or build it yourself:

```bash
docker build -t trackarr .
docker run -d --name trackarr \
  -p 9117:9117 \
  -e API_KEY=pick-something-random \
  -v trackarr-data:/data \
  trackarr
```

Check it's alive - this needs no API key:

```bash
curl "http://localhost:9117/ext-to/api?t=caps"
```

Then a real search:

```bash
curl "http://localhost:9117/ext-to/api?t=search&q=ubuntu&apikey=pick-something-random"
```

The first search may take ~20 s while a Cloudflare challenge is solved.
Later ones are fast.

### Deploying alongside an existing Prowlarr stack

`docker-compose.yml` in this repo joins trackarr to an existing Compose
project's network (so Prowlarr can reach it by container name) and adds an
optional `tinyproxy` sidecar for providers that need the IPv6 workaround
described below (currently 1337x) - see the comments in the file for the one
line you need to edit (your Prowlarr network's name) before running
`docker compose up -d`.

It references prebuilt images (`ghcr.io/chnorrz/trackarr` and
`ghcr.io/chnorrz/trackarr-tinyproxy`) rather than building locally, so it
works with any deployment method, including pasting or uploading just the
compose file (e.g. Portainer stacks) where the rest of the repo isn't present
alongside it.

## Adding it to Prowlarr

Once per provider:

1. **Settings → Indexers → Add Indexer**
2. Search for `torznab` and pick the generic/custom Torznab entry (the exact
   label varies between Prowlarr versions)
3. Fill in:

   | Field | Value |
   |---|---|
   | Name | anything, e.g. `ext.to` |
   | URL | `http://<host>:9117/ext-to` |
   | API Path | `/api` |
   | API Key | whatever you set as `API_KEY` |
   | Categories | pick after hitting Test |

4. **Test**, then **Save**.

Repeat for the other providers: `http://<host>:9117/1337x` and
`http://<host>:9117/eztv`.

**If Prowlarr runs in Docker too**, `localhost` won't reach this container.
Use the host's LAN IP, or put both on the same Docker network and use the
container name.

Prowlarr then treats it like any other indexer - Sonarr/Radarr searches flow
through automatically.

### Categories

Results are mapped to standard Torznab categories: Movies (2000), TV (5000),
TV/Anime (5070), Audio (3000), PC (4000), XXX (6000), Books (7000), Other
(8000). The mapping is keyword-based and approximate.

---

## Configuration

All via environment variables.

| Var | Default | Meaning |
|---|---|---|
| `API_KEY` | `changeme` | Key Prowlarr must send. **Set this.** |
| `PORT` | `9117` | HTTP port |
| `DATA_DIR` | `/data` | Where the Cloudflare cookie is persisted |
| `SEARCH_CACHE_TTL_MS` | `300000` | Search cache lifetime (5 min) |
| `MAGNET_CACHE_TTL_MS` | `3600000` | Magnet cache lifetime (1 h) |
| `KEEPALIVE_INTERVAL_MS` | `900000` | Background Cloudflare warm-up (15 min). `0` disables |
| `PROXY_URL` | *(unset)* | Upstream proxy, see below. Unset = direct |
| `PROXY_PROVIDERS` | *(unset)* | Comma-separated provider ids allowed to use the proxy. **Unset or empty = none** - opt-in, not opt-out |

### Proxy (optional)

Only needed if a tracker has banned your IPv4 address while your IPv6 still
works. A container usually has no IPv6 of its own, so it needs to borrow the host's.

```bash
brew install tinyproxy    # or apt install tinyproxy
tinyproxy -d -c tools/tinyproxy.conf

docker run ... -e PROXY_URL=http://192.168.5.2:8888 -e PROXY_PROVIDERS=1337x ...
```

Both vars are required - `PROXY_URL` alone does nothing, since no provider is
proxied unless it's explicitly named in `PROXY_PROVIDERS` too. Remove
`PROXY_PROVIDERS` (or clear it) to disable the proxy for everything without
touching `PROXY_URL`. Full diagnosis steps and the reasoning are in
`NOTES.md` section 4.

**Don't proxy a provider that already works directly** - the Cloudflare
clearance cookie is bound to the egress IP.

---

## Adding a tracker

Create `providers/<id>.ts` exporting a default that satisfies the `Provider`
interface from `lib/types.ts`:

```ts
import type { Provider } from '../lib/types.js';

export default {
  id: 'mytracker',
  name: 'My Tracker',
  async search(q) {
    // -> [{ title, detailUrl, id, size, seeds, leechers, category, pubDate }]
  },
  async resolveMagnet({ id, url }) {
    // -> 'magnet:?xt=...'
  }
} satisfies Provider;
```

Register it in `providers/index.ts`. It gets `/<id>/api` and `/<id>/download`
automatically. Use `gotoCleared(url)` from `lib/browser.ts` to fetch pages -
it handles Cloudflare for you.

`providers/1337x.ts` is the simpler reference (magnets sit in the HTML);
`providers/ext-to.ts` shows the signed-API case.

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # builds, then runs the test suite
```

The test suite needs no browser, no Docker, and no network access - provider
tests run against hand-built fixtures in `test/fixtures/`, and the server is
tested via dependency injection rather than the real process. See NOTES.md
section 10 for how the mocking works and how to add tests for a new
provider.

---

## Limitations

- **Search returns the first page only.** No pagination.
- **Scrapers break.** These are unofficial integrations against markup and
  private APIs that can change without notice.
- **The Turnstile auto-solver is inherently fragile** - it depends on the
  widget's layout. If searches start failing after working fine, check the
  container logs first.
- **Concurrent challenge solves aren't serialised.** Fine for Prowlarr's
  normal polling, potentially flaky under heavy parallel load.
- **Linux/Docker is the supported target.** It runs on macOS for development,
  but the auto-solver needs the X server present in the container image.

## Troubleshooting

Container logs are the first stop - all Cloudflare activity is logged with a
`[cf]` prefix.

| Symptom | Likely cause |
|---|---|
| `Cloudflare challenge did not clear` | Auto-solve failed. Retry; if persistent, the widget layout may have changed. |
| `Blocked by Cloudflare (IP ban/rate limit)` | Hard block, not a challenge. See the proxy section. |
| Search returns 0 results, HTTP 200 | Markup changed, or the provider's selectors need updating. |
| `Invalid apikey` | `API_KEY` doesn't match what Prowlarr sends. |
| `docker pull`/`compose up` fails to fetch the image | GHCR packages default to **private** even on a public repo. Set `trackarr` and `trackarr-tinyproxy` to public in their package settings, or `docker login ghcr.io` with a PAT that has `read:packages`. |
| `compose build ... path ... not found` for `tinyproxy` | Stale config - `docker-compose.yml` now references the prebuilt `ghcr.io/chnorrz/trackarr-tinyproxy` image, not a local build. Re-pull the compose file. |

`NOTES.md` holds the deeper technical background: what Cloudflare does and
doesn't detect, how the auto-solver works, and a debugging playbook.

---

## Legal

For personal use with content you're entitled to access. You are responsible
for complying with local law and the terms of service of any site you point
this at.
