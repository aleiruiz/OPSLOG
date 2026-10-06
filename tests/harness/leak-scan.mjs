#!/usr/bin/env node
// Offline secret scan of the files tracked by git (SPECS §9.2, "análisis de secretos"). No network,
// no third-party code: high-confidence token patterns and secret-like file names only. Every
// pattern is linear (no nested or overlapping quantifiers), so a hostile line cannot stall it.
//
// A line that deliberately holds a synthetic negative fixture ends with a trailing comment
// `// secret-scan:allow <reason>` (or `# secret-scan:allow <reason>`) written after the value; the
// reason is required and every allowed line is listed in the output so reviewers see them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NOT_ALNUM_BEFORE = '(?<![A-Za-z0-9])';
const PATTERNS = [
  ['AWS access key id', /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/],
  ['private key block', /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----/],
  [
    'GitHub token',
    new RegExp(`${NOT_ALNUM_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`),
  ],
  ['Slack token', new RegExp(`${NOT_ALNUM_BEFORE}xox[abprs]-[A-Za-z0-9-]{10,}`)],
  ['Anthropic or OpenAI key', new RegExp(`${NOT_ALNUM_BEFORE}sk-(?:ant-)?[A-Za-z0-9_-]{32,}`)],
  ['Google API key', new RegExp(`${NOT_ALNUM_BEFORE}AIza[0-9A-Za-z_-]{35}`)],
  [
    'JSON web token',
    new RegExp(
      `${NOT_ALNUM_BEFORE}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
    ),
  ],
  [
    'URL with a password',
    /(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|https?|ftps?|ssh):\/\/[^\s:@/]*:[^\s@/]+@/,
  ],
  ['npm auth token', /_authToken\s*=\s*[^\s$]+/],
];
const SECRET_FILES =
  /(?:^|\/)(?:\.env(?:\..*)?|\.netrc|\.npmrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/;
// Only a trailing comment with a reason allows a line; the value must come before the marker.
const ALLOW = /(?:\/\/|#)[ \t]*secret-scan:allow[ \t]+(\S.*)$/;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0')
  .filter(Boolean);
const findings = [];
const allowed = [];
for (const file of files) {
  if (SECRET_FILES.test(file)) findings.push(`${file}: secret-like file name is tracked`);
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  // Binary files are scanned too (a NUL byte must not hide a value): latin1 keeps one char per byte.
  const lines = bytes.toString(bytes.includes(0) ? 'latin1' : 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = ALLOW.exec(line);
    for (const [name, pattern] of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (marker && match.index < marker.index)
        allowed.push(`${file}:${index + 1}: ${name} (allowed: ${marker[1].trim()})`);
      else findings.push(`${file}:${index + 1}: ${name}`);
    }
  }
}
if (allowed.length > 0)
  console.log(`Allowed fixtures:\n${allowed.map((line) => `- ${line}`).join('\n')}`);
if (findings.length > 0) {
  console.error(`Secret scan FAILED:\n${findings.map((line) => `- ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan OK: ${files.length} tracked files`);
