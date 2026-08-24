import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { resolveCardigannDownload } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'download.js'));

function fakeFetch(responses: Record<string, string>) {
  const calls: { url: string; opts?: unknown }[] = [];
  const fn = async (url: string, opts?: unknown) => {
    calls.push({ url, opts });
    const body = responses[url];
    if (body === undefined) throw new Error(`fakeFetch: no canned response for ${url}`);
    return body;
  };
  return { fn, calls };
}

test('a downloadUri that is already a magnet: URI is returned without any fetch', async () => {
  const { fn, calls } = fakeFetch({});
  const result = await resolveCardigannDownload({
    definition: {},
    downloadUri: 'magnet:?xt=urn:btih:AAA&dn=Title',
    itemTitle: 'Title',
    fetch: fn
  });
  assert.equal(result, 'magnet:?xt=urn:btih:AAA&dn=Title');
  assert.equal(calls.length, 0);
});

test('no download block: falls back to a[href^="magnet:"] on the captured link, matching the hand-written providers', async () => {
  const { fn } = fakeFetch({
    'https://example.test/torrent/1': '<html><body><a href="magnet:?xt=urn:btih:BBB&dn=X">m</a></body></html>'
  });
  const result = await resolveCardigannDownload({
    definition: {},
    downloadUri: 'https://example.test/torrent/1',
    itemTitle: 'X',
    fetch: fn
  });
  assert.equal(result, 'magnet:?xt=urn:btih:BBB&dn=X');
});

test('no download block, no magnet on the page: throws a clear error', async () => {
  const { fn } = fakeFetch({ 'https://example.test/torrent/2': '<html><body>no links here</body></html>' });
  await assert.rejects(
    resolveCardigannDownload({ definition: {}, downloadUri: 'https://example.test/torrent/2', itemTitle: 'X', fetch: fn }),
    /no magnet link found/
  );
});

test('download.selectors[]: first matching selector wins, reading the default (non-before) page', async () => {
  const { fn, calls } = fakeFetch({
    'https://example.test/t/3': '<html><body><a href="magnet:?xt=urn:btih:CCC&dn=Y">dl</a></body></html>'
  });
  const definition = {
    download: {
      selectors: [
        { selector: 'a.nope' },
        { selector: 'a', attribute: 'href' }
      ]
    }
  };
  const result = await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/3', itemTitle: 'Y', fetch: fn });
  assert.equal(result, 'magnet:?xt=urn:btih:CCC&dn=Y');
  // Only one fetch of the default page, reused across both selector attempts.
  assert.equal(calls.length, 1);
});

test('download.headers is forwarded on the default-page fetch, multi-value entries joined per HTTP\'s combination rule', async () => {
  const { fn, calls } = fakeFetch({
    'https://example.test/t/3b': '<html><body><a href="magnet:?xt=urn:btih:CCC&dn=Y">dl</a></body></html>'
  });
  const definition = {
    download: {
      headers: { Cookie: ['a=1', 'b=2'], 'X-Requested-With': ['XMLHttpRequest'] },
      selectors: [{ selector: 'a', attribute: 'href' }]
    }
  };
  await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/3b', itemTitle: 'Y', fetch: fn });
  const call = calls[0] as { opts: { headers: Record<string, string> } };
  assert.equal(call.opts.headers.Cookie, 'a=1, b=2');
  assert.equal(call.opts.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('download.headers is forwarded on before/pathselector fetches too, merged (not replaced) with the POST Content-Type', async () => {
  const { fn, calls } = fakeFetch({
    'https://example.test/get_srv_details2.php': '<html><body><a class="real" href="magnet:?xt=urn:btih:FFF&dn=V">m</a></body></html>'
  });
  const definition = {
    download: {
      headers: { 'X-Api-Key': ['secret'] },
      before: { path: 'get_srv_details2.php', method: 'post', inputs: { action: 2 } },
      selectors: [{ selector: 'a.real', attribute: 'href', usebeforeresponse: true }]
    }
  };
  await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/torrents-details2.php', itemTitle: 'V', fetch: fn });
  const call = calls[0] as { opts: { headers: Record<string, string> } };
  assert.equal(call.opts.headers['X-Api-Key'], 'secret');
  assert.equal(call.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('download.selectors[] resolving to a non-magnet URL throws instead of silently returning it', async () => {
  const { fn } = fakeFetch({
    'https://example.test/t/4': '<html><body><a href="download.php?id=1" class="dl">dl</a></body></html>'
  });
  const definition = { download: { selectors: [{ selector: 'a.dl', attribute: 'href' }] } };
  await assert.rejects(
    resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/4', itemTitle: 'Y', fetch: fn }),
    /torrent file downloading is not supported/
  );
});

test('download.before with a fixed path, POST, inputs templated from .DownloadUri.Query - and selectors reading the before response', async () => {
  const { fn, calls } = fakeFetch({
    'https://example.test/get_srv_details.php': '<html><body><a class="real" href="magnet:?xt=urn:btih:DDD&dn=Z">m</a></body></html>'
  });
  const definition = {
    download: {
      before: {
        path: 'get_srv_details.php',
        method: 'post',
        inputs: { action: 2, id: '{{ .DownloadUri.Query.id }}' }
      },
      selectors: [{ selector: 'a.real', attribute: 'href', usebeforeresponse: true }]
    }
  };
  const result = await resolveCardigannDownload({
    definition,
    downloadUri: 'https://example.test/torrents-details.php?id=37346&hit=yes',
    itemTitle: 'Z',
    fetch: fn
  });
  assert.equal(result, 'magnet:?xt=urn:btih:DDD&dn=Z');
  assert.equal(calls.length, 1);
  const call = calls[0] as { url: string; opts: { method: string; body: string } };
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.body, 'action=2&id=37346');
});

test('download.before with a pathselector: resolved against a fetch of the captured download link first', async () => {
  const { fn, calls } = fakeFetch({
    'https://example.test/details/5': '<html><body><ul class="post-buttons"><li><a href="./viewtopic.php?thanks=65417">thanks</a></li></ul></body></html>',
    // "./viewtopic.php" resolves relative to the *directory* of downloadUri
    // (/details/), not example.test's root - real URL resolution semantics.
    'https://example.test/details/viewtopic.php?thanks=65417': '<html><body><a class="real" href="magnet:?xt=urn:btih:EEE&dn=W">m</a></body></html>'
  });
  const definition = {
    download: {
      before: { pathselector: { selector: 'ul.post-buttons li:last-child a', attribute: 'href' } },
      selectors: [{ selector: 'a.real', attribute: 'href', usebeforeresponse: true }]
    }
  };
  const result = await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/details/5', itemTitle: 'W', fetch: fn });
  assert.equal(result, 'magnet:?xt=urn:btih:EEE&dn=W');
  assert.equal(calls.length, 2, 'one fetch for the pathselector source page, one for the resolved before target');
});

test('download.selectors[]: a "$"-prefixed selector reads the response as JSON instead of HTML', async () => {
  const { fn } = fakeFetch({
    'https://example.test/t/json': JSON.stringify({ download: { url: 'magnet:?xt=urn:btih:GGG&dn=J' } })
  });
  const definition = { download: { selectors: [{ selector: '$.download.url' }] } };
  const result = await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/json', itemTitle: 'J', fetch: fn });
  assert.equal(result, 'magnet:?xt=urn:btih:GGG&dn=J');
});

test('download.infohash: builds a magnet from hash + title selectors, appending a fixed public tracker list', async () => {
  const { fn } = fakeFetch({
    'https://example.test/t/6': `<html><body>
      <a href="magnet:?xt=urn:btih:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" class="hash">m</a>
      <meta property="og:title" content="Real Title (2024)">
    </body></html>`
  });
  const definition = {
    download: {
      infohash: {
        hash: { selector: 'a.hash', attribute: 'href', filters: [{ name: 'regexp', args: '([A-F0-9]{40})' }] },
        title: { selector: 'meta[property="og:title"]', attribute: 'content' }
      }
    }
  };
  const result = await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/6', itemTitle: 'fallback', fetch: fn });
  assert.match(result, /^magnet:\?xt=urn:btih:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF&dn=Real%20Title/);
  assert.match(result, /&tr=/, 'a tracker list must be appended');
});

test('download.infohash falls back to the item\'s own title when the title selector does not match', async () => {
  const { fn } = fakeFetch({
    'https://example.test/t/7': '<html><body><a href="magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" class="hash">m</a></body></html>'
  });
  const definition = {
    download: {
      infohash: {
        hash: { selector: 'a.hash', attribute: 'href', filters: [{ name: 'regexp', args: '([A-F0-9]{40})' }] },
        title: { selector: 'meta[property="og:title"]', attribute: 'content' }
      }
    }
  };
  const result = await resolveCardigannDownload({ definition, downloadUri: 'https://example.test/t/7', itemTitle: 'Fallback Title', fetch: fn });
  assert.match(result, /dn=Fallback%20Title/);
});

test('a download block with neither selectors nor infohash throws instead of silently returning nothing', async () => {
  const { fn } = fakeFetch({ 'https://example.test/t/8': '<html><body>x</body></html>' });
  await assert.rejects(
    resolveCardigannDownload({ definition: { download: {} }, downloadUri: 'https://example.test/t/8', itemTitle: 'X', fetch: fn }),
    /exhausted with no magnet resolved/
  );
});
