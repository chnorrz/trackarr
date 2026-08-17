import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { ProviderStatusTracker, renderStatusPage } = await import(path.join(ROOT, 'dist', 'lib', 'status.js'));

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
  assert.equal(stats.cached, 1); // cached is a SUBSET of successful, not a separate bucket
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
  // last call was a failure, so current state reflects that even though
  // most historical requests succeeded - state is "right now", stats are
  // cumulative.
  assert.equal(tracker.get('p').state, 'error');
});

// The page's own <style> block defines ".badge-ok"/".badge-error"/
// ".badge-unknown" as CSS class selectors, so a loose substring match for
// any of those always "matches" regardless of what's actually rendered -
// assert against the full <span> element instead.
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
  tracker.recordCheck('one', true); // a check happened, but never a real request
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
  // 5 total, 4 successful (3 of which cached = 75%), 1 failed
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
  assert.match(html, /0 ok \u00b7/); // no "(X% cached)" appended when successful is 0
  assert.doesNotMatch(html, /cached\)/);
});
