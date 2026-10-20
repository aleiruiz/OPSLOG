import { performance } from 'node:perf_hooks';
import type { LoadSummary, ScenarioDefinition, ScenarioFile, ScenarioStats } from './config.js';
import { expand, expandBody, percentile, type LoadFixture } from './scenario-lib.js';

export interface DriverRun {
  readonly baseUrl: string;
  readonly fixture: LoadFixture;
  readonly file: ScenarioFile;
  readonly vus: number;
  /** Stop when the time is up... */
  readonly durationMs: number;
  /** ...or after this many iterations per virtual user, whichever comes first. */
  readonly maxIterations?: number;
  /** Overrides `thinkMs` of the scenario file (tests use 0). */
  readonly thinkMs?: number;
}

interface Samples {
  readonly timings: number[];
  failures: number;
  readonly statuses: Record<string, number>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function call(run: DriverRun, scenario: ScenarioDefinition, vu: number, iter: number) {
  const session = run.fixture.sessions[
    (vu - 1) % run.fixture.sessions.length
  ] as LoadFixture['sessions'][number];
  const write = scenario.method !== 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', Cookie: session.cookie };
  if (write) {
    headers['Content-Type'] = 'application/json';
    headers['Origin'] = run.fixture.origin;
    headers['X-CSRF-Token'] = session.csrf;
  }
  const started = performance.now();
  const response = await fetch(run.baseUrl + expand(scenario.path, run.fixture, vu, iter), {
    method: scenario.method,
    headers,
    ...(write ? { body: expandBody(scenario.body, run.fixture, vu, iter) as string } : {}),
  });
  // The body is part of the response time: the user waits for the whole answer.
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

/**
 * The same scenarios as the k6 script, driven from Node (`fetch`, one loop per virtual user with the
 * same think time). It exists for hosts with neither k6 nor Docker and for the offline test of the
 * scenario definitions; the report names the driver, and k6 remains the one the task asks for.
 */
export async function runNodeDriver(run: DriverRun): Promise<LoadSummary> {
  const samples = new Map<string, Samples>(
    run.file.scenarios.map((s) => [s.id, { timings: [], failures: 0, statuses: {} }]),
  );
  const think = run.thinkMs ?? run.file.thinkMs;
  const started = performance.now();
  // Users are independent: a random start inside the cycle and 0.5 to 1.5 times the think time.
  const wait = (): Promise<void> => sleep(think * (0.5 + Math.random()));
  const user = async (vu: number): Promise<void> => {
    if (think > 0) await sleep(Math.random() * think * run.file.scenarios.length);
    for (let iter = 0; performance.now() - started < run.durationMs; iter += 1) {
      if (run.maxIterations !== undefined && iter >= run.maxIterations) return;
      for (const scenario of run.file.scenarios) {
        const bucket = samples.get(scenario.id) as Samples;
        try {
          const result = await call(run, scenario, vu, iter);
          bucket.timings.push(result.ms);
          if (result.status !== scenario.expectStatus) {
            bucket.failures += 1;
            bucket.statuses[String(result.status)] =
              (bucket.statuses[String(result.status)] ?? 0) + 1;
          }
        } catch {
          bucket.failures += 1;
          bucket.statuses['network'] = (bucket.statuses['network'] ?? 0) + 1;
        }
        if (think > 0) await wait();
      }
    }
  };
  await Promise.all(Array.from({ length: run.vus }, (_, i) => user(i + 1)));
  const scenarios: Record<string, ScenarioStats> = {};
  for (const [id, { timings, failures, statuses }] of samples) {
    const total = timings.length + (failures > 0 && timings.length === 0 ? failures : 0);
    scenarios[id] = {
      count: timings.length,
      avgMs: timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : 0,
      p95Ms: percentile(timings, 0.95),
      maxMs: timings.length ? Math.max(...timings) : 0,
      failedRate: total ? failures / Math.max(total, timings.length) : 0,
      ...(failures > 0 ? { failedStatuses: statuses } : {}),
    };
  }
  return {
    driver: 'node-fetch',
    vus: run.vus,
    durationSeconds: Math.round((performance.now() - started) / 1000),
    scenarios,
  };
}
