import type { Provider } from './types.js';

export type ProviderState = 'ok' | 'error' | 'unknown';

export interface ProviderStatus {
  state: ProviderState;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

const UNKNOWN: ProviderStatus = { state: 'unknown', lastCheckedAt: null, lastError: null };

// Tracks each provider's health, updated from two places: the background
// keep-alive scheduler (server.ts's warmProvider) and real search requests
// (server.ts's createApp). "Last checked/used" is deliberately one merged
// timestamp rather than two - whichever happened more recently, background
// check or real Prowlarr request, is what's shown.
//
// Not persisted - a restart resets everyone to 'unknown' until the next
// check. That's fine: the keep-alive scheduler's boot-time warm-up (see
// server.ts) fires within a few seconds, so the window is brief.
export class ProviderStatusTracker {
  private readonly statuses = new Map<string, ProviderStatus>();

  recordSuccess(providerId: string): void {
    this.statuses.set(providerId, { state: 'ok', lastCheckedAt: new Date(), lastError: null });
  }

  recordFailure(providerId: string, error: string): void {
    this.statuses.set(providerId, { state: 'error', lastCheckedAt: new Date(), lastError: error });
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
  .error-cell { color: #ff8a8a; font-size: 0.85rem; font-family: ui-monospace, monospace; }
  footer { margin-top: 1.5rem; color: #666; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>trackarr</h1>
<table>
  <tr><th>Provider</th><th>Status</th><th>Last checked/used</th><th>Error</th></tr>
${rows}
</table>
<footer>Auto-refreshes every 30s.</footer>
</body>
</html>`;
}
