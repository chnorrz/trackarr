import type { CamoufoxMemoryUsage } from './processStats.js';
import type { Provider } from './types.js';

export type ProviderState = 'ok' | 'error' | 'unknown';

// `cached` is a subset of `successful`, not a separate outcome, and `total` is
// `successful + failed` - these are not disjoint slices.
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

export class ProviderStatusTracker {
  private readonly statuses = new Map<string, ProviderStatus>();

  private statsFor(providerId: string): ProviderStats {
    return this.statuses.get(providerId)?.stats ?? EMPTY_STATS;
  }

  recordCheck(providerId: string, ok: boolean, error?: string): void {
    this.statuses.set(providerId, {
      state: ok ? 'ok' : 'error',
      lastCheckedAt: new Date(),
      lastError: ok ? null : (error ?? null),
      stats: this.statsFor(providerId)
    });
  }

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

export interface StatusJsonProvider {
  id: string;
  name: string;
  state: ProviderState;
  lastCheckedAt: string | null;
  lastError: string | null;
  stats: ProviderStats;
}

export interface StatusJson {
  generatedAt: string;
  providers: StatusJsonProvider[];
  camoufox: CamoufoxMemoryUsage;
}

export function buildStatusJson(
  providers: Record<string, Provider>,
  tracker: ProviderStatusTracker,
  camoufox: CamoufoxMemoryUsage
): StatusJson {
  return {
    generatedAt: new Date().toISOString(),
    providers: Object.values(providers).map((provider) => {
      const status = tracker.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        state: status.state,
        lastCheckedAt: status.lastCheckedAt ? status.lastCheckedAt.toISOString() : null,
        lastError: status.lastError,
        stats: status.stats
      };
    }),
    camoufox
  };
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
  const cachedPart = stats.successful > 0
    ? ` (${Math.round((stats.cached / stats.successful) * 100)}% cached)`
    : '';
  return `${stats.total} served \u00b7 ${stats.successful} ok${cachedPart} \u00b7 ${stats.failed} failed`;
}

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
<title>trackarr status</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 2rem; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  h2 { font-size: 1rem; font-weight: 600; color: #ccc; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #333; }
  th { color: #999; font-weight: 500; font-size: 0.85rem; }
  .badge { display: inline-block; padding: 0.1rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .badge-ok { background: #1f4d2c; color: #7fd99a; }
  .badge-error { background: #4d1f1f; color: #ff8a8a; }
  .badge-unknown { background: #3a3a3a; color: #aaa; }
  .stats-cell { color: #aaa; font-size: 0.85rem; white-space: nowrap; }
  .error-cell { color: #ff8a8a; font-size: 0.85rem; font-family: ui-monospace, monospace; }
  #camoufox-stats { color: #aaa; font-size: 0.85rem; }
  #camoufox-stats .proc-list { color: #666; font-size: 0.8rem; margin-top: 0.25rem; }
  footer { margin-top: 1.5rem; color: #666; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>trackarr</h1>
<table>
  <thead>
    <tr><th>Provider</th><th>Status</th><th>Last checked/used</th><th>Requests</th><th>Error</th></tr>
  </thead>
  <tbody id="provider-rows">
${rows}
  </tbody>
</table>
<h2>Camoufox</h2>
<div id="camoufox-stats">Loading\u2026</div>
<footer>Updates automatically every 30s &middot; last updated <span id="last-updated">just now</span></footer>
<script>
(function () {
  var STATE_LABEL = { ok: 'OK', error: 'ERROR', unknown: 'UNKNOWN' };

  function escapeHtml(str) {
    var entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
    return String(str).replace(/[&<>'"]/g, function (c) { return entities[c]; });
  }

  function formatRelativeTime(iso) {
    if (!iso) return 'never';
    var seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.round(hours / 24);
    return days + 'd ago';
  }

  function formatStats(stats) {
    if (stats.total === 0) return 'no requests yet';
    var cachedPart = stats.successful > 0
      ? ' (' + Math.round((stats.cached / stats.successful) * 100) + '% cached)'
      : '';
    return stats.total + ' served \\u00b7 ' + stats.successful + ' ok' + cachedPart + ' \\u00b7 ' + stats.failed + ' failed';
  }

  function renderRow(p) {
    var errorCell = p.lastError ? escapeHtml(p.lastError) : '';
    return '<tr class="state-' + p.state + '">' +
      '<td>' + escapeHtml(p.name) + '</td>' +
      '<td><span class="badge badge-' + p.state + '">' + STATE_LABEL[p.state] + '</span></td>' +
      '<td title="' + (p.lastCheckedAt ? escapeHtml(p.lastCheckedAt) : '') + '">' + escapeHtml(formatRelativeTime(p.lastCheckedAt)) + '</td>' +
      '<td class="stats-cell">' + escapeHtml(formatStats(p.stats)) + '</td>' +
      '<td class="error-cell">' + errorCell + '</td>' +
      '</tr>';
  }

  function formatBytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderCamoufox(c) {
    if (!c.running) return 'Not running';
    var procList = c.processes
      .slice()
      .sort(function (a, b) { return b.rssBytes - a.rssBytes; })
      .map(function (p) { return 'pid ' + p.pid + ': ' + formatBytes(p.rssBytes); })
      .join(', ');
    return 'Running &middot; ' + c.processCount + ' process' + (c.processCount === 1 ? '' : 'es') +
      ' &middot; ' + formatBytes(c.totalRssBytes) + ' total' +
      '<div class="proc-list">' + escapeHtml(procList) + '</div>';
  }

  function refresh() {
    fetch('/status.json')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        document.getElementById('provider-rows').innerHTML = data.providers.map(renderRow).join('\\n');
        document.getElementById('camoufox-stats').innerHTML = renderCamoufox(data.camoufox);
        document.getElementById('last-updated').textContent = 'just now';
      })
      .catch(function (err) { console.error('status refresh failed', err); });
  }

  refresh();
  setInterval(refresh, 30000);
})();
</script>
</body>
</html>`;
}
