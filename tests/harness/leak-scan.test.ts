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
const dbUrl = `${'mysql'}://root:${'hunter2hunter2'}@db.internal/app`;
const emptyUserUrl = `${'mysql'}://:${'hunter2hunter2'}@db.internal/app`;
const httpsUrl = `${'https'}://deploy:${'hunter2hunter2'}@git.internal/repo.git`;
const pgp = `-----BEGIN ${'PGP'} PRIVATE KEY BLOCK-----`;
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
    ['URL with a password', dbUrl],
    ['URL with a password', emptyUserUrl],
    ['URL with a password', httpsUrl],
    ['private key block', pgp],
    ['npm auth token', npmrc],
  ])('fails on a %s and names the file and line', (name, value) => {
    const result = scan({ 'src/leak.ts': `const ok = 1;\nconst leaked = '${value}';\n` });
    expect(result.status).toBe(1);
    expect(result.out).toContain(`src/leak.ts:2: ${name}`);
    expect(result.out).not.toContain(value);
  });

  it('fails on tracked secret-like file names', () => {
    for (const name of [
      '.env',
      '.env.production',
      'deploy/id_rsa',
      'certs/server.pem',
      'k.key',
      '.npmrc',
      'a/.npmrc',
    ]) {
      const result = scan({ [name]: 'x\n' });
      expect(result.status, name).toBe(1);
      expect(result.out).toContain(`${name}: secret-like file name is tracked`);
    }
  });

  it('accepts only a trailing comment with a reason after the value, and lists it', () => {
    const marked = `const fixture = '${aws}'; // secret-scan:allow synthetic negative fixture\n`;
    const ok = scan({ 'a.ts': marked });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('a.ts:1: AWS access key id (allowed, reason recorded in source)');
    expect(ok.out).not.toContain(aws);
    expect(
      scan({ 'a.py': `fixture = '${aws}'  # secret-scan:allow synthetic fixture\n` }).status,
    ).toBe(0);
    // Only that line is allowed.
    expect(scan({ 'a.ts': `${marked}const other = '${aws}';\n` }).status).toBe(1);
    // No reason, a marker that is not a trailing comment, or a value after the marker: all fail.
    for (const line of [
      `const x = '${aws}'; // secret-scan:allow\n`,
      `const x = '${aws}'; // secret-scan:allow   \n`,
      `const x = '${aws}'; /* secret-scan:allow reason */\n`,
      `const secret_scan_allow = 'secret-scan:allow reason'; const x = '${aws}';\n`,
      `// secret-scan:allow reason ${aws}\n`,
    ])
      expect(scan({ 'a.ts': line }).status, line).toBe(1);
  });

  it('checks every match on a line and never echoes the allow reason', () => {
    // A second value after the marker position, or a second match of the same pattern, still fails.
    const second = `AKIA${'QRSTUVWXYZ234567'}`;
    expect(scan({ 'a.ts': `const x = ['${aws}', '${second}'];\n` }).status).toBe(1);
    expect(
      scan({ 'a.ts': `const x = '${aws}'; const y = '${second}'; // secret-scan:allow ok\n` })
        .status,
    ).toBe(0);
    expect(
      scan({ 'a.ts': `const x = '${aws}'; // secret-scan:allow ok\nconst y = '${second}';\n` })
        .status,
    ).toBe(1);
    const reasonSecret = `reason-${'zzTOPSECRETzz'}`;
    const result = scan({ 'a.ts': `const x = '${aws}'; // secret-scan:allow ${reasonSecret}\n` });
    expect(result.status).toBe(0);
    expect(result.out).toContain('AWS access key id');
    expect(result.out).not.toContain(reasonSecret);
  });

  it('finds a value glued to an identifier character and in files with NUL bytes', () => {
    expect(scan({ 'a.ts': `const x = 'x_${aws}';\n` }).status).toBe(1);
    expect(scan({ 'a.ts': `const x = 'x_${github}';\n` }).status).toBe(1);
    expect(scan({ 'data.bin': `\0${aws}\0` }).status).toBe(1);
    expect(scan({ 'data.bin': '\0\0plain\0' }).status).toBe(0);
  });

  it('does not take long near-matches for a leak, and finishes quickly on hostile lines', () => {
    const hostile = `${'mysql'}://${'a:'.repeat(50_000)}\n${'-----BEGIN '.repeat(20_000)}\n${'x'.repeat(200_000)}\n`;
    const started = Date.now();
    const result = scan({
      'big.txt': hostile,
      'ok.txt': `see ${'https'}://example.com:8080/path\n`,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).toBe(0);
    expect(result.out).not.toContain('ok.txt');
  });

  it('passes on this repository (tracked files, including this test)', () => {
    const result = spawnSync('node', [script], {
      cwd: join(dirname(script), '..', '..'),
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
