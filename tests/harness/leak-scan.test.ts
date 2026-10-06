import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'leak-scan.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Scans a throwaway git repository holding exactly `files`. */
function scan(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'opslog-leak-scan-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const result = spawnSync('node', [script], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// Synthetic values are assembled at run time so this file never contains a complete match.
const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const pem = `-----BEGIN ${'PRIVATE'} KEY-----`;
const github = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const slack = `xoxb-${'1234567890-abcdefghij'}`;
const apiKey = `sk-ant-${'api03-abcdefghijklmnopqrstuvwxyz0123456789'}`;
const google = `AIza${'SyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q'}`;
const jwt = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'abcdefghijklmnop'}`;
const dbUrl = `mysql://root:${'hunter2hunter2'}@db.internal/app`;
const npmrc = `//registry.example/:_authToken=${'abcdef123456'}`;

describe('leak scan', () => {
  it('passes a clean tree and a passwordless loopback URL', () => {
    const result = scan({
      'a.ts': 'export const url = "mysql://root@127.0.0.1:3306/mysql";\n',
      'b.md': '# notes\n',
    });
    expect(result.status).toBe(0);
    expect(result.out).toContain('Secret scan OK: 2 tracked files');
  });

  it.each([
    ['AWS access key id', aws],
    ['private key block', pem],
    ['GitHub token', github],
    ['Slack token', slack],
    ['Anthropic or OpenAI key', apiKey],
    ['Google API key', google],
    ['JSON web token', jwt],
    ['database URL with a password', dbUrl],
    ['npm auth token', npmrc],
  ])('fails on a %s and names the file and line', (name, value) => {
    const result = scan({ 'src/leak.ts': `const ok = 1;\nconst leaked = '${value}';\n` });
    expect(result.status).toBe(1);
    expect(result.out).toContain(`src/leak.ts:2: ${name}`);
    expect(result.out).not.toContain(value);
  });

  it('fails on tracked secret-like file names', () => {
    for (const name of ['.env', '.env.production', 'deploy/id_rsa', 'certs/server.pem', 'k.key']) {
      const result = scan({ [name]: 'x\n' });
      expect(result.status, name).toBe(1);
      expect(result.out).toContain(`${name}: secret-like file name is tracked`);
    }
  });

  it('accepts a line that carries the allow marker, and only that line', () => {
    const marked = `const fixture = '${aws}'; // secret-scan:allow synthetic negative fixture\n`;
    expect(scan({ 'a.ts': marked }).status).toBe(0);
    expect(scan({ 'a.ts': `${marked}const other = '${aws}';\n` }).status).toBe(1);
  });

  it('ignores binary files', () => {
    expect(scan({ 'data.bin': `\0${aws}\0` }).status).toBe(0);
  });
});
