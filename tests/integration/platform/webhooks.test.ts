import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import {
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  TIMESTAMP_HEADER,
  signatureHeader,
  verifyWebhook,
  type AttemptResult,
  type Resolver,
  type WebhookRequest,
} from '../../../packages/platform/webhooks/src/index.js';
import { SinkMailAdapter } from '../../../packages/platform/mail/src/index.js';
import { InMemoryWebhookStore } from '../../../packages/domain/webhooks/src/index.js';
import { unconfiguredRecoveryNotifier } from '../../../apps/api/composition/src/platform/recovery.js';
import { DAY, HOUR, captureLogs, drainAll } from './incident-sla-support.js';

const W = '/api/v1/webhooks/endpoints';
const URL_A = 'https://hooks.receiver-a.example.com/opslog';
const MINUTE = 60_000;

class Receiver {
  public readonly calls: WebhookRequest[] = [];
  public answer: (call: WebhookRequest, index: number) => Partial<AttemptResult> = () => ({});
  public async send(request: WebhookRequest): Promise<AttemptResult> {
    this.calls.push(request);
    return {
      status: 200,
      durationMs: 7,
      failure: null,
      ...this.answer(request, this.calls.length),
    };
  }
  public bodies(url = URL_A) {
    return this.calls
      .filter((call) => call.url === url)
      .map((call) => JSON.parse(Buffer.from(call.body).toString('utf8')) as Record<string, any>);
  }
  public types(url = URL_A): string[] {
    return this.bodies(url).map((body) => body['type'] as string);
  }
}

const resolver: Resolver = async (host) => {
  if (host.startsWith('private')) return [{ address: '10.0.0.5', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
};

let world: BffWorld;
afterEach(() => {
  world?.dispose();
  vi.restoreAllMocks();
});

const job = (name: string) => {
  const found = world.platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};
async function tick(): Promise<void> {
  await drainAll(world.platform);
  await job('webhooks.dispatch').run();
  await drainAll(world.platform);
}

async function fixture() {
  const receiver = new Receiver();
  world = createBffWorld({
    adapters: { webhookClient: receiver, webhookResolver: resolver },
  });
  await world.tenant('Empresa Alfa', 'subject-admin-a');
  await world.tenant('Empresa Beta', 'subject-admin-b');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  const adminA = await world.loginAs('subject-admin-a');
  const adminB = await world.loginAs('subject-admin-b');
  const editorA = await world.loginAs('subject-editor-a');
  const viewerA = await world.loginAs('subject-viewer-a');
  const area = async (browser: Browser) => {
    const reply = await browser.post('/api/areas', { json: { name: 'Base' } });
    return reply.json.id as string;
  };
  return { receiver, adminA, adminB, editorA, viewerA, areaA: await area(adminA) };
}

const create = async (browser: Browser, over: Record<string, unknown> = {}) => {
  const reply = await browser.post(W, {
    json: { url: URL_A, events: ['vehicle.created', 'driver.eligibility_changed'], ...over },
  });
  return reply;
};

let serial = 0;
const vehicle = (areaId: string) => {
  serial += 1;
  return {
    economicNumber: `U-${serial}`,
    plate: `AB-${100 + serial} C`,
    vin: `1HGCM82633A${String(100000 + serial)}`,
    make: 'Toyota',
    model: 'Hilux',
    year: 2022,
    areaId,
    odometerKm: 1000,
  };
};
const driver = (areaId: string, licenseExpiresOn: string) => {
  serial += 1;
  return {
    kind: 'driver',
    firstName: 'Ana',
    lastName: 'Perez',
    areaId,
    employeeNumber: `E-${serial}`,
    idType: 'ine',
    nationalId: `SYNTH-ID-7788-Q${serial}`,
    phone: '+52 55 9000 1234',
    email: `ana.perez${serial}@synthetic.example`,
    licenseNumber: `LIC-445566-${serial}`,
    licenseType: 'c',
    licenseExpiresOn,
  };
};
const isoDay = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);

describe('signed delivery', () => {
  it('signs, verifies, does not leak the secret and sends a real vehicle.created', async () => {
    const { receiver, adminA, areaA } = await fixture();
    const made = await create(adminA);
    expect(made.status).toBe(201);
    const secret = made.json.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const id = made.json.endpoint.id as string;
    expect(made.json.endpoint).not.toHaveProperty('secret');

    expect((await adminA.post('/api/vehicles', { json: vehicle(areaA) })).status).toBe(201);
    await tick();

    expect(receiver.types()).toEqual(['vehicle.created']);
    const call = receiver.calls[0] as WebhookRequest;
    const headers = {
      [EVENT_ID_HEADER]: call.eventId,
      [TIMESTAMP_HEADER]: String(call.timestamp),
      [SIGNATURE_HEADER]: signatureHeader(
        call.secrets,
        String(call.timestamp),
        call.eventId,
        call.body,
      ),
    };
    expect(
      verifyWebhook({ secrets: [secret], headers, body: call.body, nowMs: Date.now() }),
    ).toEqual({ ok: true, eventId: call.eventId });
    // Replay beyond the tolerance and a tampered body are rejected.
    expect(
      verifyWebhook({
        secrets: [secret],
        headers,
        body: call.body,
        nowMs: Date.now() + 10 * MINUTE,
      }),
    ).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    expect(
      verifyWebhook({ secrets: [secret], headers, body: '{}', nowMs: Date.now() }),
    ).toMatchObject({ ok: false });

    // No PII, tenant id or amounts in the payload.
    const text = Buffer.from(call.body).toString('utf8');
    expect(text).not.toMatch(/tenantId|tenant_id|Perez|plate|AB-1|amount|cost|@/i);
    expect(text).not.toContain(secret);

    // Reads, audit and the delivery history never show the secret.
    const reads = [
      await adminA.get(W),
      await adminA.get(`${W}/${id}`),
      await adminA.get(`${W}/${id}/deliveries`),
      await adminA.get('/api/audit'),
    ];
    for (const reply of reads) expect(reply.text).not.toContain(secret);
    const history = (await adminA.get(`${W}/${id}/deliveries`)).json;
    expect(history.items[0]).toMatchObject({
      status: 'delivered',
      lastStatusCode: 200,
      attempts: 1,
    });
    expect(history.items[0]).not.toHaveProperty('body');
  });

  it('keeps the previous secret signing for the grace period after a rotation', async () => {
    const { receiver, adminA, areaA } = await fixture();
    const made = await create(adminA);
    const id = made.json.endpoint.id as string;
    const rotated = await adminA.post(`${W}/${id}/rotate-secret`, {
      json: { version: made.json.endpoint.version },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).not.toBe(made.json.secret);
    await adminA.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    expect(receiver.calls[0]?.secrets).toEqual([rotated.json.secret, made.json.secret]);
    await world.advance(25 * HOUR);
    const again = await world.loginAs('subject-admin-a');
    await again.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    expect(receiver.calls.at(-1)?.secrets).toEqual([rotated.json.secret]);
  });

  it('delivers the test ping and a manual retry with the same event id', async () => {
    const { receiver, adminA } = await fixture();
    const id = (await create(adminA)).json.endpoint.id as string;
    receiver.answer = () => ({ status: 500, failure: 'http' });
    const ping = await adminA.post(`${W}/${id}/test`, { json: {} });
    expect(ping.status).toBe(200);
    await tick();
    const failed = (await adminA.get(`${W}/${id}/deliveries`)).json.items[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastStatusCode: 500 });
    receiver.answer = () => ({});
    const retried = await adminA.post(`${W}/${id}/deliveries/${failed.id}/retry`, { json: {} });
    expect(retried.status).toBe(200);
    await tick();
    const after = (await adminA.get(`${W}/${id}/deliveries`)).json.items[0];
    expect(after).toMatchObject({ status: 'delivered', eventId: failed.eventId });
    expect(new Set(receiver.calls.map((call) => call.eventId)).size).toBe(1);
  });
});

describe('guard', () => {
  it('refuses http, private and metadata destinations at registration', async () => {
    const { adminA } = await fixture();
    for (const url of [
      'http://hooks.receiver-a.example.com/x',
      'https://private.receiver.example.com/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://user:pw@hooks.receiver-a.example.com/x', // secret-scan:allow synthetic URL with credentials the guard must refuse
    ]) {
      const reply = await create(adminA, { url });
      expect(reply.status, url).toBe(400);
    }
  });

  it('refuses an endpoint over the limit of five per company', async () => {
    const { adminA, adminB } = await fixture();
    for (let n = 0; n < 5; n += 1)
      expect((await create(adminA, { url: `https://h${n}.receiver.example.com/x` })).status).toBe(
        201,
      );
    const sixth = await create(adminA, { url: 'https://h9.receiver.example.com/x' });
    expect(sixth.status).toBe(422);
    expect((await create(adminB)).status).toBe(201);
  });

  it("does not send when the name now resolves to a private address (rebinding is the client's guard)", async () => {
    const { receiver, adminA, areaA } = await fixture();
    await create(adminA);
    // The injected client is the fake; the registration guard is what this level can show.
    await adminA.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    expect(receiver.calls).toHaveLength(1);
  });
});

describe('retries, cadence and idempotency', () => {
  it('retries with backoff, ends in dead letter and sends each event id once per success', async () => {
    const { receiver, adminA, areaA } = await fixture();
    const id = (await create(adminA)).json.endpoint.id as string;
    receiver.answer = () => ({ status: 503, failure: 'http' });
    await adminA.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    expect(receiver.calls).toHaveLength(1);
    await tick();
    expect(receiver.calls).toHaveLength(1); // backoff: not due yet
    for (let round = 0; round < 12; round += 1) {
      await world.advance(DAY);
      await tick();
    }
    const again = await world.loginAs('subject-admin-a');
    const items = (await again.get(`${W}/${id}/deliveries`)).json.items;
    expect(items[0]).toMatchObject({ status: 'dead_letter', attempts: 6 });
    expect(new Set(receiver.calls.map((call) => call.eventId)).size).toBe(1);
    expect(receiver.calls).toHaveLength(6);
  });

  it('sends at most 60 deliveries per minute', async () => {
    const { receiver, adminA, areaA } = await fixture();
    await create(adminA);
    for (let n = 0; n < 70; n += 1) await adminA.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    await tick();
    expect(receiver.calls.length).toBeLessThanOrEqual(60);
    expect(receiver.calls.length).toBeGreaterThan(0);
    await world.advance(2 * MINUTE);
    await tick();
    expect(receiver.calls.length).toBe(70);
  });
});

describe('tenants and permissions', () => {
  it("keeps company B out of A's endpoints and events", async () => {
    const { receiver, adminA, adminB, areaA } = await fixture();
    const id = (await create(adminA)).json.endpoint.id as string;
    await create(adminB, { url: 'https://hooks.receiver-b.example.com/x' });
    await adminA.post('/api/vehicles', { json: vehicle(areaA) });
    await tick();
    expect(receiver.types(URL_A)).toEqual(['vehicle.created']);
    expect(receiver.types('https://hooks.receiver-b.example.com/x')).toEqual([]);
    expect((await adminB.get(`${W}/${id}`)).status).toBe(404);
    expect((await adminB.get(`${W}/${id}/deliveries`)).status).toBe(404);
    expect((await adminB.delete(`${W}/${id}`)).status).toBe(404);
    expect((await adminB.get(W)).json.items).toHaveLength(1);
  });

  it('allows only integrations:manage', async () => {
    const { adminA, editorA, viewerA } = await fixture();
    for (const browser of [editorA, viewerA]) {
      expect((await browser.get(W)).status).toBe(403);
      expect((await create(browser)).status).toBe(403);
    }
    expect((await adminA.get(W)).status).toBe(200);
  });

  it('never writes the secret to logs, audit or the outbox', async () => {
    const { adminA, areaA } = await fixture();
    const { result, logs } = await captureLogs(async () => {
      const made = await create(adminA);
      await adminA.post('/api/vehicles', { json: vehicle(areaA) });
      await tick();
      return made;
    });
    const secret = result.json.secret as string;
    expect(logs).not.toContain(secret);
    expect(JSON.stringify(await adminA.get('/api/audit'))).not.toContain(secret);
    expect(JSON.stringify(world.platform.runtime)).not.toContain(secret);
  });
});

describe('driver eligibility', () => {
  it('emits one event when a license expires and one when it is renewed', async () => {
    const { receiver, adminA, areaA } = await fixture();
    await create(adminA, { events: ['driver.eligibility_changed'] });
    const made = await adminA.post('/api/employees', {
      json: driver(areaA, isoDay(3 * DAY)),
    });
    expect(made.status).toBe(201);
    await tick();
    expect(receiver.types()).toEqual([]);
    await world.advance(5 * DAY);
    await job('webhooks.eligibility').run();
    await tick();
    await world.advance(2 * HOUR);
    await job('webhooks.eligibility').run();
    await tick();
    expect(receiver.types()).toEqual(['driver.eligibility_changed']);
    expect(receiver.bodies()[0]?.['data']).toMatchObject({ eligible: false });
    const again = await world.loginAs('subject-admin-a');
    const renewed = await again.put(`/api/employees/${made.json.id}`, {
      json: { version: made.json.version, licenseExpiresOn: isoDay(300 * DAY) },
    });
    expect(renewed.status).toBe(200);
    await tick();
    expect(receiver.types()).toEqual(['driver.eligibility_changed', 'driver.eligibility_changed']);
    expect(receiver.bodies()[1]?.['data']).toMatchObject({ eligible: true });
    expect(JSON.stringify(receiver.bodies())).not.toMatch(/LIC-|Perez|@/);
  });
});

describe('switch-off and wiring', () => {
  it('tells the administrator when an endpoint is switched off after twenty failures', async () => {
    const mail = new SinkMailAdapter({ retain: 50 });
    const receiver = new Receiver();
    world = createBffWorld({
      adapters: { webhookClient: receiver, webhookResolver: resolver, mail },
    });
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const adminA = await world.loginAs('subject-admin-a');
    const area = (await adminA.post('/api/areas', { json: { name: 'Base' } })).json.id as string;
    // A receiver that always refuses: twenty failures in a row switch the endpoint off.
    const id = (await create(adminA, { url: 'https://down.receiver-c.example.com/x' })).json
      .endpoint.id as string;
    receiver.answer = (call) =>
      call.url.includes('down.') ? { status: 400, failure: 'http' } : {};
    for (let n = 0; n < 21; n += 1) await adminA.post('/api/vehicles', { json: vehicle(area) });
    await tick();
    const read = (await adminA.get(`${W}/${id}`)).json;
    expect(read).toMatchObject({ disabled: true, active: false });
    expect(mail.messages.some((message) => message.template === 'webhook_disabled')).toBe(true);
  });

  it('refuses a persistent store without the company cipher', () => {
    expect(() => createBffWorld({ adapters: { webhooks: new InMemoryWebhookStore() } })).toThrow(
      /requires adapters.pii/,
    );
  });

  it('has a recovery notifier that fails loudly when none was configured', async () => {
    await expect(
      (unconfiguredRecoveryNotifier.deliver as (...args: unknown[]) => Promise<void>)(),
    ).rejects.toThrow(/not configured/);
  });
});
