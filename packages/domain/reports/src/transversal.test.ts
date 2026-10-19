import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);
const AUDITOR = ['view', 'view_audit'] as const;

describe('report expirations', () => {
  it('joins documents, policies, licenses and plans in one list ordered by date', async () => {
    const { rows } = await runReport('expirations', READER);
    expect(rows.map((r) => [r['category'], r['subject'], r['dueOn'], r['daysLeft']])).toEqual(
      [
        ['Documento de persona', 'Beto Álvarez', '2026-08-01', -79],
        ['Documento de persona', 'Beto Álvarez', '2026-09-30', -19],
        ['Documento de vehículo', 'ECO-2 (PLA-200)', '2026-10-01', -18],
        ['Plan de mantenimiento', 'ECO-1 (PLA-100)', '2026-10-01', -18],
        ['Póliza', 'ECO-2 (PLA-200)', '2026-10-18', -1],
        ['Documento de persona', 'Ana Zúñiga', '2026-10-19', 0],
        ['Documento de vehículo', 'ECO-1 (PLA-100)', '2026-10-25', 6],
        ['Licencia', 'Ana Zúñiga', '2026-11-01', 13],
        ['Póliza', 'ECO-1 (PLA-100)', '2026-11-30', 42],
        ['Plan de mantenimiento', 'ECO-2 (PLA-200)', '2026-11-20', 32],
        ['Licencia', 'Beto Álvarez', '2027-02-01', 105],
        ['Póliza', 'ECO-1 (PLA-100)', '2027-03-01', 133],
        ['Documento de vehículo', 'ECO-1 (PLA-100)', '2027-06-01', 225],
        ['Documento de persona', 'Elena Ruiz', '2027-12-31', 438],
      ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    );
    expect(rows[0]).toMatchObject({ item: 'Curso de manejo', range: 'Vencido', area: 'Sur' });
    expect(rows.find((r) => r['dueOn'] === '2026-10-19')).toMatchObject({ range: 'Hasta 7 días' });
    expect(rows.find((r) => r['dueOn'] === '2026-11-20')).toMatchObject({ range: 'Hasta 60 días' });
    expect(rows.at(-1)).toMatchObject({ range: 'Más de 90 días' });
    // A terminated driver has no license to renew, a paused plan no service due, an ownerless document no row.
    expect(col(rows, 'subject')).not.toContain('Carla Núñez');
    expect(rows.some((r) => r['dueOn'] === '2026-12-01')).toBe(false);
    expect(rows).toHaveLength(14);
  });

  it('filters by the 7/15/30/60/90-day windows, expired items, category and area', async () => {
    const dates = async (filters: Record<string, string>) =>
      col((await runReport('expirations', READER, { filters })).rows, 'dueOn');
    expect(await dates({ window: '7' })).toEqual(['2026-10-19', '2026-10-25']);
    expect(await dates({ window: '15' })).toEqual(['2026-10-19', '2026-10-25', '2026-11-01']);
    expect(await dates({ window: '30' })).toEqual(['2026-10-19', '2026-10-25', '2026-11-01']);
    expect(await dates({ window: '60' })).toHaveLength(5);
    expect(await dates({ window: '90' })).toHaveLength(5);
    expect(await dates({ window: 'overdue' })).toHaveLength(5);
    expect(await dates({ category: 'license' })).toEqual(['2026-11-01', '2027-02-01']);
    expect(await dates({ areaId: 'a2', category: 'personDocument' })).toEqual([
      '2026-08-01',
      '2026-09-30',
      '2027-12-31',
    ]);
  });

  it('does not leak the other company', async () => {
    expect((await runReport('expirations', ALL, {}, 'B')).rows).toEqual([]);
  });
});

describe('report audit_log', () => {
  it('is only for a reader of the audit', async () => {
    await expect(runReport('audit_log', READER)).rejects.toThrow(ReportError);
  });

  it('lists the last 30 days by default, in the zone of the company, newest first', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const { rows } = await runReport('audit_log', AUDITOR, {}, 'A', sources);
    // 2026-09-19 00:00 in Mexico City is 06:00Z; the August entry is outside the window.
    expect(sources.auditReads[0]).toEqual({
      from: '2026-09-19T06:00:00.000Z',
      to: '2026-10-20T06:00:00.000Z',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      occurredAt: '2026-10-18 14:30',
      action: 'Vehículo actualizado',
      result: 'Correcto',
      entityType: 'Vehículo',
      entity: 'ECO-1',
      actor: 'Administración',
      alias: 'Actor-1a2b',
    });
    expect(rows[1]).toMatchObject({ result: 'Denegado', occurredAt: '2026-10-17 09:00' });
  });

  it('shows the masked changes only when they are selected and honors range, type and result', async () => {
    const sources = new MemorySources({ A: companyA() });
    const withChanges = await runReport(
      'audit_log',
      AUDITOR,
      { columns: ['occurredAt', 'changes'], filters: { entityType: 'vehicle' } },
      'A',
      sources,
    );
    expect(withChanges.rows).toEqual([
      { occurredAt: '2026-10-18 14:30', changes: 'Estado: Activo → En mantenimiento' },
    ]);
    const august = await runReport(
      'audit_log',
      AUDITOR,
      { filters: { from: '2026-08-01', to: '2026-08-31' } },
      'A',
      sources,
    );
    expect(col(august.rows, 'entity')).toEqual(['Norte']);
    expect(sources.auditReads.at(-1)).toEqual({
      from: '2026-08-01T06:00:00.000Z',
      to: '2026-09-01T06:00:00.000Z',
    });
    const denied = await runReport(
      'audit_log',
      AUDITOR,
      { filters: { result: 'denied' } },
      'A',
      sources,
    );
    expect(col(denied.rows, 'result')).toEqual(['Denegado']);
  });

  it('refuses a range longer than 366 days or one that ends before it starts', async () => {
    const run = (filters: Record<string, string>) => runReport('audit_log', AUDITOR, { filters });
    await expect(run({ from: '2025-01-01', to: '2026-10-01' })).rejects.toThrow(ReportError);
    await expect(run({ from: '2026-10-05', to: '2026-10-01' })).rejects.toThrow(ReportError);
    await expect(run({ from: '2025-10-19', to: '2026-10-19' })).resolves.toBeDefined();
    await expect(run({ to: '2026-10-19' })).resolves.toBeDefined();
  });
});
