import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);
const FLEET = [...READER, 'incidents:view'] as const;

describe('report vehicle_history', () => {
  it('needs the vehicle: a history without one is a bad request', async () => {
    await expect(runReport('vehicle_history', READER)).rejects.toThrow(ReportError);
  });

  it('composes the timeline of a vehicle from every module, oldest first', async () => {
    const { rows } = await runReport('vehicle_history', FLEET, { filters: { vehicle: 'eco-1' } });
    const events = rows.map((r) => `${r['date']} ${r['source']}: ${r['event']}`);
    expect(events).toEqual([
      '2024-01-15 Vehículo: Alta en la flota',
      '2024-01-15 Estado: Cambio de estado',
      '2024-06-01 Asignación: Asignación',
      '2024-12-31 Asignación: Fin de asignación',
      '2025-01-01 Documento: Documento emitido',
      '2025-01-10 Asignación: Asignación',
      '2026-01-01 Póliza: Inicio de póliza',
      '2026-01-01 Póliza: Inicio de póliza',
      '2026-09-05 Mantenimiento: Orden preventivo',
      '2026-09-08 Siniestro: Siniestro SIN-2026-0001',
      '2026-09-12 Mantenimiento: Orden correctivo',
      '2026-10-01 Mantenimiento: Orden preventivo',
      '2026-10-09 Estado: Cambio de estado',
      '2026-10-10 Siniestro: Siniestro SIN-2026-0003',
      '2026-10-15 Mantenimiento: Orden correctivo',
      '2026-10-25 Documento: Vencimiento de documento',
      '2026-11-30 Póliza: Fin de póliza',
      '2027-03-01 Póliza: Fin de póliza',
      '2027-06-01 Documento: Vencimiento de documento',
    ]);
    expect(rows).toHaveLength(events.length);
    expect(col(rows, 'detail')).toContain('Principal: Ana Zúñiga');
    expect(col(rows, 'detail')).toContain('Secundaria: Beto Álvarez');
    expect(rows.find((r) => r['event'] === 'Fin de asignación')?.['date']).toBe('2024-12-31');
  });

  it('matches the plates as well and gives nothing for an unknown or foreign vehicle', async () => {
    expect(
      (await runReport('vehicle_history', FLEET, { filters: { vehicle: 'PLA-200' } })).rows.length,
    ).toBeGreaterThan(3);
    expect(
      (await runReport('vehicle_history', FLEET, { filters: { vehicle: 'nope' } })).rows,
    ).toEqual([]);
    expect(
      (await runReport('vehicle_history', FLEET, { filters: { vehicle: 'ECO-1' } }, 'B')).rows,
    ).toEqual([]);
  });

  it('carries no cost without the permission and no personal data beyond names', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const plain = await runReport(
      'vehicle_history',
      FLEET,
      { filters: { vehicle: 'ECO-1' } },
      'A',
      sources,
    );
    expect(plain.columns.map((c) => c.id)).toEqual(['date', 'source', 'event', 'detail']);
    expect(JSON.stringify(plain.rows)).not.toMatch(/MXN|USD|LIC-/);
    expect(sources.costReads.every((read) => !read.permitted)).toBe(true);
    const costs = await runReport(
      'vehicle_history',
      ALL,
      { filters: { vehicle: 'ECO-1' } },
      'A',
      sources,
    );
    expect(costs.columns.map((c) => c.id)).toContain('maintenanceCost');
    expect(costs.rows.find((r) => r['date'] === '2026-09-12')?.['maintenanceCost']).toBe(
      'MXN 3000.00; USD 1000.00',
    );
    expect(costs.rows.find((r) => r['event'] === 'Siniestro SIN-2026-0001')?.['incidentCost']).toBe(
      'MXN 16500.00; USD 1000.00',
    );
    expect(JSON.stringify(costs.rows)).not.toContain('LIC-');
  });

  it('shows the orders and cases only to a reader that is not mechanic-scoped', async () => {
    const sources = new MemorySources({ A: companyA() });
    sources.scopedActors.add('actor-1');
    const { rows } = await runReport(
      'vehicle_history',
      ALL,
      { filters: { vehicle: 'ECO-1' } },
      'A',
      sources,
    );
    expect(new Set(col(rows, 'source'))).not.toContain('Mantenimiento');
    expect(new Set(col(rows, 'source'))).not.toContain('Siniestro');
  });
});
