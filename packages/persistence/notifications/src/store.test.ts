import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TypeOrmNotificationStore } from './store.js';

/** A data source that records every statement: enough to prove each one names the company. */
function recording(answer: (sql: string) => unknown = () => []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return answer(sql);
  };
  const source = {
    options: { username: 'opslog_notify_test' },
    query,
    transaction: async (_level: string, work: (m: unknown) => unknown) => work({ query }),
  } as unknown as DataSource;
  return { store: new TypeOrmNotificationStore(source), calls };
}

describe('TypeOrmNotificationStore statements', () => {
  it('names the company and the person in every read of the center', async () => {
    const { store, calls } = recording((sql) => (sql.includes('COUNT') ? [{ total: '2' }] : []));
    await store.list(
      'A',
      'ana',
      { kinds: ['export_ready'], unreadOnly: true },
      { limit: 5, offset: 0 },
    );
    await store.find('A', 'ana', 'n1');
    await store.unread('A', 'ana', ['export_ready']);
    await store.preferences('A', 'ana');
    await store.subscriptionsOf('A', 'ana', 'vehicle');
    await store.subscriptionsOf('A', 'ana');
    await store.subscribersOf('A', 'vehicle', 'v1');
    await store.deliveries('A', 'n1');
    await store.rule('A');
    await store.failed('A', { limit: 5, offset: 0 });
    for (const call of calls) {
      expect(call.sql).toContain('company_id = ?');
      expect(call.params).toContain('A');
    }
    expect(calls.every((call) => !call.sql.includes("'A'"))).toBe(true);
  });

  it('answers an empty set without a query when the person may see no kind', async () => {
    const { store, calls } = recording();
    expect(await store.list('A', 'ana', { kinds: [] }, { limit: 5, offset: 0 })).toEqual({
      items: [],
      total: 0,
    });
    expect(await store.markRead('A', 'ana', null, [], '2026-10-19T00:00:00.000Z')).toBe(0);
    expect(await store.markRead('A', 'ana', [], ['export_ready'], '2026-10-19T00:00:00.000Z')).toBe(
      0,
    );
    expect(calls).toEqual([]);
  });

  it('maps rows of every kind', async () => {
    const created = new Date('2026-10-19T16:00:00.000Z');
    const { store } = recording((sql) => {
      if (sql.includes('COUNT')) return [{ total: 1 }];
      if (sql.includes('preferences'))
        return [
          { event_kind: 'export_ready', in_app: 1, email: 0 },
          { event_kind: 'zzz', in_app: 1, email: 1 },
        ];
      if (sql.includes('_rules'))
        return [{ email_kinds: '["export_ready","zzz"]', quiet_hours: 1, updated_at: created }];
      if (sql.includes('subscriptions'))
        return [
          {
            company_id: 'A',
            recipient_id: 'ana',
            entity_type: 'vehicle',
            entity_id: 'v1',
            created_at: created,
          },
          {
            company_id: 'A',
            recipient_id: 'ana',
            entity_type: 'zzz',
            entity_id: 'v2',
            created_at: created,
          },
        ];
      return [
        {
          id: 'n1',
          company_id: 'A',
          recipient_id: 'ana',
          event_kind: 'export_ready',
          entity_type: 'export',
          entity_id: 'e1',
          title: 't',
          link: '/x',
          severity: 'info',
          created_at: created,
          read_at: null,
          in_app: 1,
        },
      ];
    });
    expect((await store.find('A', 'ana', 'n1'))?.readAt).toBeNull();
    expect(await store.preferences('A', 'ana')).toEqual([
      { eventKind: 'export_ready', inApp: true, email: false },
    ]);
    expect(await store.rule('A')).toEqual({
      emailKinds: ['export_ready'],
      quietHours: true,
      updatedAt: created.toISOString(),
    });
    expect(await store.subscriptionsOf('A', 'ana')).toHaveLength(1);
  });

  it('has no rule for a company that never saved one', async () => {
    expect(await recording().store.rule('A')).toBeNull();
    const { store } = recording(() => [
      { email_kinds: ['export_ready'], quiet_hours: false, updated_at: null },
    ]);
    expect(await store.rule('A')).toEqual({
      emailKinds: ['export_ready'],
      quietHours: false,
      updatedAt: null,
    });
  });

  it('re-throws an insert failure that is not a duplicate notice', async () => {
    const notice = {
      id: 'n1',
      tenantId: 'A',
      recipientId: 'ana',
      eventKind: 'export_ready',
      entityType: 'export',
      entityId: 'e1',
      title: 't',
      link: '/x',
      severity: 'info',
      createdAt: '2026-10-19T16:00:00.000Z',
      inApp: true,
      dateVersion: 'v',
      threshold: 't',
    } as const;
    const dup = recording(() => {
      throw Object.assign(new Error('dup'), { driverError: { errno: 1062 } });
    });
    expect(await dup.store.create(notice, [])).toBe(false);
    const other = recording(() => {
      throw Object.assign(new Error('boom'), { errno: 1213 });
    });
    await expect(other.store.create(notice, [])).rejects.toThrow('boom');
  });

  it('reads the affected rows of a driver result or of a structured one', async () => {
    const raw = recording(() => ({ affectedRows: 3 }));
    expect(
      await raw.store.markRead('A', 'ana', null, ['export_ready'], '2026-10-19T00:00:00.000Z'),
    ).toBe(3);
    const structured = recording(() => ({ affected: 1 }));
    expect(await structured.store.unsubscribe('A', 'ana', 'vehicle', 'v1')).toBe(true);
    expect(await recording(() => undefined).store.unsubscribe('A', 'ana', 'vehicle', 'v1')).toBe(
      false,
    );
  });
});
