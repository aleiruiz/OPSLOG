#!/usr/bin/env node
// Classifies the files a change touches so the quality workflow runs only the suites they can affect.
// Usage: node tools/ci/changed-scope.mjs [<base> <head>]
// Prints `key=true|false` lines for $GITHUB_OUTPUT. Without a usable base (first push, unknown commit,
// manual run) every suite runs.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Areas, checked in order; the first match wins.
// - config: shared tooling and gates; anything here can break every suite, so everything runs.
// - docs: prose only (docs/, root Markdown, LICENSE); checked by the light docs job (baselines, leak scan, format).
// - web: the browser app, the design system and the browser tests.
// - server: everything else (API, worker, domain, persistence, platform, infra, contracts, tools).
const RULES = [
  ['config', (file) => file.startsWith('docs/baselines/')],
  ['config', (file) => file.startsWith('.github/') || file.startsWith('tools/ci/')],
  ['config', (file) => file.startsWith('tests/harness/')],
  // Markdown inside a package can be a test fixture (infra/runtime/STAGING.md), so only root-level
  // Markdown and docs/ count as prose.
  ['docs', (file) => file.startsWith('docs/') || file === 'LICENSE' || /^[^/]+\.md$/.test(file)],
  ['config', (file) => !file.includes('/')],
  ['web', (file) => ['packages/ui/', 'apps/web/', 'e2e/'].some((dir) => file.startsWith(dir))],
  ['server', () => true],
];

export function areaOf(file) {
  return RULES.find(([, matches]) => matches(file))[0];
}

/** Which suites must run for the changed files; `null` means the change set is unknown. */
export function scopeOf(files) {
  if (files === null) return { product: true, integration: true };
  const areas = new Set(files.map(areaOf));
  const config = areas.has('config');
  return {
    product: config || areas.has('web') || areas.has('server'),
    integration: config || areas.has('server'),
  };
}

function changedFiles(base, head) {
  if (!base || !head || /^0+$/.test(base)) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', base, head], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = changedFiles(process.argv[2], process.argv[3]);
  const scope = scopeOf(files);
  console.error(
    files === null
      ? 'Change set unknown: running every suite.'
      : `Changed files:\n${files.join('\n')}`,
  );
  for (const [key, value] of Object.entries(scope)) console.log(`${key}=${value}`);
}
