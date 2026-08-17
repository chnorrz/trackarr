import type { Provider } from './types.js';

export type ProviderState = 'ok' | 'error' | 'unknown';

// Cumulative counters, never reset except by a process restart. `cached` is
// a subset of `successful` (a cache hit is still a successful request), not
// a separate outcome - so successful - cached is what actually hit the
// tracker. `total` is `successful + failed`, kept as its own field only for
// convenience when rendering.
export interface ProviderStats {
  total: number;
  successful: number;
  cached: number;
  failed: number;
}

export interface ProviderStatus {
  state: ProviderState;
  lastCheckedAt: Date | null;
  lastError: string | null;
  stats: ProviderStats;
}

const EMPTY_STATS: ProviderStats = { total: 0, successful: 0, cached: 0, failed: 0 };
const UNKNOWN: ProviderStatus = { state: 'unknown', lastCheckedAt: null, lastError: null, stats: EMPTY_STATS };

// Tracks each provider's health, updated from two places: the background
// keep-alive scheduler (server.ts's warmProvider) and real search/download
// requests (server.ts's createApp). "Last checked/used" is deliberately one
// merged timestamp rather than two - whichever happened more recently,
// background check or real Prowlarr request, is what's shown.
//
// Request *counts* only come from recordRequest, never recordCheck - a
// background keep-alive ping isn't a request Prowlarr made, and counting it
// as one would make the stats reflect KEEPALIVE_INTERVAL_MS as much as
// actual usage.
//
// Not persisted - a restart resets everyone to 'unknown' (and stats to
// zero) until the next check. That's fine for state (the keep-alive
// scheduler's boot-time warm-up fires within a few seconds), and stats
// resetting on restart is expected for a simple in-memory counter like
// this - it's meant for "is this provider healthy right now", not as a
// long-term metrics store.
export class ProviderStatusTracker {
  private readonly statuses = new Map<string, ProviderStatus>();

  private statsFor(providerId: string): ProviderStats {
    return this.statuses.get(providerId)?.stats ?? EMPTY_STATS;
  }

  // Background keep-alive check - updates state/last-checked only, doesn't
  // touch the request counters.
  recordCheck(providerId: string, ok: boolean, error?: string): void {
    this.statuses.set(providerId, {
      state: ok ? 'ok' : 'error',
      lastCheckedAt: new Date(),
      lastError: ok ? null : (error ?? null),
      stats: this.statsFor(providerId)
    });
  }

  // A real search or download request - updates state/last-checked AND
  // increments the request counters. `cached` only matters when ok is true.
  recordRequest(providerId: string, ok: boolean, opts: { cached?: boolean; error?: string } = {}): void {
    const prev = this.statsFor(providerId);
    const stats: ProviderStats = {
      total: prev.total + 1,
      successful: prev.successful + (ok ? 1 : 0),
      cached: prev.cached + (ok && opts.cached ? 1 : 0),
      failed: prev.failed + (ok ? 0 : 1)
    };
    this.statuses.set(providerId, {
      state: ok ? 'ok' : 'error',
      lastCheckedAt: new Date(),
      lastError: ok ? null : (opts.error ?? null),
      stats
    });
  }

  get(providerId: string): ProviderStatus {
    return this.statuses.get(providerId) ?? UNKNOWN;
  }
}

function escapeHtml(str: unknown): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  };
  return String(str).replace(/[&<>"']/g, (c) => entities[c] as string);
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return 'never';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const STATE_LABEL: Record<ProviderState, string> = { ok: 'OK', error: 'ERROR', unknown: 'UNKNOWN' };

function formatStats(stats: ProviderStats): string {
  if (stats.total === 0) return 'no requests yet';
  // % cached is of successful requests, not of total - a cache hit can only
  // happen on what would otherwise have been a success, so "cached" and
  // "failed" aren't comparable slices of the same pie.
  const cachedPart = stats.successful > 0
    ? ` (${Math.round((stats.cached / stats.successful) * 100)}% cached)`
    : '';
  return `${stats.total} served \u00b7 ${stats.successful} ok${cachedPart} \u00b7 ${stats.failed} failed`;
}

// Root-level status dashboard - not behind the apikey (nothing here is
// torrent data or lets you do anything, same reasoning as ?t=caps needing
// no key), meant to be pulled up in a browser for an at-a-glance check.
export function renderStatusPage(providers: Record<string, Provider>, tracker: ProviderStatusTracker): string {
  const rows = Object.values(providers)
    .map((provider) => {
      const status = tracker.get(provider.id);
      const errorCell = status.lastError ? escapeHtml(status.lastError) : '';
      return `  <tr class="state-${status.state}">
    <td>${escapeHtml(provider.name)}</td>
    <td><span class="badge badge-${status.state}">${STATE_LABEL[status.state]}</span></td>
    <td title="${status.lastCheckedAt ? escapeHtml(status.lastCheckedAt.toISOString()) : ''}">${escapeHtml(formatRelativeTime(status.lastCheckedAt))}</td>
    <td class="stats-cell">${escapeHtml(formatStats(status.stats))}</td>
    <td class="error-cell">${errorCell}</td>
  </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>trackarr status</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 2rem; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #333; }
  th { color: #999; font-weight: 500; font-size: 0.85rem; }
  .badge { display: inline-block; padding: 0.1rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .badge-ok { background: #1f4d2c; color: #7fd99a; }
  .badge-error { background: #4d1f1f; color: #ff8a8a; }
  .badge-unknown { background: #3a3a3a; color: #aaa; }
  .stats-cell { color: #aaa; font-size: 0.85rem; white-space: nowrap; }
  .error-cell { color: #ff8a8a; font-size: 0.85rem; font-family: ui-monospace, monospace; }
  footer { margin-top: 1.5rem; color: #666; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>trackarr</h1>
<table>
  <tr><th>Provider</th><th>Status</th><th>Last checked/used</th><th>Requests</th><th>Error</th></tr>
${rows}
</table>
<footer>Auto-refreshes every 30s.</footer>
</body>
</html>`;
}
