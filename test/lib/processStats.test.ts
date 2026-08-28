import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { isCamoufoxCmdline, parseVmRssKb, getCamoufoxMemoryUsage } = await import(
  path.join(ROOT, 'dist', 'lib', 'processStats.js')
);

test('isCamoufoxCmdline matches the camoufox-bin path regardless of case', () => {
  assert.equal(isCamoufoxCmdline('/opt/camoufox/camoufox-bin\0-headless\0'), true);
  assert.equal(isCamoufoxCmdline('/OPT/CAMOUFOX/CAMOUFOX-BIN'), true);
});

test('isCamoufoxCmdline rejects unrelated processes', () => {
  assert.equal(isCamoufoxCmdline('/usr/bin/node\0dist/server.js\0'), false);
  assert.equal(isCamoufoxCmdline(''), false);
});

test('parseVmRssKb extracts the kB value from /proc/<pid>/status text', () => {
  const status = 'Name:\tcamoufox-bin\nVmPeak:\t   123456 kB\nVmRSS:\t   45678 kB\nVmSize:\t 654321 kB\n';
  assert.equal(parseVmRssKb(status), 45678);
});

test('parseVmRssKb returns null when VmRSS is missing', () => {
  assert.equal(parseVmRssKb('Name:\tsomething\n'), null);
});

test('getCamoufoxMemoryUsage reports not running on a non-Linux platform', async (t) => {
  if (process.platform === 'linux') {
    t.skip('this host is Linux - platform short-circuit not exercised here');
    return;
  }
  const usage = await getCamoufoxMemoryUsage();
  assert.deepEqual(usage, { running: false, processCount: 0, totalRssBytes: 0, processes: [] });
});
