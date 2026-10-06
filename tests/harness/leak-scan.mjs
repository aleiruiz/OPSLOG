#!/usr/bin/env node
// Offline secret scan of the files tracked by git (SPECS §9.2, "análisis de secretos"). No network,
// no third-party code: high-confidence token patterns and secret-like file names only.
// A line that deliberately holds a synthetic negative fixture carries `secret-scan:allow` (with the reason).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Anthropic or OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'database URL with a password',
    /\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/,
  ],
  ['npm auth token', /_authToken\s*=\s*[^\s$]+/],
];
const SECRET_FILES =
  /(?:^|\/)(?:\.env(?:\..*)?|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/;
const ALLOW = 'secret-scan:allow';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0')
  .filter(Boolean);
const findings = [];
for (const file of files) {
  if (SECRET_FILES.test(file)) findings.push(`${file}: secret-like file name is tracked`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(ALLOW)) continue;
    for (const [name, pattern] of PATTERNS)
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${name}`);
  }
}
if (findings.length > 0) {
  console.error(`Secret scan FAILED:\n${findings.map((line) => `- ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan OK: ${files.length} tracked files`);
