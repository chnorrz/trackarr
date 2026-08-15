import crypto from 'crypto';
import { gotoCleared } from './browser.js';

const BASE = 'https://ext.to';
const ENDPOINT = `${BASE}/ajax/getSearchMagnet.php`;

function computeHMAC(torrentId, timestamp, token) {
  return crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${token}`).digest('hex');
}

// Resolves a magnet URI for a given torrent id using the search-listing
// page's magnet flow (getSearchMagnet.php). No torrent detail page visit
// needed - any fresh /browse/ page load gives us a valid searchPageToken +
// csrf token, both of which are page-load nonces, not torrent-specific.
export async function resolveMagnetById(torrentId) {
  // Bare /browse/ (no query) doesn't render searchPageToken - needs an
  // actual results listing. A very short/single-char query seems to trip a
  // stricter WAF rule, so use a realistic-looking query string here.
  const page = await gotoCleared(`${BASE}/browse/?q=yify`);
  try {
    const html = await page.content();

    const pageTokenMatch = html.match(/searchPageToken\s*=\s*['"]([^'"]+)['"]/);
    if (!pageTokenMatch) throw new Error('Could not find window.searchPageToken on page.');
    const pageToken = pageTokenMatch[1];

    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch) throw new Error('Could not find csrf-token meta tag on page.');
    const sessid = csrfMatch[1];

    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = computeHMAC(torrentId, timestamp, pageToken);

    const result = await page.evaluate(
      async ({ endpoint, torrentId, timestamp, hmac, sessid }) => {
        const body = new URLSearchParams({
          torrent_id: String(torrentId),
          hash: '',
          name: '',
          timestamp: String(timestamp),
          hmac,
          sessid
        });
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body
        });
        const text = await res.text();
        return { status: res.status, text };
      },
      { endpoint: ENDPOINT, torrentId, timestamp, hmac, sessid }
    );

    let json;
    try {
      json = JSON.parse(result.text);
    } catch {
      throw new Error(`Non-JSON response (status ${result.status}): ${result.text.slice(0, 300)}`);
    }

    if (!json.success || !json.url || typeof json.url !== 'string' || !json.url.startsWith('magnet:')) {
      throw new Error(`No magnet in response: ${JSON.stringify(json)}`);
    }

    return json.url;
  } finally {
    await page.close();
  }
}
