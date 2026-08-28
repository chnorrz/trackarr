import fs from 'node:fs/promises';

export interface CamoufoxProcessInfo {
  pid: number;
  rssBytes: number;
}

export interface CamoufoxMemoryUsage {
  running: boolean;
  processCount: number;
  totalRssBytes: number;
  processes: CamoufoxProcessInfo[];
}

const NOT_RUNNING: CamoufoxMemoryUsage = { running: false, processCount: 0, totalRssBytes: 0, processes: [] };

// Camoufox's own binary is named "camoufox-bin" on Linux (see camoufox-js's
// pkgman.js OS_NAME map). Firefox is multi-process - every content/child
// process camoufox forks execs that same binary path with different flags -
// so matching "camoufox" anywhere in cmdline catches the whole process tree,
// not just the top-level one.
export function isCamoufoxCmdline(cmdline: string): boolean {
  return cmdline.toLowerCase().includes('camoufox');
}

export function parseVmRssKb(statusText: string): number | null {
  const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Number(match[1]) : null;
}

async function readCamoufoxProcess(pid: string): Promise<CamoufoxProcessInfo | null> {
  try {
    const [cmdline, status] = await Promise.all([
      fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      fs.readFile(`/proc/${pid}/status`, 'utf8')
    ]);
    if (!isCamoufoxCmdline(cmdline)) return null;
    const rssKb = parseVmRssKb(status);
    if (rssKb === null) return null;
    return { pid: Number(pid), rssBytes: rssKb * 1024 };
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
  return { running: true, processCount: processes.length, totalRssBytes, processes };
}
