import type { Platform } from '../../../apps/api/composition/src/index.js';
import { MAINTENANCE_PLAN_SCAN_EVENT } from '../../../apps/worker/maintenance-plans/src/index.js';
import {
  AUDIT_TABLES,
  MySqlTenantOutboxStore,
} from '../../../packages/persistence/audit/src/index.js';
import { createMaintenanceDataSource } from '../../../packages/persistence/maintenance/plans/src/index.js';
import type { FleetTenantDatabase } from '../../e2e/fleet/mysql.js';

/**
 * Enqueues scan jobs through the durable tenant outbox, inside a transaction of the restricted
 * maintenance runtime account, exactly as the worker store commits its own events.
 */
export async function enqueuePlanScans(
  database: FleetTenantDatabase,
  tenantId: string,
  scans: readonly { readonly planId: string; readonly attempt: string }[],
): Promise<string[]> {
  const source = createMaintenanceDataSource({
    host: database.host,
    port: database.port,
    database: database.databaseName,
    ...database.accounts.maintenance,
  });
  await source.initialize();
  let eventIds: string[];
  try {
    const outbox = new MySqlTenantOutboxStore(
      () => [tenantId],
      () => source,
      () => source,
    );
    const occurredAt = new Date(Date.now()).toISOString();
    eventIds = await source.transaction('READ COMMITTED', (manager) =>
      outbox.transaction(manager, (tx) =>
        scans.map(({ planId, attempt }) => {
          const eventId = `mnt-plan-scan-${planId}-${attempt}`;
          tx.enqueue({
            eventId,
            tenantId,
            type: MAINTENANCE_PLAN_SCAN_EVENT,
            payload: { planId, correlationId: eventId },
            occurredAt,
            idempotencyKey: eventId,
            correlationId: eventId,
            actorRef: { subject: 'worker-maintenance-plans', kind: 'system' },
            requiredPermission: 'view',
            entityId: planId,
            schemaVersion: 1,
          });
          return eventId;
        }),
      ),
    );
  } finally {
    await source.destroy();
  }
  await makeEventsAvailable(database, tenantId, eventIds);
  return eventIds;
}

/**
 * The enqueue procedure stamps available_at with the database clock, while the composed world runs
 * on a fixed fake clock in the past; align only these synthetic events with that clock.
 */
export async function makeEventsAvailable(
  database: FleetTenantDatabase,
  tenantId: string,
  eventIds: readonly string[],
): Promise<void> {
  const worldNow = new Date(Date.now()).toISOString().replace('T', ' ').replace('Z', '');
  await database.rows(
    `UPDATE ${AUDIT_TABLES.outbox} SET available_at = ? WHERE tenant_id = ? AND event_id IN (?)`,
    [worldNow, tenantId, eventIds],
  );
}

/** Drains the composed worker and checks delivery through the synthetic admin connection. */
export async function deliverOutboxEvents(
  platform: Platform,
  database: FleetTenantDatabase,
  tenantId: string,
  eventIds: readonly string[],
): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const rows = await database.rows<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM ${AUDIT_TABLES.outbox} WHERE tenant_id = ? AND event_id IN (?)`,
      [tenantId, eventIds],
    );
    if (rows.length !== eventIds.length)
      throw new Error('maintenance scan events were not committed to the outbox');
    if (rows.some((row) => row.status === 'dead_letter'))
      throw new Error('maintenance scan event reached the dead-letter queue');
    if (rows.every((row) => row.status === 'delivered')) return;
    if ((await platform.runtime.drainOutbox()) === 0)
      throw new Error('maintenance scan events were not available to the worker');
  }
  throw new Error('maintenance scan events were not delivered within the bounded drain');
}
