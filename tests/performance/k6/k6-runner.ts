import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { K6_DIR, type LoadSummary, type ScenarioFile } from './config.js';
import type { LoadFixture } from './scenario-lib.js';

/** How k6 is available on this host: a local binary, a working Docker daemon, or not at all. */
export function detectK6(): 'binary' | 'docker' | 'none' {
  if (spawnSync('sh', ['-c', 'command -v k6']).status === 0) return 'binary';
  if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }).status === 0)
    return 'docker';
  return 'none';
}

export interface K6Run {
  readonly mode: 'binary' | 'docker';
  readonly baseUrl: string;
  readonly fixture: LoadFixture;
  readonly file: ScenarioFile;
  readonly vus: number;
  readonly duration: string;
  readonly thinkMs: number;
}

/** Runs the k6 script against the stack and returns its JSON summary. The k6 exit code is not an error: the summary is the result. */
export async function runK6(run: K6Run): Promise<LoadSummary> {
  const out = mkdtempSync(join(tmpdir(), 'opslog-k6-'));
  try {
    const env = {
      OPSLOG_LOAD_BASE_URL: run.baseUrl,
      OPSLOG_LOAD_FIXTURE: JSON.stringify(run.fixture),
      OPSLOG_LOAD_DURATION: run.duration,
      OPSLOG_LOAD_VUS: String(run.vus),
      OPSLOG_LOAD_THINK_MS: String(run.thinkMs),
    };
    const args =
      run.mode === 'binary'
        ? ['run', '--quiet', join(K6_DIR, 'scenarios.js')]
        : [
            'run',
            '--rm',
            '--network',
            'host',
            '-v',
            `${K6_DIR}:/scripts:ro`,
            '-v',
            `${out}:/out`,
            ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
            run.file.k6Image,
            'run',
            '--quiet',
            '/scripts/scenarios.js',
          ];
    const summaryPath =
      run.mode === 'binary' ? join(out, 'k6-summary.json') : '/out/k6-summary.json';
    const command = run.mode === 'binary' ? 'k6' : 'docker';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        env: {
          ...process.env,
          ...(run.mode === 'binary' ? { ...env, OPSLOG_LOAD_SUMMARY: summaryPath } : {}),
        },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    return JSON.parse(readFileSync(join(out, 'k6-summary.json'), 'utf8')) as LoadSummary;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
