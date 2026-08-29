#!/usr/bin/env node
// tsc only compiles .ts to .js - it does not copy non-TS assets into dist.
// These are read at runtime via a relative fs.readFileSync from their
// compiled lib/cardigann/*.js, so they must exist alongside it in dist too.
// (definitions/schema.json is NOT here: it's read cwd-relative, same as the
// .yml definition files it validates, so it never needs a dist copy.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const assets = [
  ['lib/cardigann/schema-extensions.json', 'dist/lib/cardigann/schema-extensions.json'],
  ['lib/cardigann/config-schema.json', 'dist/lib/cardigann/config-schema.json'],
  ['lib/cardigann/pins.json', 'dist/lib/cardigann/pins.json']
];

for (const [src, dest] of assets) {
  const srcPath = path.join(root, src);
  const destPath = path.join(root, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`copied ${src} -> ${dest}`);
}
