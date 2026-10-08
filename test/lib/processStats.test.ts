import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { isCamoufoxCmdline, parseArgv, classifyProcessRole, parseVmRssKb, parsePssKb, getCamoufoxMemoryUsage } =
  await import(path.join(ROOT, 'dist', 'lib', 'processStats.js'));

test('isCamoufoxCmdline matches the camoufox-bin path regardless of case', () => {
  assert.equal(isCamoufoxCmdline('/opt/camoufox/camoufox-bin\0-headless\0'), true);
  assert.equal(isCamoufoxCmdline('/OPT/CAMOUFOX/CAMOUFOX-BIN'), true);
});

test('isCamoufoxCmdline rejects unrelated processes', () => {
  assert.equal(isCamoufoxCmdline('/usr/bin/node\0dist/server.js\0'), false);
  assert.equal(isCamoufoxCmdline(''), false);
});

test('parseArgv splits on NUL and drops empty trailing entries', () => {
  assert.deepEqual(parseArgv('/opt/camoufox/camoufox-bin\0-contentproc\0-childID\x001\0tab\0'), [
    '/opt/camoufox/camoufox-bin',
    '-contentproc',
    '-childID',
    '1',
    'tab'
  ]);
  assert.deepEqual(parseArgv(''), []);
});

// Confirmed live (Docker, real Camoufox container): "parent" and
// "forkserver" processes get real NUL-separated /proc/<pid>/cmdline, but
// Firefox's own content-process launcher hands "tab"/"socket"/"rdd"/
// "utility" children a cmdline that is ONE single NUL-terminated element
// containing the entire command line space-separated instead. Splitting on
// NUL alone left every one of those permanently misclassified as 'parent'
// (a real bug, caught only by the live test, not by any of the tests
// above using a hand-written properly-NUL-separated fixture).
test('parseArgv also splits on whitespace, for the real-world case where a whole content-process cmdline arrives as a single NUL-separated element', () => {
  const singleElement = '/opt/camoufox/camoufox-bin -contentproc -isForBrowser -parentPid 26 3 tab\0';
  assert.deepEqual(parseArgv(singleElement), ['/opt/camoufox/camoufox-bin', '-contentproc', '-isForBrowser', '-parentPid', '26', '3', 'tab']);
});

test('classifyProcessRole treats a cmdline without -contentproc as the parent process', () => {
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-headless']), 'parent');
});

test('classifyProcessRole maps known Firefox child process types', () => {
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'tab']), 'tab');
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'webIsolated']), 'tab');
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'gpu']), 'gpu');
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'rdd']), 'gpu');
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'socket']), 'socket');
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'forkserver']), 'forkserver');
});

test('classifyProcessRole falls back to utility for an unrecognised child type', () => {
  assert.equal(classifyProcessRole(['/opt/camoufox/camoufox-bin', '-contentproc', 'someNewFirefoxType']), 'utility');
});

test('parseVmRssKb extracts the kB value from /proc/<pid>/status text', () => {
  const status = 'Name:\tcamoufox-bin\nVmPeak:\t   123456 kB\nVmRSS:\t   45678 kB\nVmSize:\t 654321 kB\n';
  assert.equal(parseVmRssKb(status), 45678);
});

test('parseVmRssKb returns null when VmRSS is missing', () => {
  assert.equal(parseVmRssKb('Name:\tsomething\n'), null);
});

test('parsePssKb extracts the kB value from /proc/<pid>/smaps_rollup text', () => {
  const rollup = '00400000-ffffffffff ---p 00000000 00:00 0                  [rollup]\nRss:              123456 kB\nPss:               98765 kB\n';
  assert.equal(parsePssKb(rollup), 98765);
});

test('parsePssKb returns null on a kernel without smaps_rollup support', () => {
  assert.equal(parsePssKb('Rss:  123 kB\n'), null);
});

test('getCamoufoxMemoryUsage reports not running on a non-Linux platform', async (t) => {
  if (process.platform === 'linux') {
    t.skip('this host is Linux - platform short-circuit not exercised here');
    return;
  }
  const usage = await getCamoufoxMemoryUsage();
  assert.deepEqual(usage, { running: false, processCount: 0, totalRssBytes: 0, totalPssBytes: null, processes: [] });
});
