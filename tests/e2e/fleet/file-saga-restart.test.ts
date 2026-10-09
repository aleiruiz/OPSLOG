import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUploadIntentRecord, validateUpload } from '../../../packages/domain/files/src/index.js';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { FILE_TABLES } from '../../../packages/persistence/files/src/index.js';
import {
  FakeScanner,
  FilePipeline,
  createFileAuditEvent,
} from '../../../packages/platform/files/src/index.js';
import { openFleetRuntimeStores } from '../../../apps/api/composition/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('synthetic-fleet-file')]);

suite('Fleet durable file saga composition on synthetic MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;
  let restartedRuntime: Awaited<ReturnType<typeof openFleetRuntimeStores>> | undefined;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    await restartedRuntime?.close();
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('recovers a committed scan after reopening Fleet runtime and rolls back file state with audit', async () => {
    const admin = await fleet.platformA.signIn(await fleet.worldA.principal('subject-admin-a'));
    expect(admin.ok).toBe(true);
    const upload = await fleet.platformA.files.upload(admin.value!.token, 'fleet-file-restart', {
      name: 'synthetic.jpg',
      contentType: 'image/jpeg',
      bytes: jpg,
    });
    expect(upload.ok, upload.error?.code).toBe(true);
    const fileId = upload.value!.id;
    expect(upload.value!.status).toBe('pending_scan');

    const pending = await database.tenantA.rows<{ stage: string; state: string }>(
      `SELECT stage, state FROM ${FILE_TABLES.saga} WHERE tenant_id = ? AND file_id = ? AND stage = 'scan'`,
      [fleet.tenantA, fileId],
    );
    expect(pending).toEqual([{ stage: 'scan', state: 'pending' }]);
    const requested = await database.tenantA.rows<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${AUDIT_TABLES.local} WHERE tenant_id = ? AND entity_id = ? AND action IN ('file.upload_requested', 'file.uploaded')`,
      [fleet.tenantA, fileId],
    );
    expect(Number(requested[0]?.count)).toBe(2);

    await database.tenantA.runtime.close();
    restartedRuntime = await openFleetRuntimeStores({
      host: database.tenantA.host,
      port: database.tenantA.port,
      database: database.tenantA.databaseName,
      accounts: database.tenantA.accounts,
    });
    restartedRuntime.bindTenant(fleet.tenantA);
    const scanner = new FakeScanner();
    const recoveryTime = Date.now() + 60_000;
    const restartedPipeline = new FilePipeline(
      {
        records: restartedRuntime.adapters.records,
        storage: fleet.platformA.storage,
        scanner,
        queue: restartedRuntime.adapters.scanQueue,
        journal: restartedRuntime.adapters.fileSagaJournal,
        audit: restartedRuntime.audit,
      },
      { now: () => new Date(recoveryTime) },
    );
    expect(await restartedPipeline.processScans()).toMatchObject({ released: 1 });
    expect(scanner.calls).toBe(1);
    expect((await restartedRuntime.adapters.records.get(fleet.tenantA, fileId))?.status).toBe(
      'clean',
    );

    await restartedRuntime.auditRelay.runBatch(100);
    const projected = await database.tenantA.rows<{ action: string }>(
      `SELECT action FROM ${AUDIT_TABLES.projection} WHERE tenant_id = ? AND entity_id = ? ORDER BY occurred_at`,
      [fleet.tenantA, fileId],
    );
    expect(projected.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'file.upload_requested',
        'file.uploaded',
        'file.scan_clean',
        'file.released',
      ]),
    );

    const account = database.tenantA.accounts.files;
    await database.tenantA.rows(
      `REVOKE EXECUTE ON PROCEDURE opslog_append_local_audit_and_delivery FROM '${account.username}'@'%'`,
    );
    const actor = {
      tenantId: fleet.tenantA,
      actorId: 'synthetic-rollback-test',
      actorKind: 'system' as const,
      correlationId: 'fleet-file-audit-rollback',
    };
    const rollback = newUploadIntentRecord({
      id: 'fleet-file-rollback',
      tenantId: fleet.tenantA,
      kind: 'original',
      sensitivity: 'standard',
      upload: validateUpload({ name: 'rollback.jpg', declaredType: 'image/jpeg', bytes: jpg }),
      createdBy: actor.actorId,
      now: new Date(recoveryTime),
    });
    const rollbackEvent = createFileAuditEvent(
      actor,
      'file.upload_requested',
      rollback.id,
      new Date(recoveryTime),
    );
    try {
      await expect(
        restartedRuntime.adapters.fileSagaJournal.beginUpload(
          rollback,
          rollbackEvent,
          recoveryTime + 24 * 60 * 60_000,
        ),
      ).rejects.toBeDefined();
    } finally {
      await database.tenantA.rows(
        `GRANT EXECUTE ON PROCEDURE opslog_append_local_audit_and_delivery TO '${account.username}'@'%'`,
      );
    }
    for (const [table, key] of [
      [FILE_TABLES.records, 'id'],
      [FILE_TABLES.history, 'file_id'],
      [FILE_TABLES.saga, 'file_id'],
      [AUDIT_TABLES.local, 'event_id'],
      [AUDIT_TABLES.delivery, 'event_id'],
    ] as const) {
      const value =
        table === AUDIT_TABLES.local || table === AUDIT_TABLES.delivery
          ? rollbackEvent.eventId
          : rollback.id;
      const rows = await database.tenantA.rows<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`,
        [value],
      );
      expect(Number(rows[0]?.count), `${table} must roll back with failed audit append`).toBe(0);
    }
  }, 60_000);
});
