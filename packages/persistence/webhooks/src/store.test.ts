import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TypeOrmWebhookStore } from './store.js';

/** A data source that records every statement: enough to prove each one names the company. */
function recording(answer: (sql: string) => unknown = () => []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return answer(sql);
  };
  const source = {
    options: { username: 'opslog_webhooks_test' },
    query,
    createQueryRunner: () => ({
      connect: async () => undefined,
      query,
      release: async () => undefined,
    }),
    transaction: async (_level: string, work: (m: unknown) => unknown) => work({ query }),
  } as unknown as DataSource;
  return { store: new TypeOrmWebhookStore(source), calls };
}

describe('TypeOrmWebhookStore statements', () => {
  it('names the company in every statement', async () => {
    const { store, calls } = recording((sql) => (sql.includes('COUNT') ? [{ total: '0' }] : []));
    await store.endpoints('A');
    await store.endpoint('A', 'e1');
    await store.deliveries('A', 'e1', { limit: 5, offset: 0 });
    await store.delivery('A', 'e1', 'd1');
    await store.retryNow('A', 'e1', 'd1', '2026-10-19T00:00:00.000Z');
    await store.claimDue('A', new Date(), 1000, 5);
    await store.renew('A', 'd1', null, new Date(), 1000);
    await store.settle(
      'A',
      'd1',
      { kind: 'delivered', statusCode: 200, durationMs: 1 },
      '2026-10-19T00:00:00.000Z',
      null,
    );
    await store.attemptsSince('A', new Date());
    await store.noteResult('A', 'e1', false, '2026-10-19T00:00:00.000Z');
    await store.noteResult('A', 'e1', true, '2026-10-19T00:00:00.000Z');
    await store.purge('A', new Date());
    await store.deleteEndpoint('A', 'e1');
    await store.driverState('A', 'drv');
    for (const call of calls) {
      expect(call.sql).toContain('company_id = ?');
      expect(call.params).toContain('A');
    }
    expect(calls.every((call) => !call.sql.includes("'A'"))).toBe(true);
  });

  it('creates an endpoint under the company lock and refuses it past the limit', async () => {
    const { store, calls } = recording((sql) =>
      sql.includes('GET_LOCK') ? [{ got: 1 }] : [{ total: 5 }],
    );
    const row = {
      id: 'e',
      tenantId: 'A',
      events: [],
      previousExpiresAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    };
    expect(await store.createEndpoint(row as never, 5)).toBe(false);
    expect(calls.map((c) => c.sql.split(' ')[0] + ' ' + c.sql.split(' ')[1])).toEqual([
      'SELECT GET_LOCK(?,',
      'SELECT COUNT(*)',
      'SELECT RELEASE_LOCK(?)',
    ]);
    const { store: busy } = recording(() => [{ got: 0 }]);
    await expect(busy.createEndpoint(row as never, 5)).rejects.toThrow(/lock unavailable/);
  });

  it('maps rows and tolerates a driver that has no state', async () => {
    const created = new Date('2026-10-19T16:00:00.000Z');
    const { store } = recording((sql) =>
      sql.includes('driver_state')
        ? [{ eligible: 1, transitions: '2', updated_at: created }]
        : [
            {
              id: 'e1',
              company_id: 'A',
              url: 'https://h.example.com',
              events: '["vehicle.created","bogus"]',
              active: 1,
              disabled_reason: null,
              company_ref: 'co_x',
              secret_sealed: 'pii1.x',
              previous_sealed: null,
              previous_expires_at: null,
              consecutive_failures: '0',
              version: '1',
              created_at: created,
              updated_at: created,
              created_by: 'ana',
            },
          ],
    );
    const [one] = await store.endpoints('A');
    expect(one).toMatchObject({ events: ['vehicle.created'], active: true, version: 1 });
    expect(await store.driverState('A', 'd')).toMatchObject({ eligible: true, transitions: 2 });
    const { store: empty } = recording();
    expect(await empty.driverState('A', 'd')).toBeNull();
    expect(await empty.endpoint('A', 'e')).toBeNull();
  });
});
