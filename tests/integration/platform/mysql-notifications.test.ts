import { afterAll, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TABLES as T } from '../../../packages/persistence/notifications/src/index.js';
import { SinkMailAdapter } from '../../../packages/platform/mail/src/index.js';
import type { Platform } from '../../../apps/api/composition/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../../e2e/fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../../e2e/fleet/world.js';
import { T0, drainAll } from './incident-sla-support.js';

/**
 * Notifications on two real MySQL databases (one per company, each with its own restricted runtime
 * accounts): the center, the dedupe key, the deliveries, the durable events of the control plane and
 * the mail sink. Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const N = '/api/v1/notifications';
const opened: { database: FleetDatabase; fleet: FleetWorld }[] = [];
afterAll(async () => {
  for (const { database, fleet } of opened) {
    fleet.world.dispose();
    await database.close();
  }
}, 120_000);

async function start() {
  const mailA = new SinkMailAdapter({ retain: 100 });
  const mailB = new SinkMailAdapter({ retain: 100 });
  const database = await startFleetDatabase();
  const fleet = await startFleetWorld(database, { a: { mail: mailA }, b: { mail: mailB } });
  opened.push({ database, fleet });
  // The database stamps `available_at` with its own clock, which is later than the fixtures' clock.
  vi.setSystemTime(T0);
  return { database, fleet, mailA, mailB };
}

const job = (platform: Platform, name: string) => {
  const found = platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};
async function tick(platform: Platform): Promise<void> {
  await drainAll(platform);
  await job(platform, 'notifications.scan').run();
  await job(platform, 'notifications.dispatch').run();
  await drainAll(platform);
}

suite('Notifications on real MySQL', { timeout: 120_000 }, () => {
  it('stores the notices, their deliveries and the mail per company without crossing', async () => {
    const { database, fleet, mailA, mailB } = await start();
    await fleet.worldA.member('subject-admin-a', 'viewer', 'subject-viewer-a2');
    await fleet.worldB.member('subject-admin-b', 'viewer', 'subject-viewer-b');
    await tick(fleet.platformA);
    await tick(fleet.platformB);

    const adminA = await fleet.worldA.loginAs('subject-admin-a');
    const adminB = await fleet.worldB.loginAs('subject-admin-b');
    const listA = (await adminA.get(`${N}?limit=100`)).json;
    const listB = (await adminB.get(`${N}?limit=100`)).json;
    expect(listA.total).toBeGreaterThan(0);
    expect(listB.total).toBeGreaterThan(0);
    expect((await adminA.get(`${N}/unread-count`)).json.unread).toBe(listA.unread);

    // Each company's rows live only in its own database, under its own company id.
    const rowsA = await database.rows<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM \`${T.notifications}\``,
    );
    const rowsB = await database.rowsB<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM \`${T.notifications}\``,
    );
    expect(rowsA).toEqual([{ company_id: fleet.tenantA }]);
    expect(rowsB).toEqual([{ company_id: fleet.tenantB }]);

    // Reading a notice of A through B finds nothing; B's read-all leaves A's counter alone.
    const target = listA.items[0].id as string;
    expect((await adminB.post(`${N}/${target}/read`)).status).toBe(404);
    const before = (await adminA.get(`${N}/unread-count`)).json.unread;
    await adminB.post(`${N}/read-all`);
    expect((await adminA.get(`${N}/unread-count`)).json.unread).toBe(before);

    // Deliveries settled, no address anywhere in the tables, and the mail went to the right sink.
    const dump = JSON.stringify([
      await database.rows(`SELECT * FROM \`${T.notifications}\``),
      await database.rows(`SELECT * FROM \`${T.deliveries}\``),
    ]);
    expect(dump).not.toContain('@');
    const pending = await database.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${T.deliveries}\` WHERE status = 'pending'`,
    );
    expect(Number(pending[0]?.n)).toBe(0);
    expect(mailA.messages.every((message) => message.companyId === fleet.tenantA)).toBe(true);
    expect(mailB.messages.every((message) => message.companyId === fleet.tenantB)).toBe(true);
    expect(mailA.messages.length).toBeGreaterThan(0);
  });

  it('keeps the dedupe key across rounds and saves preferences and rules in the database', async () => {
    const { database, fleet } = await start();
    const adminA = await fleet.worldA.loginAs('subject-admin-a');
    const area = await fleet.area(adminA);
    const vehicle = await fleet.vehicle(adminA, area, 'N1');
    const doc = await adminA.post('/api/documents', {
      json: {
        ownerType: 'vehicle',
        ownerId: vehicle,
        typeCode: 'registration_card',
        title: 'Tarjeta de circulación',
        expiresOn: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
      },
    });
    expect(doc.status, doc.text).toBe(201);
    await tick(fleet.platformA);
    const first = await database.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${T.notifications}\` WHERE event_kind = 'document_expiring'`,
    );
    expect(Number(first[0]?.n)).toBeGreaterThan(0);
    await tick(fleet.platformA);
    const again = await database.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${T.notifications}\` WHERE event_kind = 'document_expiring'`,
    );
    expect(again).toEqual(first);

    const rule = await adminA.put('/api/v1/notification-rules', {
      json: { emailKinds: ['membership_created'], quietHours: true },
    });
    expect(rule.status, rule.text).toBe(200);
    const stored = await database.rows<{ quiet_hours: number }>(
      `SELECT quiet_hours FROM \`${T.rules}\` WHERE company_id = ?`,
      [fleet.tenantA],
    );
    expect(stored.map((row) => Number(row.quiet_hours))).toEqual([1]);
    const viewer = await fleet.worldA.loginAs('subject-viewer-a');
    const denied = await viewer.put('/api/v1/notification-rules', {
      json: { emailKinds: [], quietHours: false },
    });
    expect(denied.status).toBe(403);

    const followed = await adminA.put(`/api/v1/subscriptions/vehicle/${vehicle}`);
    expect(followed.status, followed.text).toBe(200);
    const subs = await database.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${T.subscriptions}\` WHERE entity_id = ?`,
      [vehicle],
    );
    expect(Number(subs[0]?.n)).toBe(1);
    const adminB = await fleet.worldB.loginAs('subject-admin-b');
    expect((await adminB.put(`/api/v1/subscriptions/vehicle/${vehicle}`)).status).toBe(404);
  });
});
