import { describe, expect, it } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import {
  AuditConflictError,
  AuditLocalDuplicateError,
  appendAuditProjection,
  appendLocalAuditAndDelivery,
  listPendingAuditEventIds,
} from './index.js';
import {
  AuditDeliveryEntity,
  AuditLocalEventEntity,
  AuditProjectionEntity,
  AuditRegistryEntity,
} from './entities.js';

type Row = Record<string, unknown>;
type Target =
  | typeof AuditDeliveryEntity
  | typeof AuditLocalEventEntity
  | typeof AuditProjectionEntity
  | typeof AuditRegistryEntity;

function duplicate() {
  return { driverError: { errno: 1062, code: 'ER_DUP_ENTRY' } };
}

function storeKey(row: Row): string {
  return `${String(row.tenantId)}\u0000${String(row.eventId)}`;
}

function fakeManager() {
  const tables = new Map<Target, Map<string, Row>>();
  const getTable = (target: Target) => {
    let rows = tables.get(target);
    if (!rows) {
      rows = new Map();
      tables.set(target, rows);
    }
    return rows;
  };
  const manager = {
    connection: { options: { database: 'opslog_t_synthetic_a' } },
    getRepository(target: Target) {
      const rows = getTable(target);
      return {
        async insert(input: Row) {
          const key = storeKey(input);
          if (rows.has(key)) throw duplicate();
          rows.set(key, structuredClone(input));
          return { identifiers: [] };
        },
        async findOneBy(criteria: Row) {
          return structuredClone(rows.get(storeKey(criteria)) ?? null);
        },
        async find(options: { where?: Row; order?: Row; take?: number } = {}) {
          const selected = [...rows.values()].filter((row) =>
            Object.entries(options.where ?? {}).every(([field, value]) => row[field] === value),
          );
          selected.sort((left, right) => String(left.eventId).localeCompare(String(right.eventId)));
          return selected
            .slice(0, options.take ?? selected.length)
            .map((row) => structuredClone(row));
        },
      };
    },
  };
  return {
    manager: manager as unknown as EntityManager,
    rows(target: Target) {
      return [...getTable(target).values()].map((row) => structuredClone(row));
    },
  };
}

const makeEvent = (
  overrides: Partial<{
    tenantId: string;
    eventId: string;
    action: string;
    occurredAt: string;
  }> = {},
) => ({
  eventId: overrides.eventId ?? 'audit-e1',
  tenantId: overrides.tenantId ?? 'tenant-a',
  action: overrides.action ?? 'vehicle.created',
  entityType: 'vehicle',
  entityId: 'vehicle-1',
  occurredAt: overrides.occurredAt ?? '2026-10-07T10:00:00.000Z',
  actor: { id: 'system', kind: 'system' as const },
  correlationId: 'corr-a',
  data: { attempts: 1, email: 'private@example.test' },
});

describe('audit local writer and projection relay', () => {
  it('sanitizes then inserts local immutable event and initial pending state using the supplied manager', async () => {
    const db = fakeManager();
    const result = await appendLocalAuditAndDelivery(db.manager, makeEvent());
    expect(result.data).toEqual({ attempts: 1 });
    expect(db.rows(AuditLocalEventEntity)).toMatchObject([
      {
        eventId: 'audit-e1',
        tenantId: 'tenant-a',
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(db.rows(AuditDeliveryEntity)).toMatchObject([
      { eventId: 'audit-e1', tenantId: 'tenant-a', status: 'pending', deliveredAt: null },
    ]);
  });

  it('fails a duplicate local command identity closed without reading append-only rows', async () => {
    const db = fakeManager();
    await appendLocalAuditAndDelivery(db.manager, makeEvent());
    await expect(appendLocalAuditAndDelivery(db.manager, makeEvent())).rejects.toBeInstanceOf(
      AuditLocalDuplicateError,
    );
    expect(db.rows(AuditLocalEventEntity)).toHaveLength(1);
    expect(db.rows(AuditDeliveryEntity)).toHaveLength(1);
  });

  it('deduplicates canonical projection writes and rejects changed event content', async () => {
    const db = fakeManager();
    const event = makeEvent({ occurredAt: '2026-10-07T10:00:00Z' });
    await appendAuditProjection(db.manager, event);
    await appendAuditProjection(db.manager, {
      ...event,
      occurredAt: '2026-10-07T10:00:00.000Z',
    });
    await appendAuditProjection(db.manager, event);
    await expect(
      appendAuditProjection(db.manager, { ...event, occurredAt: '2036-06-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(AuditConflictError);
    expect(db.rows(AuditRegistryEntity)).toHaveLength(1);
    expect(db.rows(AuditProjectionEntity)).toHaveLength(1);
  });

  it('lists only bounded pending identities for a tenant database', async () => {
    const db = fakeManager();
    await appendLocalAuditAndDelivery(db.manager, makeEvent({ eventId: 'pending-b' }));
    await appendLocalAuditAndDelivery(db.manager, makeEvent({ eventId: 'pending-a' }));
    const source = {
      options: { database: 'opslog_t_synthetic_a' },
      getRepository: (target: Target) => db.manager.getRepository(target),
    } as unknown as DataSource;
    expect(await listPendingAuditEventIds(source, 'tenant-a', 1)).toEqual(['pending-a']);
    await expect(listPendingAuditEventIds(source, 'tenant-b')).resolves.toEqual([]);
    await expect(listPendingAuditEventIds(source, 'tenant-a', 0)).rejects.toThrow(/relay query/);
  });
});
