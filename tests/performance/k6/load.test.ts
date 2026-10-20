import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runLoad } from './run.js';

/**
 * The measured load run (`pnpm ops:load`): the real server entry point over MySQL with one company at
 * the size of SPECS §9.3, 50 virtual users. Opt-in: OPSLOG_LOAD=1 and OPSLOG_TEST_MYSQL_ADMIN_URL. The
 * report is written to OPSLOG_LOAD_OUT (default: printed). Budgets are asserted only with OPSLOG_PERF=1,
 * and after the report exists, so a miss is a recorded finding and not a lost run.
 *
 * Knobs: OPSLOG_LOAD_THINK_MS (scenario file default), OPSLOG_LOAD_DURATION (s, 60), OPSLOG_LOAD_BASELINE (s, 20), OPSLOG_LOAD_VEHICLES (500),
 * OPSLOG_LOAD_EMPLOYEES (1000), OPSLOG_LOAD_ENTITIES (100000), OPSLOG_LOAD_DRIVER (auto|k6|node).
 */
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const enabled = process.env.OPSLOG_LOAD === '1' && Boolean(adminUrl);
const suite = enabled ? describe : describe.skip;
const PERF = process.env.OPSLOG_PERF === '1';
const number = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

suite('load run on MySQL', () => {
  it('measures p95 per scenario with 50 virtual users', async () => {
    const driver = (process.env.OPSLOG_LOAD_DRIVER ?? 'auto') as 'auto' | 'k6' | 'node';
    const result = await runLoad(
      {
        backend: 'mysql',
        adminUrl,
        size: {
          vehicles: number('OPSLOG_LOAD_VEHICLES', 500),
          employees: number('OPSLOG_LOAD_EMPLOYEES', 1000),
          searchEntities: number('OPSLOG_LOAD_ENTITIES', 100_000),
        },
        vus: 50,
        durationSeconds: number('OPSLOG_LOAD_DURATION', 60),
        ...(process.env.OPSLOG_LOAD_THINK_MS
          ? { thinkMs: number('OPSLOG_LOAD_THINK_MS', 1000) }
          : {}),
        baselineSeconds: number('OPSLOG_LOAD_BASELINE', 20),
        driver,
      },
      process.env.OPSLOG_LOAD_OUT,
    );
    process.stdout.write(`${result.markdown}\n`);
    process.stdout.write(`server errors: ${JSON.stringify(result.serverErrors)}\n`);
    if (process.env.OPSLOG_LOAD_JSON)
      writeFileSync(
        process.env.OPSLOG_LOAD_JSON,
        JSON.stringify(
          { summary: result.summary, baseline: result.baseline, rows: result.rows },
          null,
          2,
        ),
      );
    for (const row of result.rows) {
      expect(row.verdict, `${row.id} has data`).not.toBe('no_data');
    }
    if (PERF)
      for (const row of result.rows) {
        expect(row.failedRate, `${row.id} errors`).toBeLessThanOrEqual(0.01);
        expect(row.p95Ms, row.id).toBeLessThanOrEqual(row.budgetMs);
      }
  }, 7_200_000);
});
