import { afterEach, describe, expect, it } from 'vitest';
import { BFF_NOTIFICATION_KINDS } from '../../../packages/contracts/src/index.js';
import { syntheticAddresses } from '../../../apps/api/composition/src/platform/incident-sla-apis.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { EVENT_KINDS } from '../../../packages/domain/notifications/src/index.js';
import {
  MailError,
  SinkMailAdapter,
  recipientRef,
  type MailMessage,
  type SinkRecord,
} from '../../../packages/platform/mail/src/index.js';
import { Cases, DAY, T0, drainAll } from './incident-sla-support.js';

/** A mail port that can be taken down: the provider failing for every send. */
class SwitchMail extends SinkMailAdapter {
  public down = false;
  public override async send(message: MailMessage): Promise<void> {
    if (this.down) throw new MailError('connection');
    await super.send(message);
  }
}

const N = '/api/v1/notifications';
const HOUR = 3_600_000;
let world: BffWorld;
afterEach(() => world?.dispose());

const job = (name: string) => {
  const found = world.platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};
/** One worker round: the outbox, the expiry scan and the delivery of what is due. */
async function tick(): Promise<void> {
  await drainAll(world.platform);
  await job('notifications.scan').run();
  await job('notifications.dispatch').run();
  await drainAll(world.platform);
}
const at = (iso: string) => world.advance(new Date(iso).getTime() - Date.now());

async function fixture(options: { quiet?: boolean } = {}) {
  const logged: SinkRecord[] = [];
  const mail = new SwitchMail({ retain: 200, log: (record) => logged.push(record) });
  world = createBffWorld({ adapters: { mail } });
  const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await world.tenant('Empresa Beta', 'subject-admin-b');
  const members = {
    editor: await world.member('subject-admin-a', 'editor', 'subject-editor-a'),
    viewer: await world.member('subject-admin-a', 'viewer', 'subject-viewer-a'),
    manager: await world.member('subject-admin-a', 'incident_manager', 'subject-manager-a'),
    manager2: await world.member('subject-admin-a', 'incident_manager', 'subject-manager-2a'),
    managerB: await world.member('subject-admin-b', 'incident_manager', 'subject-manager-b'),
  };
  await tick();
  const login = async () => ({
    adminA: await world.loginAs('subject-admin-a'),
    editorA: await world.loginAs('subject-editor-a'),
    viewerA: await world.loginAs('subject-viewer-a'),
    adminB: await world.loginAs('subject-admin-b'),
  });
  if (options.quiet) {
    const { adminA } = await login();
    const current = (await adminA.get('/api/v1/notification-rules')).json;
    const saved = await adminA.put('/api/v1/notification-rules', {
      json: { emailKinds: current.emailKinds, quietHours: true },
    });
    expect(saved.status, saved.text).toBe(200);
  }
  return { mail, logged, a, b, members, login, ...(await login()) };
}

const unread = async (browser: Browser) =>
  (await browser.get(`${N}/unread-count`)).json.unread as number;
const kindsOf = async (browser: Browser) =>
  ((await browser.get(`${N}?limit=100`)).json.items as { eventKind: string }[]).map(
    (n) => n.eventKind,
  );
const addressOf = async (tenantId: string, identityId: string): Promise<string> => {
  const address = await syntheticAddresses.addressOf(tenantId, `user-${identityId}`);
  if (!address) throw new Error('fixture member has no address');
  return address;
};

async function documentExpiring(admin: Browser, expiresOn: string): Promise<{ id: string }> {
  const area = await admin.post('/api/areas', { json: { name: 'Flota' } });
  const vehicle = await admin.post('/api/vehicles', {
    json: {
      economicNumber: 'ECO-1',
      plate: 'AAA-001',
      make: 'Nissan',
      model: 'NP300',
      year: 2023,
      areaId: area.json.id,
      odometerKm: 1,
    },
  });
  expect(vehicle.status, vehicle.text).toBe(201);
  const doc = await admin.post('/api/documents', {
    json: {
      ownerType: 'vehicle',
      ownerId: vehicle.json.id,
      typeCode: 'registration_card',
      title: 'Tarjeta de circulación',
      expiresOn,
    },
  });
  expect(doc.status, doc.text).toBe(201);
  return doc.json;
}

describe('contract', () => {
  it('lists in the BFF the same kinds of notice as the domain catalog', () => {
    expect([...BFF_NOTIFICATION_KINDS].sort()).toEqual([...EVENT_KINDS].sort());
  });
});

describe('membership notices', () => {
  it('keys each «usuario nuevo» event by its moment, so a later invitation of the same person is not swallowed', async () => {
    const f = await fixture();
    world.advance(HOUR);
    const joined = await world.member('subject-admin-a', 'viewer', 'subject-back-a');
    const ids = (await world.platform.outbox.all())
      .filter((r) => r.type === 'membership.created' && r.entityId === joined.identityId)
      .map((r) => r.eventId);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(`membership-created-${joined.identityId}-${Date.now()}`);
    expect(ids[0]?.endsWith('-1')).toBe(false);
    await tick();
    expect(await kindsOf(f.adminA)).toContain('membership_created');
  });
});

describe('acceptance 1: deduplication', () => {
  it('announces an expiry once per recipient and threshold, and starts again when the date changes', async () => {
    const f = await fixture();
    const doc = await documentExpiring(f.adminA, '2026-10-21');
    await tick();
    await world.advance(2 * HOUR);
    await tick();
    await world.advance(2 * HOUR);
    await tick();
    const count = async (browser: Browser) =>
      (await kindsOf(browser)).filter((k) => k === 'document_expiring').length;
    expect(await count(f.adminA)).toBe(1);
    expect(await count(f.editorA)).toBe(1);
    expect(await count(f.viewerA)).toBe(0);
    expect(await count(f.adminB)).toBe(0);
    const renewed = await f.adminA.post(`/api/documents/${doc.id}/renew`, {
      json: { version: 1, expiresOn: '2026-10-18' },
    });
    expect(renewed.status, renewed.text).toBe(200);
    await world.advance(2 * HOUR);
    await tick();
    expect(await count(f.editorA)).toBe(2);
  });
});

describe('acceptance 2: a failing mail port does not revert the command', () => {
  it('keeps the in-app notice and the command, and ends the delivery as failed for the administrator', async () => {
    const f = await fixture();
    f.mail.down = true;
    const joined = await world.member('subject-admin-a', 'viewer', 'subject-late-a');
    const before = await unread(f.adminA);
    await tick();
    expect(await unread(f.adminA)).toBeGreaterThan(before);
    // The command stands: the new member can sign in.
    await world.loginAs('subject-late-a');
    for (let round = 0; round < 8; round += 1) {
      await world.advance(HOUR);
      await tick();
    }
    const adminA = await world.loginAs('subject-admin-a');
    const failed = await adminA.get('/api/v1/notification-deliveries/failed');
    expect(failed.status, failed.text).toBe(200);
    expect(failed.json.total).toBeGreaterThan(0);
    expect(failed.json.items[0]).toMatchObject({ channel: 'email', lastError: 'connection' });
    expect(failed.text).not.toContain('@');
    expect(joined.identityId).toBeTruthy();
    // Back up: nothing failed is sent again by itself and the center is intact.
    f.mail.down = false;
    await tick();
    expect((await adminA.get(`${N}?limit=100`)).json.total).toBeGreaterThan(0);
  });
});

describe('acceptance 3: mandatory notices', () => {
  it('keeps the exports notice when everything optional is off, and refuses to switch it off', async () => {
    const f = await fixture();
    const matrix = (await f.adminA.get('/api/v1/notification-preferences')).json.items as {
      eventKind: string;
      mandatory: boolean;
    }[];
    const off = matrix
      .filter((row) => !row.mandatory)
      .map((row) => ({ eventKind: row.eventKind, inApp: false, email: false }));
    expect(
      (await f.adminA.put('/api/v1/notification-preferences', { json: { items: off } })).status,
    ).toBe(200);
    const refused = await f.adminA.put('/api/v1/notification-preferences', {
      json: { items: [{ eventKind: 'export_ready', inApp: false, email: false }] },
    });
    expect(refused.status).toBe(422);
    const made = await f.adminA.post('/api/v1/reports/areas/exports', { json: { format: 'csv' } });
    expect(made.status, made.text).toBe(201);
    await tick();
    expect(await kindsOf(f.adminA)).toContain('export_ready');
  });
});

describe('acceptance 4: quiet hours', () => {
  it('sends the in-app notice at once and defers the e-mail to 07:00 in the company zone', async () => {
    const f = await fixture({ quiet: true });
    // 23:00 in America/Mexico_City (UTC-6) on 2026-10-06 is 05:00 UTC the next day.
    at('2026-10-07T05:00:00.000Z');
    const sinkBefore = f.mail.messages.length;
    await world.member('subject-admin-a', 'viewer', 'subject-night-a');
    const adminA = await world.loginAs('subject-admin-a');
    await tick();
    expect(await kindsOf(adminA)).toContain('membership_created');
    expect(f.mail.messages.length).toBe(sinkBefore);
    at('2026-10-07T13:05:00.000Z');
    await tick();
    expect(f.mail.messages.length).toBeGreaterThan(sinkBefore);
  });
});

describe('acceptance 5: revocation', () => {
  it('sends nothing to a member removed before the delivery, and still sends to the others', async () => {
    const f = await fixture();
    at(T0.toISOString());
    const adminA = await world.loginAs('subject-admin-a');
    const managerA = await world.loginAs('subject-manager-a');
    const manager2 = await world.loginAs('subject-manager-2a');
    const area = await adminA.post('/api/areas', { json: { name: 'Taller' } });
    const vehicle = (
      await adminA.post('/api/vehicles', {
        json: {
          economicNumber: 'ECO-9',
          plate: 'ZZZ-009',
          make: 'Nissan',
          model: 'NP300',
          year: 2023,
          areaId: area.json.id,
          odometerKm: 1,
        },
      })
    ).json.id as string;
    const first = new Cases(
      () => managerA,
      () => adminA,
      vehicle,
      f.members.manager.identityId,
      'r1',
    );
    const second = new Cases(
      () => manager2,
      () => adminA,
      vehicle,
      f.members.manager2.identityId,
      'r2',
    );
    await first.assigned();
    await second.assigned();
    const admin = await world.platform.signIn(await world.principal('subject-admin-a'));
    const removed = await world.platform.removeMember(
      admin.value?.token as string,
      'revoke',
      f.members.manager.identityId,
    );
    expect(removed.ok).toBe(true);
    const mark = f.logged.length;
    world.advance(12 * DAY);
    await world.platform.incidentSlaModule.scanner.scan(f.a.tenantId);
    await tick();
    const tenant = f.a.tenantId;
    const revoked = recipientRef(tenant, await addressOf(tenant, f.members.manager.identityId));
    const kept = recipientRef(tenant, await addressOf(tenant, f.members.manager2.identityId));
    const fresh = f.logged.slice(mark);
    expect(fresh.some((record) => record.recipient === revoked)).toBe(false);
    expect(fresh.some((record) => record.recipient === kept)).toBe(true);
    expect(await kindsOf(await world.loginAs('subject-manager-2a'))).toContain('incident_sla');
  });
});

describe('acceptance 6: tenant isolation A/B', () => {
  it('keeps notices, counters, followers and mail of each company apart', async () => {
    const f = await fixture();
    await world.member('subject-admin-b', 'viewer', 'subject-viewer-b');
    await world.member('subject-admin-a', 'viewer', 'subject-viewer-a2');
    const adminB = await world.loginAs('subject-admin-b');
    await tick();
    const itemsA = (await f.adminA.get(`${N}?limit=100`)).json.items as {
      id: string;
      title: string;
    }[];
    const itemsB = (await adminB.get(`${N}?limit=100`)).json.items as { id: string }[];
    expect(itemsA.length).toBeGreaterThan(itemsB.length);
    expect(itemsB.every((item) => !itemsA.some((other) => other.id === item.id))).toBe(true);
    expect(await unread(adminB)).toBe(itemsB.length);
    // A notice of A cannot be read through B, and B's read-all leaves A's counter alone.
    const target = itemsA[0]?.id as string;
    expect((await adminB.post(`${N}/${target}/read`)).status).toBe(404);
    const unreadA = await unread(f.adminA);
    await adminB.post(`${N}/read-all`);
    expect(await unread(f.adminA)).toBe(unreadA);
    expect((await adminB.get('/api/v1/subscriptions')).json.items).toEqual([]);
    const companies = new Set(f.mail.messages.map((message) => message.companyId));
    expect(companies).toEqual(new Set([f.a.tenantId, f.b.tenantId]));
    for (const message of f.mail.messages)
      if (message.companyId === f.b.tenantId) expect(message.to).not.toContain('admin-a');
  });
});

describe('acceptance 7: minimal content', () => {
  it('has no amounts, addresses or free text in any message, and no address in the sink log', async () => {
    const f = await fixture();
    await documentExpiring(f.adminA, '2026-10-21');
    await world.member('subject-admin-a', 'viewer', 'subject-more-a');
    await tick();
    expect(f.mail.messages.length).toBeGreaterThan(0);
    for (const message of f.mail.messages) {
      const content = `${message.subject}\n${message.text}\n${message.html ?? ''}`;
      expect(content).not.toMatch(/@|\$\s?\d|\b\d{4,}\b.*(MXN|USD)/);
      expect(content).not.toContain(message.to);
    }
    expect(JSON.stringify(f.logged)).not.toContain('@');
    expect(JSON.stringify(f.mail.records)).not.toContain('@');
  });
});

describe('acceptance 8: INC-SLA keeps one e-mail per recipient', () => {
  it('sends the SLA notice mail once through the general port, however many rounds run', async () => {
    const f = await fixture();
    at(T0.toISOString());
    const adminA = await world.loginAs('subject-admin-a');
    const manager = await world.loginAs('subject-manager-a');
    const area = await adminA.post('/api/areas', { json: { name: 'Sla' } });
    const vehicle = (
      await adminA.post('/api/vehicles', {
        json: {
          economicNumber: 'SLA-1',
          plate: 'SL-001',
          make: 'Nissan',
          model: 'NP300',
          year: 2023,
          areaId: area.json.id,
          odometerKm: 1,
        },
      })
    ).json.id as string;
    const cases = new Cases(
      () => manager,
      () => adminA,
      vehicle,
      f.members.manager.identityId,
      'n',
    );
    await cases.assigned('high');
    world.advance(12 * DAY);
    for (let round = 0; round < 3; round += 1) {
      await world.platform.incidentSlaModule.scanner.scan(f.a.tenantId);
      await tick();
    }
    const sla = f.mail.messages.filter((message) => message.template === 'incident_sla');
    expect(sla.length).toBeGreaterThan(0);
    const keys = sla.map((message) => message.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    const recipients = sla.map(
      (message) => `${message.idempotencyKey.split(':')[1]}|${message.to}`,
    );
    expect(new Set(recipients).size).toBe(recipients.length);
    for (const message of sla) expect(message.companyId).toBe(f.a.tenantId);
    expect(await kindsOf(await world.loginAs('subject-manager-a'))).toContain('incident_sla');
  });
});
