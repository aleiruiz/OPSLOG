import { describe, expect, it } from 'vitest';
import { loadScenarios, type LoadSummary } from './config.js';
import { machineInfo, metricRows, renderReport } from './report.js';

const file = loadScenarios();
const stat = (p95Ms: number, failedRate = 0) => ({
  count: 100,
  avgMs: p95Ms / 2,
  p95Ms,
  maxMs: p95Ms * 2,
  failedRate,
});
const summary = (over: Record<string, number> = {}, vus = 50): LoadSummary => ({
  driver: 'k6',
  k6Image: file.k6Image,
  vus,
  durationSeconds: 60,
  scenarios: Object.fromEntries(
    file.scenarios.map((s) => [s.id, stat(over[s.id] ?? s.budgetMs / 2)]),
  ),
});
const size = { vehicles: 500, employees: 1000, searchEntities: 100_000 };

describe('load report', () => {
  it('judges each metric against its budget and flags errors and missing data', () => {
    const rows = metricRows(
      {
        ...summary({ dashboard: 1500 }),
        scenarios: {
          ...summary({ dashboard: 1500 }).scenarios,
          list_vehicles: stat(100, 0.2),
          search_prefix: { ...stat(0), count: 0 },
        },
      },
      file,
    );
    const verdict = Object.fromEntries(rows.map((r) => [r.id, r.verdict]));
    expect(verdict).toMatchObject({
      dashboard: 'over',
      list_vehicles: 'failed',
      search_prefix: 'no_data',
      write_vehicle: 'within',
    });
  });

  it('renders p95 per metric, the machine and the caveats, never claiming production validation', () => {
    const text = renderReport({
      summary: summary(),
      baseline: summary({}, 1),
      file,
      machine: machineInfo(),
      size,
      backend: 'mysql',
      mysqlVersion: '8.0.46',
      commit: 'abc1234',
      date: '2026-10-19',
    });
    expect(text).toContain('MySQL 8.0.46');
    expect(text).toContain('k6 (grafana/k6:');
    expect(text).toContain('NFR-P5: la mayor degradación');
    expect(text).toContain('No es una validación de producción');
    expect(text).toContain('NFR-P3');
    for (const scenario of file.scenarios) expect(text).toContain(scenario.label);
    expect(text).not.toMatch(/validado en producción|cumple en producción/);
  });

  it('names the Node driver when k6 was not available, and says when the reference was not measured', () => {
    const text = renderReport({
      summary: { ...summary(), driver: 'node-fetch' },
      file,
      machine: machineInfo(),
      size,
      backend: 'memory',
      commit: 'x',
      date: '2026-10-19',
    });
    expect(text).toContain('controlador Node');
    expect(text).toContain('no se midió la referencia de un usuario');
  });
});
