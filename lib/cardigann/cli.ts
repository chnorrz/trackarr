#!/usr/bin/env node
// Standalone report, not imported by server.ts. Usage:
//   node dist/lib/cardigann/cli.js [dir]
// Defaults to ./definitions. Prints a schema-validity + capability-gate
// summary for every *.yml/*.yaml file in dir - used both for local
// development and to size the feature against the full upstream corpus
// (see NOTES.md's Cardigann section for the numbers that shaped phase 2's
// scope).
import path from 'node:path';
import { loadDefinitions } from './load.js';
import { checkCapability } from './capability.js';

const dir = path.resolve(process.argv[2] || 'definitions');
const { valid, invalid } = loadDefinitions(dir);

const supported: string[] = [];
const blocked: { file: string; reasons: string[] }[] = [];

for (const { file, definition } of valid) {
  const reasons = checkCapability(definition);
  if (reasons.length === 0) supported.push(file);
  else blocked.push({ file, reasons });
}

console.log(`Directory: ${dir}`);
console.log(`Total files: ${valid.length + invalid.length}`);
console.log(`  Schema-invalid: ${invalid.length}`);
console.log(`  Schema-valid: ${valid.length}`);
console.log(`    Runnable (passes capability gate): ${supported.length}`);
console.log(`    Blocked (fails capability gate): ${blocked.length}`);

if (invalid.length > 0) {
  console.log('\n--- Schema-invalid files ---');
  for (const { file, errors } of invalid) {
    console.log(`  ${file}`);
    for (const e of errors.slice(0, 3)) console.log(`    ${e}`);
  }
}

if (blocked.length > 0) {
  const reasonTally = new Map<string, number>();
  for (const { reasons } of blocked) {
    for (const r of reasons) {
      // Collapse "unsupported filter: X (at field.y)" to "unsupported filter: X"
      // and "settings.foo.type: text (...)" to "settings.*.type: text (...)" so
      // the tally counts distinct *kinds* of blocker, not distinct locations.
      const key = r
        .replace(/\(at [^)]+\)$/, '').trim()
        .replace(/^settings\.[^.]+\.type:/, 'settings.*.type:');
      reasonTally.set(key, (reasonTally.get(key) || 0) + 1);
    }
  }

  console.log('\n--- Blocker frequency (definitions hitting each reason) ---');
  const sorted = [...reasonTally.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  }

  console.log('\n--- Blocked files (first 20) ---');
  for (const { file, reasons } of blocked.slice(0, 20)) {
    console.log(`  ${file}: ${reasons.join('; ')}`);
  }
  if (blocked.length > 20) console.log(`  ... and ${blocked.length - 20} more`);
}

if (supported.length > 0) {
  console.log('\n--- Runnable files ---');
  for (const file of supported) console.log(`  ${file}`);
}
