#!/usr/bin/env node
// Verifies every docs/baselines/BASELINE-*.json manifest: each listed file must exist and match its sha256.
// Frozen baselines must never change; an intentional successor adds a new manifest instead of editing old files.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestDir = join(root, 'docs', 'baselines');
const manifests = readdirSync(manifestDir).filter((name) => /^BASELINE-.+\.json$/.test(name));
let checked = 0;
const failures = [];

if (manifests.length === 0) failures.push('no BASELINE-*.json manifests found');
for (const name of manifests.sort()) {
  const manifest = JSON.parse(readFileSync(join(manifestDir, name), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    failures.push(`${name}: no files listed`);
    continue;
  }
  for (const entry of manifest.files) {
    checked += 1;
    let bytes;
    try {
      bytes = readFileSync(join(root, entry.path));
    } catch {
      failures.push(`${name}: missing ${entry.path}`);
      continue;
    }
    if (bytes.includes(13))
      failures.push(`${name}: ${entry.path} contains CR bytes (line endings)`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256)
      failures.push(`${name}: ${entry.path} sha256 ${actual} != ${entry.sha256}`);
  }
}
if (failures.length > 0) {
  console.error(`Baseline integrity FAILED:\n${failures.map((line) => `- ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`Baseline integrity OK: ${checked} files across ${manifests.length} manifests`);
