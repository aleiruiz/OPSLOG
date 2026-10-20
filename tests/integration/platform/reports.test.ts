import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import type { ReportsApiResponse } from '../../../apps/api/exports/src/index.js';
import { InMemoryVehicleStore } from '../../../packages/domain/vehicles/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const ok = <T>(result: PlatformResponse<T> | ReportsApiResponse<T>): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return (result as { value: T }).value;
};
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

interface Company {
  readonly tenantId: string;
  readonly admin: Session;
  readonly admin2: Session;
  readonly viewer: Session;
  readonly areaId: string;
  readonly vehicleId: string;
}

async function company(w: World, name: string, tag: string): Promise<Company> {
  const handle = await w.tenant(name, `subject-admin-${tag}`);
  const admin = handle.admin;
  const admin2 = await w.member(admin, 'admin', `subject-admin2-${tag}`);
  const viewer = await w.member(admin, 'viewer', `subject-viewer-${tag}`);
  const areaId = ok(await w.platform.areas.create(admin.token, corr(), { name: 'Flota' })).id;
  const vehicleId = ok(
    await w.platform.vehicles.create(admin.token, corr(), {
      economicNumber: `ECO-${tag}`,
      plate: `PLA-${tag}`,
      vin: null,
      make: 'Toyota',
      model: '=Hilux',
      year: 2022,
      areaId,
      odometerKm: 10,
    }),
  ).id;
  const driverId = ok(
    await w.platform.employees.create(admin.token, corr(), {
      kind: 'driver',
      firstName: 'Ana',
      lastName: `Pérez ${tag}`,
      areaId,
      employeeNumber: `EMP-${tag}`,
      idType: 'ine',
      nationalId: `INE-0000-${tag}`,
      licenseType: 'c',
      licenseNumber: `LIC-SECRET-${tag}`,
      licenseExpiresOn: '2027-10-05',
    }),
  ).id;
  ok(
    await w.platform.employees.create(admin.token, corr(), {
      kind: 'dispatcher',
      firstName: 'Luis',
      lastName: `Mora ${tag}`,
      areaId,
      employeeNumber: `DIS-${tag}`,
      phone: '+52 55 1234 5678',
    }),
  );
  ok(
    await w.platform.assignments.create(admin.token, corr(), {
      vehicleId,
      employeeId: driverId,
      type: 'principal',
      reason: 'Alta de unidad',
    }),
  );
  ok(
    await w.platform.documents.create(admin.token, corr(), {
      ownerType: 'vehicle',
      ownerId: vehicleId,
      typeCode: 'registration_card',
      title: 'Tarjeta',
      expiresOn: '2026-11-01',
    }),
  );
  ok(
    await w.platform.documents.create(admin.token, corr(), {
      ownerType: 'employee',
      ownerId: driverId,
      typeCode: 'medical_exam',
      title: 'Examen',
      expiresOn: '2026-12-01',
    }),
  );
  ok(
    await w.platform.insurance.create(admin.token, corr(), {
      vehicleId,
      insurer: 'Aseguradora Ficticia',
      policyNumber: `POL-${tag}`,
      coverageType: 'third_party',
      startsOn: '2026-01-01',
      endsOn: '2027-01-01',
      deductible: { kind: 'amount', amountMinor: 1_500_000, currency: 'MXN' },
    }),
  );
  return { tenantId: handle.tenantId, admin, admin2, viewer, areaId, vehicleId };
}

const exportOf = (s: Session, reportId: string, input: Record<string, unknown>, key?: string) =>
  world.platform.reports.exports.create(s.token, corr(), {
    reportId,
    format: 'csv',
    ...input,
    ...(key ? { idempotencyKey: key } : {}),
  } as never);

const download = async (s: Session, id: string) =>
  ok(await world.platform.reports.exports.download(s.token, corr(), id));

const job = (name: string) => {
  const found = world.platform.runtime.jobs.list().find((j) => j.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};

describe('the eight reports through the platform', () => {
  it('exports every report of the catalog with Spanish headers and the rows of the own company', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const b = await company(world, 'Empresa Beta', 'b');
    const expectations: Record<string, string> = {
      drivers: 'Pérez a',
      dispatchers: 'Mora a',
      areas: 'Flota',
      people_compliance: 'Pérez a',
      vehicle_inventory: 'ECO-a',
      fleet_status: 'ECO-a',
      insurance: 'POL-A',
      vehicle_documents: 'ECO-a',
    };
    const catalog = ok(await world.platform.reports.reports.catalog(a.admin.token, corr()));
    expect(catalog.reports.map((r) => r.id).sort()).toEqual(Object.keys(expectations).sort());
    for (const [reportId, expected] of Object.entries(expectations)) {
      for (const format of ['csv', 'xlsx'] as const) {
        const made = ok(await exportOf(a.admin, reportId, { format }));
        expect(made.job, reportId).toMatchObject({ status: 'completed', mode: 'direct' });
        const file = await download(a.admin, made.job.id);
        if (format === 'csv') {
          const csv = text(file.bytes);
          expect(csv, reportId).toContain(expected);
          expect(csv, reportId).not.toContain('Pérez b');
          expect(csv, reportId).not.toContain('ECO-b');
          expect(csv.startsWith('﻿')).toBe(true);
        } else expect(Buffer.from(file.bytes).subarray(0, 2).toString('latin1')).toBe('PK');
      }
    }
    for (const reportId of ['people_compliance', 'vehicle_documents']) {
      const made = ok(await exportOf(a.admin, reportId, { format: 'pdf' }));
      const file = await download(a.admin, made.job.id);
      expect(Buffer.from(file.bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    }
    expect(b.tenantId).not.toBe(a.tenantId);
  });

  it('neutralizes formulas and puts money and personal data only where the reader holds the permission', async () => {
    world = createWorld();
    const a = await company(world, 'Empresa Alfa', 'a');
    const inventory = ok(
      await exportOf(a.admin, 'vehicle_inventory', { columns: ['economicNumber', 'model'] }),
    );
    expect(text((await download(a.admin, inventory.job.id)).bytes)).toContain("'=Hilux");
    const drivers = ok(
      await exportOf(a.admin, 'drivers', { columns: ['name', 'licenseNumber'], sort: 'name' }),
    );
    expect(text((await download(a.admin, drivers.job.id)).bytes)).toContain('LIC-SECRET-A');
    const insurance = ok(
      await exportOf(a.admin, 'insurance', { columns: ['policyNumber', 'deductible'] }),
    );
    expect(text((await download(a.admin, insurance.job.id)).bytes)).toContain('15000');
    // A reader without `export` cannot ask; one without the sensitive permissions sees no column.
    expect(await exportOf(a.viewer, 'drivers', {})).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const preview = ok(
      await world.platform.reports.reports.preview(a.viewer.token, corr(), 'drivers', {
        columns: ['name', 'licenseNumber'],
      }),
    );
    expect(preview.columns.map((c) => c.id)).toEqual(['name']);
    expect(JSON.stringify(preview)).not.toContain('LIC-SECRET');
    const costs = ok(
      await world.platform.reports.reports.preview(a.viewer.token, corr(), 'insurance', {
        columns: ['policyNumber', 'deductible'],
      }),
    );
    expect(costs.columns.map((c) => c.id)).toEqual(['policyNumber']);
  });
});

const BIG = 5_001;
const DIRECT = 5_000;

/** A company whose vehicles are inserted straight into the store: 5.001 rows cross the direct limit. */
async function bigCompany(count = BIG) {
  const vehicles = new InMemoryVehicleStore();
  world = createWorld({ adapters: { vehicles } });
  const a = await company(world, 'Empresa Grande', 'g');
  const now = new Date().toISOString();
  for (let i = 0; i < count; i += 1) {
    const id = `big-${i}`;
    await vehicles.insert(
      {
        id,
        tenantId: a.tenantId,
        economicNumber: `B-${String(i).padStart(5, '0')}`,
        plate: `BIG-${i}`,
        vin: null,
        make: 'Kenworth',
        model: 'T680',
        year: 2020,
        areaId: a.areaId,
        status: 'active',
        statusReason: 'Alta',
        odometerKm: i,
        odometerUpdatedAt: now,
        registeredOn: '2026-10-06',
        version: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      },
      {
        id: `h-${id}`,
        tenantId: a.tenantId,
        vehicleId: id,
        from: null,
        to: 'active',
        reason: 'Alta',
        actorId: 'user-seed',
        version: 1,
        at: now,
      },
    );
  }
  return a;
}

describe('jobs of the worker', () => {
  it('queues a report over 5.000 rows, produces it on the tick, stores it and publishes the event', async () => {
    const a = await bigCompany();
    const made = ok(await exportOf(a.admin, 'vehicle_inventory', {}, 'big-export-0001'));
    expect(made.job).toMatchObject({ mode: 'job', status: 'queued', rowCount: null });
    const again = ok(await exportOf(a.admin, 'vehicle_inventory', {}, 'big-export-0001'));
    expect(again).toMatchObject({ replayed: true, job: { id: made.job.id } });
    expect(
      await world.platform.reports.exports.download(a.admin.token, corr(), made.job.id),
    ).toMatchObject({
      ok: false,
      error: { status: 409 },
    });

    await job('exports.run').run();
    const done = ok(await world.platform.reports.exports.get(a.admin.token, corr(), made.job.id));
    expect(done).toMatchObject({ status: 'completed', rowCount: BIG + 1 });
    const objects = [
      ...(world.storage as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];
    expect(objects).toContain(`tenants/${a.tenantId}/exports/${made.job.id}`);
    const file = await download(a.admin, made.job.id);
    expect(text(file.bytes).split('\r\n').length).toBeGreaterThan(BIG);

    const events = (await world.outbox.all()).filter((e) => e.type.startsWith('export.'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'export.completed',
      tenantId: a.tenantId,
      payload: {
        jobId: made.job.id,
        reportId: 'vehicle_inventory',
        format: 'csv',
        rowCount: BIG + 1,
      },
    });
    // The consumer is registered: the event is acknowledged, not dead-lettered.
    await world.platform.runtime.drainOutbox();
    expect(
      (await world.outbox.all()).filter((e) => e.type.startsWith('export.'))[0]?.status,
    ).not.toBe('dead');
  }, 60_000);

  it('produces no data when the person lost the permission before the job started', async () => {
    const a = await bigCompany();
    const made = ok(await exportOf(a.admin2, 'vehicle_inventory', {}));
    expect(made.job.status).toBe('queued');
    ok(await world.platform.changeRole(a.admin.token, corr(), a.admin2.identityId, 'viewer'));
    await job('exports.run').run();
    const failed = (await world.platform.reports.exports.get(
      a.admin2.token,
      corr(),
      made.job.id,
    )) as {
      ok: boolean;
    };
    // The session ended with the role change: the job is failed whoever asks, and no file exists.
    expect(failed.ok).toBe(false);
    const objects = [
      ...(world.storage as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];
    expect(objects.some((k) => k.includes(made.job.id))).toBe(false);
    const events = (await world.outbox.all()).filter((e) => e.type.startsWith('export.'));
    expect(events.map((e) => e.type)).toEqual(['export.failed']);
    expect(JSON.stringify(events)).not.toContain('B-00001');
  }, 60_000);

  it('limits open jobs per person and removes expired files with the purge job', async () => {
    const a = await bigCompany();
    for (let i = 0; i < 3; i += 1) ok(await exportOf(a.admin, 'vehicle_inventory', {}));
    expect(await exportOf(a.admin, 'vehicle_inventory', {})).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', status: 429 },
    });
    await job('exports.run').run();
    await job('exports.run').run();
    const list = ok(await world.platform.reports.exports.list(a.admin.token, corr(), {}));
    expect(list.items.every((j) => j.status === 'completed')).toBe(true);
    const keys = () => [
      ...(world.storage as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];
    expect(keys().filter((k) => k.includes('/exports/'))).toHaveLength(3);
    world.advance(8 * 86_400_000);
    const login = await world.signIn('subject-admin-g', a.tenantId);
    expect(
      await world.platform.reports.exports.download(login.token, corr(), list.items[0]!.id),
    ).toMatchObject({
      ok: false,
      error: { code: 'gone', status: 410 },
    });
    await job('exports.purge').run();
    expect(keys().filter((k) => k.includes('/exports/'))).toHaveLength(0);
  }, 60_000);
});

// Timing assertions run only on request: `OPSLOG_PERF=1`.
describe.skipIf(process.env['OPSLOG_PERF'] !== '1')('performance of the direct export', () => {
  it('produces 5.000 rows in CSV and XLSX inside the 10 s budget', async () => {
    const a = await bigCompany(DIRECT - 1);
    for (const format of ['csv', 'xlsx'] as const) {
      const started = performance.now();
      const made = ok(await exportOf(a.admin, 'vehicle_inventory', { format }));
      const elapsed = performance.now() - started;
      expect(made.job).toMatchObject({ mode: 'direct', rowCount: DIRECT });
      process.stdout.write(`export ${format} ${DIRECT} rows: ${Math.round(elapsed)} ms\n`);
      expect(elapsed).toBeLessThan(10_000);
    }
  }, 60_000);
});
