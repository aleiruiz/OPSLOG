import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  InMemoryNotificationStore,
  type NewNotification,
  type NotificationStore,
} from '../../../domain/notifications/src/index.js';
import { TypeOrmNotificationStore } from './store.js';
import { NOTIFICATION_TABLES as T } from './entities.js';
import { AUDIT_TABLES } from '../../audit/src/index.js';
import {
  adminUrl,
  startNotificationDatabase,
  type NotificationDatabase,
} from './test-support/mysql.js';

const suite = adminUrl ? describe : describe.skip;
const A = 'tenant-a';
const B = 'tenant-b';
const T0 = new Date('2026-10-19T16:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const notice = (id: string, over: Partial<NewNotification> = {}): NewNotification => ({
  id,
  tenantId: A,
  recipientId: 'ana',
  eventKind: 'document_expiring',
  entityType: 'vehicle',
  entityId: `doc-${id}`,
  title: `Seguro vence en 7 días · ${id}`,
  link: '/flota/vehiculos/v1',
  severity: 'attention',
  createdAt: at(Number(id.replace(/\D/g, '') || 0)).toISOString(),
  inApp: true,
  dateVersion: '2026-10-26',
  threshold: '7',
  ...over,
});
const KINDS = ['document_expiring', 'incident_created', 'export_ready'] as const;

suite('persistent notifications on MySQL', () => {
  let db: NotificationDatabase;
  let source: DataSource;
  let store: TypeOrmNotificationStore;

  beforeAll(async () => {
    db = await startNotificationDatabase('notify');
    source = await db.openRuntime();
    store = new TypeOrmNotificationStore(source);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('creates a notice with its deliveries once, and answers false for the same key', async () => {
    const deliveries = [
      { channel: 'in_app', status: 'sent', nextAttemptAt: null },
      { channel: 'email', status: 'pending', nextAttemptAt: at(0).toISOString() },
    ] as const;
    expect(await store.create(notice('n1'), deliveries)).toBe(true);
    expect(await store.create(notice('n1-again', { entityId: 'doc-n1' }), deliveries)).toBe(false);
    expect(await store.find(A, 'ana', 'n1-again')).toBeNull();
    expect(
      await db.rows(`SELECT * FROM \`${T.deliveries}\` WHERE notification_id = 'n1-again'`),
    ).toEqual([]);
    // A new date version or threshold is a new notice; so is another person or another company.
    expect(
      await store.create(notice('n1b', { entityId: 'doc-n1', dateVersion: '2026-11-26' }), []),
    ).toBe(true);
    expect(await store.create(notice('n1c', { entityId: 'doc-n1', threshold: '0' }), [])).toBe(
      true,
    );
    expect(await store.create(notice('n1d', { entityId: 'doc-n1', recipientId: 'luis' }), [])).toBe(
      true,
    );
    expect(await store.create(notice('n1e', { entityId: 'doc-n1', tenantId: B }), [])).toBe(true);
    expect(await store.find(A, 'ana', 'n1')).toEqual({
      ...(({ dateVersion: _d, threshold: _t, ...rest }) => rest)(notice('n1')),
      readAt: null,
    });
    const rows = await store.deliveries(A, 'n1');
    expect(rows.map((row) => [row.channel, row.status, row.attempts])).toEqual([
      ['in_app', 'sent', 0],
      ['email', 'pending', 0],
    ]);
  });

  it('lists newest first, pages, filters, counts and marks as read', async () => {
    for (let i = 10; i < 15; i += 1)
      await store.create(notice(`n${i}`, { recipientId: 'zoe' }), []);
    await store.create(
      notice('n20', { recipientId: 'zoe', eventKind: 'export_ready', entityType: 'export' }),
      [],
    );
    await store.create(notice('n21', { recipientId: 'zoe', inApp: false, entityId: 'hidden' }), []);
    const page = await store.list(A, 'zoe', { kinds: KINDS }, { limit: 3, offset: 0 });
    expect(page.total).toBe(6);
    expect(page.items.map((n) => n.id)).toEqual(['n20', 'n14', 'n13']);
    expect(
      (await store.list(A, 'zoe', { kinds: KINDS }, { limit: 3, offset: 3 })).items.map(
        (n) => n.id,
      ),
    ).toEqual(['n12', 'n11', 'n10']);
    expect(
      (await store.list(A, 'zoe', { kinds: KINDS, kind: 'export_ready' }, { limit: 9, offset: 0 }))
        .total,
    ).toBe(1);
    expect(
      (await store.list(A, 'zoe', { kinds: ['incident_created'] }, { limit: 9, offset: 0 })).total,
    ).toBe(0);
    expect(await store.unread(A, 'zoe', KINDS)).toBe(6);
    expect(
      await store.markRead(A, 'zoe', ['n14', 'n10', 'nope'], KINDS, at(99).toISOString()),
    ).toBe(2);
    expect(await store.markRead(A, 'zoe', ['n14'], KINDS, at(99).toISOString())).toBe(0);
    expect((await store.find(A, 'zoe', 'n14'))?.readAt).toBe(at(99).toISOString());
    expect(await store.unread(A, 'zoe', KINDS)).toBe(4);
    expect(
      (await store.list(A, 'zoe', { kinds: KINDS, unreadOnly: true }, { limit: 9, offset: 0 }))
        .total,
    ).toBe(4);
    // Marking all leaves out a kind the person may no longer see.
    expect(await store.markRead(A, 'zoe', null, ['document_expiring'], at(100).toISOString())).toBe(
      3,
    );
    expect(await store.unread(A, 'zoe', KINDS)).toBe(1);
  });

  it('never shows or changes the notices of another person or company (A/B)', async () => {
    await store.create(notice('n30', { recipientId: 'eva', entityId: 'ab' }), []);
    await store.create(notice('n31', { recipientId: 'eva', entityId: 'ab', tenantId: B }), []);
    expect(
      (await store.list(B, 'eva', { kinds: KINDS }, { limit: 9, offset: 0 })).items.map(
        (n) => n.id,
      ),
    ).toEqual(['n31']);
    expect(await store.find(B, 'eva', 'n30')).toBeNull();
    expect(await store.find(A, 'ana', 'n30')).toBeNull();
    expect(await store.markRead(B, 'eva', ['n30'], KINDS, at(5).toISOString())).toBe(0);
    expect(await store.markRead(A, 'ana', ['n30'], KINDS, at(5).toISOString())).toBe(0);
    expect(await store.unread(A, 'eva', KINDS)).toBe(1);
    expect(await store.unread(B, 'luis', KINDS)).toBe(0);
    expect(await store.deliveries(B, 'n30')).toEqual([]);
  });

  it('claims a due delivery once, settles it only while pending, and keeps failures by code', async () => {
    const now = at(1000);
    // The first test left its own e-mail pending: close it so only this test's deliveries are due.
    await store.settle(A, 'n1', 'email', { status: 'sent' }, at(1).toISOString());
    const email = (nextAttemptAt: string | null) =>
      [{ channel: 'email', status: 'pending', nextAttemptAt }] as const;
    await store.create(notice('d1', { recipientId: 'dan' }), email(at(900).toISOString()));
    await store.create(notice('d2', { recipientId: 'dan' }), email(at(2000).toISOString()));
    await store.create(
      notice('d3', { recipientId: 'dan', tenantId: B }),
      email(at(900).toISOString()),
    );
    const [first, second] = await Promise.all([
      store.claimDue(A, now, 120_000, 10),
      store.claimDue(A, now, 120_000, 10),
    ]);
    expect(first.length + second.length).toBe(1);
    const [claimed] = [...first, ...second];
    expect(claimed?.notification.id).toBe('d1');
    expect(claimed?.delivery.leaseUntil).toBe(new Date(now.getTime() + 120_000).toISOString());
    // Under lease, nothing; after the lease the same delivery can be taken again.
    expect(await store.claimDue(A, at(1060), 120_000, 10)).toEqual([]);
    expect((await store.claimDue(A, at(1200), 120_000, 10)).map((w) => w.notification.id)).toEqual([
      'd1',
    ]);
    expect(
      await store.settle(
        A,
        'd1',
        'email',
        { status: 'retry', nextAttemptAt: at(1500).toISOString(), error: 'timeout' },
        at(1210).toISOString(),
      ),
    ).toBe(true);
    expect((await store.deliveries(A, 'd1'))[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'timeout',
      nextAttemptAt: at(1500).toISOString(),
      leaseUntil: null,
    });
    expect(
      await store.settle(
        A,
        'd1',
        'email',
        { status: 'deferred', nextAttemptAt: at(1600).toISOString() },
        at(1211).toISOString(),
      ),
    ).toBe(true);
    expect((await store.deliveries(A, 'd1'))[0]).toMatchObject({
      attempts: 1,
      nextAttemptAt: at(1600).toISOString(),
    });
    expect(
      await store.settle(
        A,
        'd1',
        'email',
        { status: 'failed', error: 'rejected' },
        at(1700).toISOString(),
      ),
    ).toBe(true);
    expect(await store.settle(A, 'd1', 'email', { status: 'sent' }, at(1701).toISOString())).toBe(
      false,
    );
    expect((await store.deliveries(A, 'd1'))[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'rejected',
      nextAttemptAt: null,
    });
    // The company B delivery is untouched by anything done on A.
    expect(await store.settle(A, 'd3', 'email', { status: 'sent' }, at(1701).toISOString())).toBe(
      false,
    );
    expect((await store.claimDue(B, now, 120_000, 10)).map((w) => w.notification.id)).toEqual([
      'd3',
    ]);
    expect(await store.settle(B, 'd3', 'email', { status: 'sent' }, at(1702).toISOString())).toBe(
      true,
    );
    expect(
      await store.settle(
        B,
        'd3',
        'email',
        { status: 'suppressed', reason: 'revoked' },
        at(1703).toISOString(),
      ),
    ).toBe(false);
    await store.create(notice('d4', { recipientId: 'dan' }), email(at(900).toISOString()));
    await store.claimDue(A, at(3000), 1000, 1);
    expect(
      await store.settle(
        A,
        'd2',
        'email',
        { status: 'suppressed', reason: 'revoked' },
        at(3001).toISOString(),
      ),
    ).toBe(true);
    expect((await store.deliveries(A, 'd2'))[0]).toMatchObject({
      status: 'suppressed',
      lastError: 'revoked',
      attempts: 0,
    });
    const failed = await store.failed(A, { limit: 5, offset: 0 });
    expect(failed).toEqual({
      total: 1,
      items: [
        {
          notificationId: 'd1',
          eventKind: 'document_expiring',
          channel: 'email',
          attempts: 2,
          lastError: 'rejected',
          updatedAt: at(1700).toISOString(),
        },
      ],
    });
    expect((await store.failed(B, { limit: 5, offset: 0 })).total).toBe(0);
  });

  it('stores preferences, the company rule and follows per company', async () => {
    await store.savePreferences(
      A,
      'ana',
      [{ eventKind: 'document_expiring', inApp: true, email: false }],
      at(1).toISOString(),
    );
    await store.savePreferences(
      A,
      'ana',
      [
        { eventKind: 'document_expiring', inApp: false, email: true },
        { eventKind: 'export_ready', inApp: true, email: true },
      ],
      at(2).toISOString(),
    );
    expect(await store.preferences(A, 'ana')).toEqual([
      { eventKind: 'document_expiring', inApp: false, email: true },
      { eventKind: 'export_ready', inApp: true, email: true },
    ]);
    expect(await store.preferences(B, 'ana')).toEqual([]);
    expect(await store.preferences(A, 'luis')).toEqual([]);

    expect(await store.rule(A)).toBeNull();
    await store.saveRule(A, {
      emailKinds: ['export_ready'],
      quietHours: true,
      updatedAt: at(3).toISOString(),
    });
    await store.saveRule(A, {
      emailKinds: ['export_ready', 'document_expiring'],
      quietHours: false,
      updatedAt: at(4).toISOString(),
    });
    expect(await store.rule(A)).toEqual({
      emailKinds: ['export_ready', 'document_expiring'],
      quietHours: false,
      updatedAt: at(4).toISOString(),
    });
    expect(await store.rule(B)).toBeNull();

    const sub = (tenantId: string, recipientId: string, entityId: string, s: number) => ({
      tenantId,
      recipientId,
      entityType: 'vehicle' as const,
      entityId,
      createdAt: at(s).toISOString(),
    });
    await store.subscribe(sub(A, 'ana', 'v1', 5));
    await store.subscribe(sub(A, 'ana', 'v1', 6));
    await store.subscribe({ ...sub(A, 'ana', 'i1', 7), entityType: 'incident' });
    await store.subscribe(sub(A, 'luis', 'v1', 8));
    await store.subscribe(sub(B, 'ana', 'v1', 9));
    expect(
      (await store.subscriptionsOf(A, 'ana')).map((s) => `${s.entityType}:${s.entityId}`),
    ).toEqual(['vehicle:v1', 'incident:i1']);
    expect((await store.subscriptionsOf(A, 'ana', 'incident')).map((s) => s.entityId)).toEqual([
      'i1',
    ]);
    expect(await store.subscribersOf(A, 'vehicle', 'v1')).toEqual(['ana', 'luis']);
    expect(await store.subscribersOf(B, 'vehicle', 'v1')).toEqual(['ana']);
    expect(await store.unsubscribe(A, 'ana', 'vehicle', 'v1')).toBe(true);
    expect(await store.unsubscribe(A, 'ana', 'vehicle', 'v1')).toBe(false);
    expect(await store.subscribersOf(B, 'vehicle', 'v1')).toEqual(['ana']);
  });

  it('keeps no address, body or provider message anywhere in the database', async () => {
    const columns = await db.rows<{ COLUMN_NAME: string }>(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?',
      [db.databaseName, 'opslog_notification%'],
    );
    expect(columns.map((c) => c.COLUMN_NAME).join(',')).not.toMatch(
      /address|body|subject|message|mail_to/,
    );
    const dump = JSON.stringify(await db.rows(`SELECT * FROM \`${T.deliveries}\``));
    expect(dump).not.toContain('@');
  });

  it('writes the events no module publishes to the tenant outbox, once per event id', async () => {
    const event = {
      eventId: 'membership-created-ana-1',
      tenantId: A,
      type: 'membership.created',
      payload: { memberId: 'ana', role: 'viewer', version: 1 },
      occurredAt: at(5).toISOString(),
      entityId: 'ana',
    };
    await store.publish(event);
    await store.publish(event);
    const rows = await db.rows<{ type: string; actor_kind: string; payload: unknown }>(
      `SELECT * FROM \`${AUDIT_TABLES.outbox}\` WHERE event_id = ?`,
      [event.eventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('membership.created');
    expect(JSON.stringify(rows[0])).not.toContain('@');
    // The same id in another company is another event: nothing crosses.
    await store.publish({ ...event, tenantId: B });
    const both = await db.rows<{ company_id: string }>(
      `SELECT tenant_id AS company_id FROM \`${AUDIT_TABLES.outbox}\` WHERE event_id = ? ORDER BY tenant_id`,
      [event.eventId],
    );
    expect(both.map((row) => row.company_id)).toEqual([A, B]);
  });

  it('refuses what the restricted account may not do', async () => {
    await expect(source.query(`DELETE FROM \`${T.notifications}\``)).rejects.toThrow(/denied/i);
    await expect(source.query(`DROP TABLE \`${T.rules}\``)).rejects.toThrow(/denied/i);
    await expect(source.query(`DELETE FROM \`${T.rules}\``)).rejects.toThrow(/denied/i);
  });

  it('behaves like the in-memory store on the same script', async () => {
    const run = async (target: NotificationStore, tenantId: string) => {
      const out: unknown[] = [];
      const pending = [
        { channel: 'email', status: 'pending', nextAttemptAt: at(10).toISOString() },
      ] as const;
      out.push(await target.create(notice('p1', { tenantId, recipientId: 'pat' }), pending));
      out.push(
        await target.create(
          notice('p1x', { tenantId, recipientId: 'pat', entityId: 'doc-p1' }),
          pending,
        ),
      );
      out.push(await target.create(notice('p2', { tenantId, recipientId: 'pat' }), pending));
      out.push(
        (await target.list(tenantId, 'pat', { kinds: KINDS }, { limit: 5, offset: 0 })).items.map(
          (n) => n.id,
        ),
      );
      out.push(await target.markRead(tenantId, 'pat', ['p2'], KINDS, at(50).toISOString()));
      out.push(await target.unread(tenantId, 'pat', KINDS));
      out.push((await target.claimDue(tenantId, at(20), 60_000, 5)).map((w) => w.notification.id));
      out.push(
        await target.settle(
          tenantId,
          'p1',
          'email',
          { status: 'retry', nextAttemptAt: at(30).toISOString(), error: 'timeout' },
          at(21).toISOString(),
        ),
      );
      out.push(
        await target.settle(tenantId, 'p2', 'email', { status: 'sent' }, at(22).toISOString()),
      );
      out.push(
        await target.settle(tenantId, 'p2', 'email', { status: 'sent' }, at(23).toISOString()),
      );
      out.push(
        (await target.deliveries(tenantId, 'p1')).map(
          ({ status, attempts, lastError, nextAttemptAt, leaseUntil }) => ({
            status,
            attempts,
            lastError,
            nextAttemptAt,
            leaseUntil,
          }),
        ),
      );
      return out;
    };
    expect(await run(store, 'parity-a')).toEqual(
      await run(new InMemoryNotificationStore(), 'parity-a'),
    );
  });
});
