import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { K6_DIR, loadScenarios } from './config.js';
import { runNodeDriver } from './driver.js';
import { renderReport, machineInfo } from './report.js';
import { expand, expandBody, percentile } from './scenario-lib.js';
import { startLoadStack, type LoadStack } from './stack.js';

/**
 * Offline check of the load scenarios (no timing): the stack runs in memory with a few records, the
 * Node driver plays every scenario of `scenarios.json` as virtual users, and each answer must be the
 * expected status. This keeps the paths, bodies, cookies and CSRF handling of the k6 script honest in
 * the ordinary test run. The measured run is `pnpm ops:load`.
 */
describe('load scenarios', () => {
  const file = loadScenarios();
  let stack: LoadStack;

  beforeAll(async () => {
    stack = await startLoadStack({
      backend: 'memory',
      size: { vehicles: 12, employees: 10, searchEntities: 300 },
      sessions: 3,
    });
  }, 120_000);
  afterAll(async () => stack?.close());

  it('declares unique scenarios with budgets from SPECS §9.3', () => {
    expect(new Set(file.scenarios.map((s) => s.id)).size).toBe(file.scenarios.length);
    const budgets = Object.fromEntries(file.scenarios.map((s) => [s.id, s.budgetMs]));
    expect(budgets).toMatchObject({
      list_vehicles: 500,
      detail_vehicle: 500,
      list_employees: 500,
      write_vehicle: 800,
      dashboard: 1000,
      search_prefix: 700,
      search_contains: 700,
      export_small: 10_000,
    });
    expect(file.vus).toBe(50);
    expect(file.k6Image).toMatch(/^grafana\/k6:\d+\.\d+\.\d+$/);
  });

  it('serves every scenario to several virtual users with the expected status', async () => {
    const summary = await runNodeDriver({
      baseUrl: stack.baseUrl,
      fixture: stack.fixture,
      file,
      vus: 3,
      durationMs: 60_000,
      maxIterations: 3,
      thinkMs: 0,
    });
    for (const scenario of file.scenarios) {
      const stats = summary.scenarios[scenario.id];
      expect(stats?.count, scenario.id).toBe(9);
      expect(stats?.failedRate, scenario.id).toBe(0);
    }
    const report = renderReport({
      summary,
      file,
      machine: machineInfo(),
      size: stack.size,
      backend: 'memory',
      commit: 'test',
      date: '2026-10-19',
    });
    expect(report).toContain('Alta de vehículo');
    expect(report).toContain('No es una validación de producción');
  }, 120_000);

  it('a session cookie of another company or a forged CSRF token is refused', async () => {
    const session = stack.fixture.sessions[0] as { cookie: string; csrf: string };
    const write = (headers: Record<string, string>) =>
      fetch(`${stack.baseUrl}/api/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: stack.fixture.origin, ...headers },
        body: '{}',
      });
    expect((await write({ Cookie: session.cookie, 'X-CSRF-Token': 'forged' })).status).toBe(403);
    expect(
      (
        await write({
          Cookie: 'opslog_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          'X-CSRF-Token': session.csrf,
        })
      ).status,
    ).toBe(401);
  });

  it('parses the k6 script and expands its placeholders', () => {
    const parsed = spawnSync(process.execPath, ['--check', join(K6_DIR, 'scenarios.js')]);
    expect(parsed.status, parsed.stderr.toString()).toBe(0);
    const fixture = stack.fixture;
    for (const scenario of file.scenarios) {
      expect(expand(scenario.path, fixture, 7, 3)).not.toMatch(/[{}]/);
      expect(expandBody(scenario.body, fixture, 7, 3) ?? '').not.toMatch(/\{\w+\}/);
    }
    // Unique per user and iteration, so concurrent writes never collide.
    const a = expandBody(file.scenarios.find((s) => s.id === 'write_vehicle')?.body, fixture, 1, 1);
    const b = expandBody(file.scenarios.find((s) => s.id === 'write_vehicle')?.body, fixture, 2, 1);
    expect(a).not.toBe(b);
    expect(() => expand('{nope}', fixture, 1, 1)).toThrow('unknown placeholder');
  });

  it('computes a nearest-rank percentile', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([5], 0.95)).toBe(5);
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
  });
});
