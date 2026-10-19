import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadScenarios, type LoadSummary } from './config.js';
import { runNodeDriver } from './driver.js';
import { detectK6, runK6 } from './k6-runner.js';
import { machineInfo, metricRows, renderReport, type MetricRow } from './report.js';
import type { SeedSize } from './seed.js';
import { startLoadStack } from './stack.js';

export interface LoadRunOptions {
  readonly backend: 'mysql' | 'memory';
  readonly adminUrl?: string | undefined;
  readonly size: SeedSize;
  readonly vus: number;
  readonly durationSeconds: number;
  readonly baselineSeconds: number;
  /** Think time of the one-user baseline: short, to collect enough samples of an uncontended request. */
  readonly baselineThinkMs?: number | undefined;
  /** `auto` uses k6 (binary or the pinned Docker image) when present and the Node driver otherwise. */
  readonly driver: 'auto' | 'k6' | 'node';
  readonly thinkMs?: number | undefined;
  readonly maxIterations?: number | undefined;
}

export interface LoadRunResult {
  readonly summary: LoadSummary;
  readonly baseline: LoadSummary | undefined;
  readonly rows: MetricRow[];
  readonly serverErrors: Readonly<Record<string, number>>;
  readonly markdown: string;
}

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'desconocido';
  }
};

/** Starts the stack, seeds it, runs the scenarios (and the one-user baseline) and renders the report. */
export async function runLoad(
  options: LoadRunOptions,
  reportPath?: string,
): Promise<LoadRunResult> {
  const file = loadScenarios();
  const stack = await startLoadStack({
    backend: options.backend,
    adminUrl: options.adminUrl,
    size: options.size,
    sessions: options.vus,
  });
  try {
    const mode = options.driver === 'node' ? 'none' : detectK6();
    if (options.driver === 'k6' && mode === 'none')
      throw new Error('k6 is not available: install k6 or a Docker daemon');
    const measure = async (
      vus: number,
      seconds: number,
      thinkMs?: number,
    ): Promise<LoadSummary> => {
      const fixture = { ...stack.fixture, run: randomBytes(2).toString('hex').toUpperCase() };
      return mode === 'none'
        ? runNodeDriver({
            baseUrl: stack.baseUrl,
            fixture,
            file,
            vus,
            durationMs: seconds * 1000,
            ...(options.maxIterations === undefined
              ? {}
              : { maxIterations: options.maxIterations }),
            ...(thinkMs === undefined ? {} : { thinkMs }),
          })
        : runK6({
            mode,
            baseUrl: stack.baseUrl,
            fixture,
            file,
            vus,
            duration: `${seconds}s`,
            thinkMs: thinkMs ?? file.thinkMs,
          });
    };
    const baseline =
      options.baselineSeconds > 0
        ? await measure(1, options.baselineSeconds, options.baselineThinkMs ?? 100)
        : undefined;
    const summary = await measure(options.vus, options.durationSeconds, options.thinkMs);
    const markdown = renderReport({
      summary,
      baseline,
      file,
      machine: machineInfo(),
      size: stack.size,
      backend: stack.backend,
      mysqlVersion: stack.mysqlVersion,
      commit: commit(),
      date: new Date().toISOString().slice(0, 10),
    });
    if (reportPath) writeFileSync(reportPath, markdown);
    return {
      summary,
      baseline,
      rows: metricRows(summary, file, baseline),
      serverErrors: stack.serverErrors(),
      markdown,
    };
  } finally {
    await stack.close();
  }
}
