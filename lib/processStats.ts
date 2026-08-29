import fs from 'node:fs/promises';

// Firefox's real subprocess types (last positional argv element when
// -contentproc is present - see GeckoChildProcessHost.cpp's arg layout).
// "web"/"webIsolated"/"privilegedabout"/"privilegedmozilla" are all page-
// hosting content processes; grouped as 'tab' since that's what a persistent
// page in browser.ts actually costs. Anything unrecognised falls back to
// 'utility' rather than throwing - Firefox versions add new process types.
export type ProcessRole = 'parent' | 'tab' | 'gpu' | 'socket' | 'utility' | 'forkserver';

const CHILD_TYPE_ROLE: Record<string, ProcessRole> = {
  tab: 'tab',
  web: 'tab',
  webIsolated: 'tab',
  privilegedabout: 'tab',
  privilegedmozilla: 'tab',
  gpu: 'gpu',
  rdd: 'gpu',
  socket: 'socket',
  utility: 'utility',
  forkserver: 'forkserver'
};

export interface CamoufoxProcessInfo {
  pid: number;
  rssBytes: number;
  // null on a kernel without /proc/<pid>/smaps_rollup (older than ~4.14) -
  // RSS double-counts pages shared across processes, PSS doesn't.
  pssBytes: number | null;
  role: ProcessRole;
}

export interface CamoufoxMemoryUsage {
  running: boolean;
  processCount: number;
  totalRssBytes: number;
  // null unless every process reported a real PSS - a partial sum would
  // understate the total silently, which is worse than admitting we don't know.
  totalPssBytes: number | null;
  processes: CamoufoxProcessInfo[];
}

const NOT_RUNNING: CamoufoxMemoryUsage = {
  running: false,
  processCount: 0,
  totalRssBytes: 0,
  totalPssBytes: null,
  processes: []
};

// Camoufox's own binary is named "camoufox-bin" on Linux (see camoufox-js's
// pkgman.js OS_NAME map). Firefox is multi-process - every content/child
// process camoufox forks execs that same binary path with different flags -
// so matching "camoufox" anywhere in cmdline catches the whole process tree,
// not just the top-level one.
export function isCamoufoxCmdline(cmdline: string): boolean {
  return cmdline.toLowerCase().includes('camoufox');
}

// /proc/<pid>/cmdline is documented as NUL-separated, but confirmed live
// (Docker/overlay, this exact kernel) that Firefox's own content-process
// launcher does not actually honor that for every child: the "parent" and
// "forkserver" processes come back properly NUL-separated, but "tab"/
// "socket"/"rdd"/"utility" children arrive as a single argv element
// containing the whole command line space-separated instead - splitting on
// NUL alone left every one of those permanently unclassifiable (never
// matching '-contentproc' as an exact element, always falling back to
// 'parent'). Splitting on NUL-or-whitespace handles both shapes uniformly;
// the only cost is that a legitimate argument value containing a literal
// space would be split too, which doesn't happen among the flag names and
// bare-word process types this function actually inspects.
export function parseArgv(cmdline: string): string[] {
  return cmdline.split(/[\0\s]+/).filter((arg) => arg.length > 0);
}

export function classifyProcessRole(argv: string[]): ProcessRole {
  if (!argv.includes('-contentproc')) return 'parent';
  const type = argv[argv.length - 1] ?? '';
  return CHILD_TYPE_ROLE[type] ?? 'utility';
}

export function parseVmRssKb(statusText: string): number | null {
  const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) : null;
}

// smaps_rollup's first line is a fake VMA range, the fields below it are
// plain "Key:  value kB" - same shape as /proc/<pid>/status's VmRSS line.
export function parsePssKb(smapsRollupText: string): number | null {
  const match = smapsRollupText.match(/^Pss:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) : null;
}

async function readCamoufoxProcess(pid: string): Promise<CamoufoxProcessInfo | null> {
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (!isCamoufoxCmdline(cmdline)) return null;

    const [status, smapsRollup] = await Promise.all([
      fs.readFile(`/proc/${pid}/status`, 'utf8'),
      // Not every kernel exposes this file - missing is a capability gap,
      // not a reason to drop the whole process from the report.
      fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => null)
    ]);

    const rssKb = parseVmRssKb(status);
    if (rssKb === null) return null;
    const pssKb = smapsRollup ? parsePssKb(smapsRollup) : null;

    return {
      pid: Number(pid),
      rssBytes: rssKb * 1024,
      pssBytes: pssKb === null ? null : pssKb * 1024,
      role: classifyProcessRole(parseArgv(cmdline))
    };
  } catch {
    // Process exited between the /proc listing and reading its files - a
    // normal race under a process-table scan, not an error.
    return null;
  }
}

// Linux-only: relies on /proc, which is how the app always runs in Docker
// (see Dockerfile). Elsewhere (e.g. local dev on macOS) this reports "not
// running" rather than shelling out to `ps` - the runtime image intentionally
// ships nothing beyond what Firefox itself needs.
export async function getCamoufoxMemoryUsage(): Promise<CamoufoxMemoryUsage> {
  if (process.platform !== 'linux') return NOT_RUNNING;

  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  } catch {
    return NOT_RUNNING;
  }

  const results = await Promise.all(pids.map(readCamoufoxProcess));
  const processes = results.filter((p): p is CamoufoxProcessInfo => p !== null);
  if (processes.length === 0) return NOT_RUNNING;

  const totalRssBytes = processes.reduce((sum, p) => sum + p.rssBytes, 0);
  const totalPssBytes = processes.every((p) => p.pssBytes !== null)
    ? processes.reduce((sum, p) => sum + (p.pssBytes as number), 0)
    : null;

  return { running: true, processCount: processes.length, totalRssBytes, totalPssBytes, processes };
}
