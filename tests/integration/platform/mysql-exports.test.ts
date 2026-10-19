import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import type { ReportsApiResponse } from '../../../apps/api/exports/src/index.js';
import { InMemoryVehicleStore } from '../../../packages/domain/vehicles/src/index.js';
import { TypeOrmExportJobStore } from '../../../packages/persistence/exports/src/index.js';
import {
  adminUrl,
  startExportDatabase,
  type ExportDatabase,
} from '../../../packages/persistence/exports/src/test-support/mysql.js';
import { corr, createWorld, type World } from './world.js';

/**
 * The platform on the real MySQL export job store (CI: mysql service, OPSLOG_TEST_MYSQL_ADMIN_URL;
 * locally skipped when unset). The other modules stay in memory: they are the source of the rows.
 */
const suite = adminUrl ? describe : describe.skip;

const ok = <T>(result: PlatformResponse<T> | ReportsApiResponse<T>): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return (result as { value: T }).value;
};

suite('Platform on the real MySQL export jobs', () => {
  let database: ExportDatabase;
  let world: World;
  let store: TypeOrmExportJobStore;

  beforeAll(async () => {
    database = await startExportDatabase('platform');
    store = new TypeOrmExportJobStore(await database.openRuntime());
  });
  afterEach(() => world?.dispose());
  afterAll(async () => database?.close());

  async function company(name: string, tag: string, vehicles = 1) {
    const handle = await world.tenant(name, `subject-admin-${tag}`);
    const admin = handle.admin;
    const areaId = ok(await world.platform.areas.create(admin.token, corr(), { name: 'Flota' })).id;
    for (let i = 0; i < vehicles; i += 1)
      ok(
        await world.platform.vehicles.create(admin.token, corr(), {
          economicNumber: `U-${tag}-${i}`,
          plate: `PL-${tag}-${i}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 10,
        }),
      );
    return { tenantId: handle.tenantId, admin };
  }

  const create = (token: string, input: Record<string, unknown>) =>
    world.platform.reports.exports.create(token, corr(), {
      reportId: 'vehicle_inventory',
      format: 'csv',
      ...input,
    } as never);

  it('persists a direct export, replays its key and isolates companies', async () => {
    world = createWorld({ adapters: { exportJobs: store } } as never);
    const a = await company('Empresa Alfa', 'a');
    const b = await company('Empresa Beta', 'b');
    const first = ok(await create(a.admin.token, { idempotencyKey: 'mysql-key-0001' }));
    expect(first.job).toMatchObject({ status: 'completed', mode: 'direct', rowCount: 1 });
    const again = ok(await create(a.admin.token, { idempotencyKey: 'mysql-key-0001' }));
    expect(again).toMatchObject({ replayed: true, job: { id: first.job.id } });
    expect(
      await create(a.admin.token, { idempotencyKey: 'mysql-key-0001', reportId: 'areas' }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const file = ok(
      await world.platform.reports.exports.download(a.admin.token, corr(), first.job.id),
    );
    expect(Buffer.from(file.bytes).toString('utf8')).toContain('U-a-0');
    expect(
      await world.platform.reports.exports.get(b.admin.token, corr(), first.job.id),
    ).toMatchObject({ ok: false, error: { status: 404 } });
    const rows = await database.rows(
      'SELECT company_id, report_id, status FROM opslog_export_jobs WHERE id = ?',
      [first.job.id],
    );
    expect(rows).toEqual([
      { company_id: a.tenantId, report_id: 'vehicle_inventory', status: 'completed' },
    ]);
  });

  it('runs a queued job from MySQL on the tick and writes its event with the status', async () => {
    const vehicles = new InMemoryVehicleStore();
    world = createWorld({ adapters: { exportJobs: store, vehicles } } as never);
    const a = await company('Empresa Gamma', 'g');
    const now = new Date().toISOString();
    for (let i = 0; i < 5_000; i += 1)
      await vehicles.insert(
        {
          id: `mysql-big-${i}`,
          tenantId: a.tenantId,
          economicNumber: `M-${i}`,
          plate: `MB-${i}`,
          vin: null,
          make: 'Kenworth',
          model: 'T680',
          year: 2020,
          areaId: 'area',
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
          id: `mh-${i}`,
          tenantId: a.tenantId,
          vehicleId: `mysql-big-${i}`,
          from: null,
          to: 'active',
          reason: 'Alta',
          actorId: 'user-seed',
          version: 1,
          at: now,
        },
      );
    const made = ok(await create(a.admin.token, {}));
    expect(made.job).toMatchObject({ mode: 'job', status: 'queued' });
    const tick = world.platform.runtime.jobs.list().find((j) => j.name === 'exports.run');
    await tick?.run();
    const done = ok(await world.platform.reports.exports.get(a.admin.token, corr(), made.job.id));
    expect(done).toMatchObject({ status: 'completed', rowCount: 5_001 });
    const events = await database.rows('SELECT type FROM opslog_tenant_outbox WHERE event_id = ?', [
      `export-completed-${made.job.id}`,
    ]);
    expect(events).toEqual([{ type: 'export.completed' }]);
  }, 120_000);
});
