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

test('a provider with no recorded status is "unknown" with no timestamp or error', () => {
  const tracker = new ProviderStatusTracker();
  const status = tracker.get('never-checked');
  assert.equal(status.state, 'unknown');
  assert.equal(status.lastCheckedAt, null);
  assert.equal(status.lastError, null);
});

test('recordSuccess sets state to ok, clears any previous error, stamps the time', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordFailure('p', 'boom');
  const before = Date.now();
  tracker.recordSuccess('p');
  const status = tracker.get('p');
  assert.equal(status.state, 'ok');
  assert.equal(status.lastError, null);
  assert.ok(status.lastCheckedAt);
  assert.ok(status.lastCheckedAt!.getTime() >= before);
});

test('recordFailure sets state to error and keeps the message', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordFailure('p', 'Cloudflare challenge did not clear');
  const status = tracker.get('p');
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'Cloudflare challenge did not clear');
  assert.ok(status.lastCheckedAt);
});

test('a later call overwrites an earlier one for the same provider', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordSuccess('p');
  tracker.recordFailure('p', 'now broken');
  const status = tracker.get('p');
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'now broken');
});

test('providers are tracked independently', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordSuccess('a');
  tracker.recordFailure('b', 'oops');
  assert.equal(tracker.get('a').state, 'ok');
  assert.equal(tracker.get('b').state, 'error');
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
  tracker.recordSuccess('one');
  const providers = { one: fakeProvider('one', 'Provider One'), two: fakeProvider('two', 'Provider Two') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, /Provider One/);
  assert.match(html, badgeOk);
  assert.match(html, /Provider Two/);
  assert.match(html, badgeUnknown);
});

test('renderStatusPage shows the error message only for a failing provider', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordFailure('one', 'Blocked by Cloudflare');
  const providers = { one: fakeProvider('one', 'Provider One') };
  const html = renderStatusPage(providers, tracker);
  assert.match(html, badgeError);
  assert.match(html, /Blocked by Cloudflare/);
});

test('renderStatusPage escapes HTML in provider names and error messages', () => {
  const tracker = new ProviderStatusTracker();
  tracker.recordFailure('one', '<script>alert(1)</script>');
  const providers = { one: fakeProvider('one', '<b>Evil</b>') };
  const html = renderStatusPage(providers, tracker);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>Evil<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
});
