#!/usr/bin/env node
// tsc only compiles .ts to .js - it does not copy non-TS assets into dist.
// lib/cardigann/schema.json is imported at runtime via a relative
// fs.readFileSync from the compiled lib/cardigann/load.js, so it must exist
// alongside it in dist too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const assets = [
  ['lib/cardigann/schema.json', 'dist/lib/cardigann/schema.json']
];

for (const [src, dest] of assets) {
  const srcPath = path.join(root, src);
  const destPath = path.join(root, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`copied ${src} -> ${dest}`);
}
