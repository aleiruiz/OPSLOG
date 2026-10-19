import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import type { ReportsApiResponse } from '../../../apps/api/exports/src/index.js';
import { operationalSources } from '../../../apps/api/composition/src/platform/report-ops-sources.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const ok = <T>(result: PlatformResponse<T> | ReportsApiResponse<T> | { ok: boolean }): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return (result as unknown as { value: T }).value;
};
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');
const KEY = (() => {
  let n = 0;
  return () => `rep-ops-key-${(n += 1)}-${Date.now()}`;
})();

interface Company {
  readonly admin: Session;
  readonly viewer: Session;
  readonly vehicleId: string;
  readonly folio: string;
  readonly incidentId: string;
  readonly orderId: string;
}

/** A company with one vehicle, one repair order (500,00 MXN), one reported case that links it and 200,00 of its own. */
async function company(w: World, name: string, tag: string): Promise<Company> {
  const { admin } = await w.tenant(name, `subject-admin-${tag}`);
  const viewer = await w.member(admin, 'viewer', `subject-viewer-${tag}`);
  const areaId = ok(
    await w.platform.areas.create(admin.token, corr(), { name: `Flota ${tag}` }),
  ).id;
  const vehicleId = ok(
    await w.platform.vehicles.create(admin.token, corr(), {
      economicNumber: `ECO-${tag}`,
      plate: `PLA-${tag}`,
      vin: null,
      make: 'Kenworth',
      model: 'T680',
      year: 2022,
      areaId,
      odometerKm: 100,
    }),
  ).id;
  const order = ok(
    await w.platform.workOrders.createCorrective(admin.token, corr(), {
      vehicleId,
      description: `Frenos ${tag}`,
    }),
  );
  const workshop = ok(
    await w.platform.maintenance.createWorkshop(admin.token, corr(), {
      name: `Taller ${tag}`,
      specialties: ['frenos'],
      contact: '555-0100',
    }),
  );
  const assigned0 = ok(
    await w.platform.workOrders.transition(admin.token, corr(), 'assign', order.id, {
      version: order.version,
      responsibleId: admin.identityId,
      scheduledDate: '2026-10-06',
      workshopId: workshop.id,
    }),
  );
  const started = ok(
    await w.platform.workOrders.transition(admin.token, corr(), 'start', order.id, {
      version: assigned0.version,
    }),
  );
  const worked = ok(
    await w.platform.workOrders.command(admin.token, corr(), 'updateWork', order.id, {
      version: started.version,
      tasks: [{ description: 'Diagnóstico' }],
    }),
  );
  const costed = ok(
    await w.platform.workOrders.command(admin.token, corr(), 'updateCosts', order.id, {
      version: worked.version,
      costs: [{ category: 'labor', amount: { amountMinor: '50000', currency: 'MXN' } }],
    }),
  );
  ok(
    await w.platform.workOrders.transition(admin.token, corr(), 'complete', order.id, {
      version: costed.version,
      actualDate: '2026-10-06',
      actualKm: 120,
    }),
  );
  const draft = ok(
    await w.platform.incidents.create(admin.token, corr(), {
      vehicleId,
      type: 'collision',
      severity: 'medium',
      occurredAt: new Date().toISOString(),
      location: { text: 'Calle Sintética' },
      description: 'Descripción sintética',
      vehicleOperable: true,
      noDriverReason: 'Vehículo estacionado',
      noPhotoJustification: 'Sin foto disponible',
    }),
  );
  const reported = ok(
    await w.platform.incidentWorkflow.transition(
      admin.token,
      corr(),
      draft.id,
      { command: 'report', version: draft.version },
      KEY(),
    ),
  );
  const assigned = ok(
    await w.platform.incidentWorkflow.transition(
      admin.token,
      corr(),
      draft.id,
      { command: 'assign', version: reported.version, responsibleId: admin.identityId },
      KEY(),
    ),
  );
  const review = ok(
    await w.platform.incidentWorkflow.transition(
      admin.token,
      corr(),
      draft.id,
      { command: 'review', version: assigned.version },
      KEY(),
    ),
  );
  const linked = ok(
    await w.platform.incidentRepairs.link(
      admin.token,
      corr(),
      draft.id,
      { version: review.version, orderId: order.id },
      KEY(),
    ),
  );
  ok(
    await w.platform.incidentCosts.update(
      admin.token,
      corr(),
      draft.id,
      {
        version: linked.version,
        lines: [
          {
            kind: 'expense',
            category: 'towing',
            amount: { amountMinor: '20000', currency: 'MXN' },
          },
        ],
      },
      KEY(),
    ),
  );
  return {
    admin,
    viewer,
    vehicleId,
    folio: reported.folio,
    incidentId: draft.id,
    orderId: order.id,
  };
}

const preview = async (s: Session, reportId: string, query: Record<string, unknown> = {}) =>
  world.platform.reports.reports.preview(s.token, corr(), reportId, query as never);
const exported = async (
  s: Session,
  reportId: string,
  format: 'csv' | 'xlsx' | 'pdf',
  filters?: Record<string, string>,
) => {
  const made = ok(
    await world.platform.reports.exports.create(s.token, corr(), {
      reportId,
      format,
      ...(filters ? { filters } : {}),
    } as never),
  );
  return ok(await world.platform.reports.exports.download(s.token, corr(), made.job.id));
};

const ALL_REPORTS = [
  'drivers',
  'dispatchers',
  'areas',
  'people_compliance',
  'vehicle_inventory',
  'fleet_status',
  'insurance',
  'vehicle_documents',
  'vehicle_history',
  'maintenance_plan_vs_actual',
  'maintenance_corrective',
  'maintenance_costs',
  'maintenance_frequency',
  'incidents_by_period',
  'incidents_by_subject',
  'incidents_distribution',
  'incident_costs',
  'incident_resolution',
  'incident_aging',
  'expirations',
  'audit_log',
  'vehicle_sheet',
  'driver_sheet',
  'incident_sheet',
] as const;

describe('the operational reports through the platform', () => {
  it('lists the 24 reports for the administrator and hides the cost and audit ones from a viewer', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const catalog = ok(await world.platform.reports.reports.catalog(a.admin.token, corr()));
    expect(catalog.reports.map((r) => r.id).sort()).toEqual([...ALL_REPORTS].sort());
    expect(catalog.reports.find((r) => r.id === 'vehicle_sheet')).toMatchObject({
      formats: ['pdf'],
      filters: [expect.objectContaining({ id: 'vehicle', required: true })],
    });
    const seen = ok(await world.platform.reports.reports.catalog(a.viewer.token, corr()));
    const ids = seen.reports.map((r) => r.id);
    expect(ids).toContain('incidents_by_period');
    for (const hidden of ['maintenance_costs', 'incident_costs', 'audit_log'])
      expect(ids).not.toContain(hidden);
  });

  it('counts the repair order once in the case and in maintenance (acceptance 7), per currency', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const b = await company(world, 'Empresa Beta', 'b');
    const costs = ok(await preview(a.admin, 'incident_costs'));
    const row = Object.fromEntries(costs.columns.map((c, i) => [c.id, costs.rows[0]?.[i]]));
    expect(costs.total).toBe(1);
    expect(row).toMatchObject({ folio: a.folio, currency: 'MXN', repairs: 500, companyBorne: 700 });
    const maintenance = ok(await preview(a.admin, 'maintenance_costs'));
    expect(maintenance.rows).toHaveLength(1);
    expect(maintenance.rows[0]).toContain(500);
    // The other company sees only its own figures.
    const other = ok(await preview(b.admin, 'incident_costs'));
    expect(JSON.stringify(other.rows)).not.toContain('ECO-a');
    expect(JSON.stringify(other.rows)).toContain('ECO-b');
  });

  it('exports every operational report of the own company only', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    await company(world, 'Empresa Beta', 'b');
    const csvReports = ALL_REPORTS.filter((id) => !id.endsWith('_sheet'));
    for (const id of csvReports) {
      const file = await exported(
        a.admin,
        id,
        'csv',
        id === 'vehicle_history' ? { vehicle: 'ECO-a' } : undefined,
      );
      const csv = text(file.bytes);
      expect(csv, id).not.toContain('ECO-b');
      expect(csv, id).not.toContain('Frenos b');
    }
    expect(text((await exported(a.admin, 'incident_aging', 'csv')).bytes)).toContain(
      'SIN-2026-000001',
    );
    expect(text((await exported(a.admin, 'maintenance_corrective', 'csv')).bytes)).toContain(
      'Frenos a',
    );
    for (const [id, filters] of [
      ['vehicle_sheet', { vehicle: 'ECO-a' }],
      ['incident_sheet', { folio: a.folio }],
    ] as const) {
      const file = await exported(a.admin, id, 'pdf', filters);
      expect(Buffer.from(file.bytes).subarray(0, 5).toString('latin1'), id).toBe('%PDF-');
    }
    expect(
      Buffer.from((await exported(a.admin, 'incident_costs', 'xlsx')).bytes)
        .subarray(0, 2)
        .toString('latin1'),
    ).toBe('PK');
  });

  it('refuses a sheet without its record and does not find a record of another company', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    await company(world, 'Empresa Beta', 'b');
    expect(await preview(a.admin, 'vehicle_sheet')).toMatchObject({
      ok: false,
      error: { status: 400, field: 'vehicle' },
    });
    const foreign = ok(await preview(a.admin, 'vehicle_sheet', { filters: { vehicle: 'ECO-b' } }));
    expect(foreign.total).toBe(0);
  });

  it('keeps money out of the reader without the permission and reads the audit trail masked', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    expect(await preview(a.viewer, 'incident_costs')).toMatchObject({ ok: false });
    expect(await preview(a.viewer, 'audit_log')).toMatchObject({ ok: false });
    const audit = ok(await preview(a.admin, 'audit_log', { limit: 100 }));
    expect(audit.total).toBeGreaterThan(0);
    const range = await preview(a.admin, 'audit_log', {
      filters: { from: '2020-01-01', to: '2026-12-31' },
    });
    expect(range).toMatchObject({ ok: false });
  });

  it('answers the pages of one preview with the same total', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const first = ok(await preview(a.admin, 'incidents_by_period', { limit: 25 }));
    const second = ok(await preview(a.admin, 'incidents_by_period', { limit: 25, offset: 0 }));
    expect(second).toEqual(first);
  });

  it('shows no case folio to a reader without incidents:view (ADR-0014)', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const auditor = await world.member(a.admin, 'auditor', 'subject-auditor-a');
    const history = ok(
      await preview(auditor, 'vehicle_history', { filters: { vehicle: 'ECO-a' } }),
    );
    expect(history.total).toBeGreaterThan(0);
    expect(JSON.stringify(history.rows)).not.toContain(a.folio);
    const withCases = ok(
      await preview(a.admin, 'vehicle_history', { filters: { vehicle: 'ECO-a' } }),
    );
    expect(JSON.stringify(withCases.rows)).toContain(a.folio);
    const corrective = ok(await preview(auditor, 'maintenance_corrective'));
    expect(JSON.stringify(corrective.rows)).not.toContain(a.folio);
  });

  it('refuses to read more orders than a report may hold and pages by keyset', async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `o${i}`, createdAt: '2026-10-01T00:00:00.000Z' }));
    const calls: unknown[] = [];
    const store = {
      list: async () => [],
      reportPage: async (_t: string, after: unknown) => {
        calls.push(after);
        return page(100);
      },
    };
    const sources = operationalSources({
      orders: store,
      plans: {},
      workshops: { list: async () => [] },
    } as never);
    const reader = {
      tenantId: 'A',
      permissions: new Set(['view', 'edit']),
      actorId: 'u1',
    } as never;
    await expect(sources.workOrders(reader, { withCosts: false })).rejects.toMatchObject({
      code: 'too_many_rows',
    });
    expect(calls[0]).toBeNull();
    expect(calls[1]).toEqual({ createdAt: '2026-10-01T00:00:00.000Z', id: 'o99' });
  });
});
