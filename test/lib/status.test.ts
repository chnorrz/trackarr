import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { ProviderStatusTracker, renderStatusPage, buildStatusJson } = await import(path.join(ROOT, 'dist', 'lib', 'status.js'));

const NOT_RUNNING = { running: false, processCount: 0, totalRssBytes: 0, processes: [] };

function fakeProvider(id: string, name: string) {
  return { id, name, search: async () => [], resolveMagnet: async () => '' };
}

test('a provider with no recorded status is "unknown" with no timestamp, error, or requests', () => {
  const tracker = new ProviderStatusTracker();
  const status = tracker.get('never-checked');
  assert.equal(status.state, 'unknown');
  assert.equal(status.lastCheckedAt, null);
  assert.equal(status.lastError, null);
  assert.deepEqual(status.stats, { total: 0, successful: 0, cached: 0, failed: 0 });
});

test('recordCheck(true) sets state to ok, clears any previous error, stamps the time', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('p', false, 'boom');
  const before = Date.now();
  tracker.recordCheck('p', true);
  const status = tracker.get('p');
  assert.equal(status.state, 'ok');
  assert.equal(status.lastError, null);
  assert.ok(status.lastCheckedAt);
  assert.ok(status.lastCheckedAt!.getTime() >= before);
});

test('recordCheck(false, message) sets state to error and keeps the message', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('p', false, 'Cloudflare challenge did not clear');
  const status = tracker.get('p');
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'Cloudflare challenge did not clear');
  assert.ok(status.lastCheckedAt);
});

test('a later call overwrites an earlier one for the same provider', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('p', true);
  tracker.recordCheck('p', false, 'now broken');
  const status = tracker.get('p');
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'now broken');
});

test('providers are tracked independently', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('a', true);
  tracker.recordCheck('b', false, 'oops');
  assert.equal(tracker.get('a').state, 'ok');
  assert.equal(tracker.get('b').state, 'error');
});

test('recordCheck (background keep-alive) updates state but never touches request stats', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('p', true);
  tracker.recordCheck('p', true);
  tracker.recordCheck('p', false, 'blip');
  assert.deepEqual(tracker.get('p').stats, { total: 0, successful: 0, cached: 0, failed: 0 });
});

test('recordRequest(true) increments total and successful, not cached or failed', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('p', true);
  assert.deepEqual(tracker.get('p').stats, { total: 1, successful: 1, cached: 0, failed: 0 });
});

test('recordRequest(true, {cached: true}) counts as both successful and cached', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('p', true, { cached: true });
  const stats = tracker.get('p').stats;
  assert.equal(stats.total, 1);
  assert.equal(stats.successful, 1);
  assert.equal(stats.cached, 1);
  assert.equal(stats.failed, 0);
});

test('recordRequest(false, {error}) increments total and failed, sets state/lastError', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('p', false, { error: 'boom' });
  const status = tracker.get('p');
  assert.deepEqual(status.stats, { total: 1, successful: 0, cached: 0, failed: 1 });
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'boom');
});

test('recordRequest accumulates across many calls, mixing outcomes', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('p', true);
  tracker.recordRequest('p', true, { cached: true });
  tracker.recordRequest('p', true, { cached: true });
  tracker.recordRequest('p', false, { error: 'x' });
  const stats = tracker.get('p').stats;
  assert.deepEqual(stats, { total: 4, successful: 3, cached: 2, failed: 1 });
  assert.equal(tracker.get('p').state, 'error');
});

// The page's <style> block contains these class names, so a loose substring
// match always hits - assert against the rendered <span> instead.
const badgeUnknown = /<span class="badge badge-unknown">UNKNOWN<\/span>/;
const badgeOk = /<span class="badge badge-ok">OK<\/span>/;
const badgeError = /<span class="badge badge-error">ERROR<\/span>/;

test('renderStatusPage lists every provider by name with its current state', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('one', true);
  const providers = { one: fakeProvider('one', 'Provider One'), two: fakeProvider('two', 'Provider Two') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, /Provider One/);
  assert.match(html, badgeOk);
  assert.match(html, /Provider Two/);
  assert.match(html, badgeUnknown);
});

test('renderStatusPage shows the error message only for a failing provider', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('one', false, 'Blocked by Cloudflare');
  const providers = { one: fakeProvider('one', 'Provider One') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, badgeError);
  assert.match(html, /Blocked by Cloudflare/);
});

test('renderStatusPage escapes HTML in provider names and error messages', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('one', false, '<script>alert(1)</script>');
  const providers = { one: fakeProvider('one', '<b>Evil</b>') };
  const html = renderStatusPage(providers, tracker);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>Evil<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
});

test('renderStatusPage shows "no requests yet" when stats are all zero', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('one', true);
  const providers = { one: fakeProvider('one', 'Provider One') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, /no requests yet/);
});

test('renderStatusPage shows request counts and the cached percentage of successful requests', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('one', true);
  tracker.recordRequest('one', true, { cached: true });
  tracker.recordRequest('one', true, { cached: true });
  tracker.recordRequest('one', true, { cached: true });
  tracker.recordRequest('one', false, { error: 'boom' });
  const providers = { one: fakeProvider('one', 'Provider One') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, /5 served/);
  assert.match(html, /4 ok \(75% cached\)/);
  assert.match(html, /1 failed/);
});

test('renderStatusPage omits the cached percentage when nothing has succeeded yet', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordRequest('one', false, { error: 'boom' });
  const providers = { one: fakeProvider('one', 'Provider One') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, /1 served/);
  assert.match(html, /0 ok \u00b7/);
  // A loose /cached\)/ substring match would also hit the inline client-side
  // script's own "% cached)" format string - scope to the rendered pattern.
  assert.doesNotMatch(html, /\(\d+% cached\)/);
});

test('buildStatusJson includes every provider with its id, name, state and stats', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordCheck('one', true);
  tracker.recordRequest('two', false, { error: 'boom' });
  const providers = { one: fakeProvider('one', 'Provider One'), two: fakeProvider('two', 'Provider Two') };
  const json = buildStatusJson(providers, tracker, NOT_RUNNING);

  assert.ok(json.generatedAt);
  assert.equal(json.providers.length, 2);

  const one = json.providers.find((p: { id: string }) => p.id === 'one');
  assert.equal(one.name, 'Provider One');
  assert.equal(one.state, 'ok');
  assert.equal(typeof one.lastCheckedAt, 'string');
  assert.equal(one.lastError, null);

  const two = json.providers.find((p: { id: string }) => p.id === 'two');
  assert.equal(two.state, 'error');
  assert.equal(two.lastError, 'boom');
  assert.deepEqual(two.stats, { total: 1, successful: 0, cached: 0, failed: 1 });
});

test('buildStatusJson passes the camoufox snapshot through unchanged', () => {
  const tracker = new ProviderStatusTracker();
  const camoufox = { running: true, processCount: 3, totalRssBytes: 123456, processes: [{ pid: 1, rssBytes: 123456 }] };
  const json = buildStatusJson({}, tracker, camoufox);
  assert.deepEqual(json.camoufox, camoufox);
});

test('buildStatusJson reports a provider with no recorded status as unknown with null timestamp/error', () => {
  const tracker = new ProviderStatusTracker();
  const providers = { one: fakeProvider('one', 'Provider One') };
  const json = buildStatusJson(providers, tracker, NOT_RUNNING);
  assert.equal(json.providers[0].state, 'unknown');
  assert.equal(json.providers[0].lastCheckedAt, null);
  assert.equal(json.providers[0].lastError, null);
});
