import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDefinitionYaml } from './load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Pin {
  repo: string;
  ref: string;
  path: string;
}

const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'pins.json'), 'utf8')) as Record<string, Pin>;

export interface ResolvedDefinition {
  definitionId: string;
  /** Human-readable origin, for logs/errors - a file path or a fetch URL. */
  from: string;
  definition: Record<string, unknown>;
}

export interface ResolveOptions {
  /** Bundled examples shipped in the repo. Default: 'definitions'. */
  repoDefinitionsDir: string;
  /** User-mounted override directory (DEFINITIONS_DIR env). Checked first. */
  volumeDefinitionsDir?: string;
  /** Disk cache for source:-fetched definitions (CARDIGANN_CACHE_DIR env). */
  cacheDir: string;
  /** Injectable for tests; defaults to the real fetch. */
  fetchImpl?: typeof fetch;
}

function readLocal(dir: string, definitionId: string): { from: string; raw: string } | null {
  for (const ext of ['.yml', '.yaml']) {
    const full = path.join(dir, `${definitionId}${ext}`);
    if (fs.existsSync(full)) return { from: full, raw: fs.readFileSync(full, 'utf8') };
  }
  return null;
}

function resolveSourceUrl(source: string): string {
  const pin = pins[source];
  if (pin) return `https://raw.githubusercontent.com/${pin.repo}/${pin.ref}/${pin.path}`;
  if (/^https?:\/\//.test(source)) return source;
  throw new Error(`unknown source: "${source}" (expected a raw URL, or one of: ${Object.keys(pins).join(', ')})`);
}

// source: is either a full raw URL to one .yml file, or a pin shorthand
// ("prowlarr:v11") naming a directory - in which case the definition id is
// the filename within it.
function buildFetchUrl(source: string, definitionId: string): string {
  const base = resolveSourceUrl(source);
  return pins[source] ? `${base}/${definitionId}.yml` : base;
}

async function fetchWithFallback(
  definitionId: string,
  source: string,
  cacheDir: string,
  fetchImpl: typeof fetch
): Promise<{ from: string; raw: string }> {
  const url = buildFetchUrl(source, definitionId);
  const cacheFile = path.join(cacheDir, `${definitionId}.yml`);
  const metaFile = path.join(cacheDir, `${definitionId}.meta.json`);

  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, raw, 'utf8');
    fs.writeFileSync(metaFile, JSON.stringify({ source, url, fetchedAt: new Date().toISOString() }, null, 2), 'utf8');

    return { from: `${url} (cached)`, raw };
  } catch (err) {
    // Offline restart should keep working, not take the whole config down.
    if (fs.existsSync(cacheFile)) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cardigann] fetch failed for ${definitionId} (${message}), using cached copy at ${cacheFile}`);
      return { from: `${cacheFile} (stale cache, fetch failed)`, raw: fs.readFileSync(cacheFile, 'utf8') };
    }
    throw err;
  }
}

export async function resolveDefinition(
  definitionId: string,
  source: string | undefined,
  opts: ResolveOptions
): Promise<ResolvedDefinition> {
  // DEFINITIONS_DIR always wins, even over an explicit source: - it's the
  // deliberate "I'm overriding this" escape hatch (e.g. a definition whose
  // links[] are all dead upstream, edited locally while a PR is pending).
  let found: { from: string; raw: string } | null = null;

  if (opts.volumeDefinitionsDir) {
    found = readLocal(opts.volumeDefinitionsDir, definitionId);
  }

  if (!found && source) {
    found = await fetchWithFallback(definitionId, source, opts.cacheDir, opts.fetchImpl ?? fetch);
  }

  if (!found) {
    found = readLocal(opts.repoDefinitionsDir, definitionId);
  }

  if (!found) {
    const tried = [opts.volumeDefinitionsDir, source ? `source: ${source}` : null, opts.repoDefinitionsDir].filter(Boolean);
    throw new Error(`definition "${definitionId}" not found (tried: ${tried.join(', ')})`);
  }

  const result = validateDefinitionYaml(found.raw);
  if (!result.ok) {
    throw new Error(`${found.from}: ${result.errors.join('; ')}`);
  }
  if (result.id !== definitionId) {
    throw new Error(`${found.from}: definition declares id "${result.id}", but was requested as "${definitionId}"`);
  }

  return { definitionId, from: found.from, definition: result.definition };
}
