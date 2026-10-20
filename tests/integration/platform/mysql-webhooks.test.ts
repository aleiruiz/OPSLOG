import { afterAll, describe, expect, it, vi } from 'vitest';
import { WEBHOOK_TABLES as T } from '../../../packages/persistence/webhooks/src/index.js';
import type {
  AttemptResult,
  Resolver,
  WebhookRequest,
} from '../../../packages/platform/webhooks/src/index.js';
import type { Platform } from '../../../apps/api/composition/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../../e2e/fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../../e2e/fleet/world.js';
import { T0, drainAll } from './incident-sla-support.js';

/**
 * Outgoing webhooks on two real MySQL databases (one per company, each with its own restricted
 * runtime accounts): endpoints sealed at rest, deliveries, tenant isolation and the retry path.
 * Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;

const W = '/api/v1/webhooks/endpoints';
const URL_A = 'https://hooks.receiver-a.example.com/opslog';
const opened: { database: FleetDatabase; fleet: FleetWorld }[] = [];
afterAll(async () => {
  for (const { database, fleet } of opened) {
    fleet.world.dispose();
    await database.close();
  }
}, 120_000);

class Receiver {
  public readonly calls: WebhookRequest[] = [];
  public status = 200;
  public async send(request: WebhookRequest): Promise<AttemptResult> {
    this.calls.push(request);
    return this.status < 300
      ? { status: this.status, durationMs: 5, failure: null }
      : { status: this.status, durationMs: 5, failure: 'http' };
  }
}
const resolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

async function start() {
  const receiverA = new Receiver();
  const receiverB = new Receiver();
  const database = await startFleetDatabase();
  const fleet = await startFleetWorld(database, {
    a: { webhookClient: receiverA, webhookResolver: resolver },
    b: { webhookClient: receiverB, webhookResolver: resolver },
  });
  opened.push({ database, fleet });
  vi.setSystemTime(T0);
  return { database, fleet, receiverA, receiverB };
}

const job = (platform: Platform, name: string) => {
  const found = platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};
async function tick(platform: Platform): Promise<void> {
  await drainAll(platform);
  await job(platform, 'webhooks.dispatch').run();
  await drainAll(platform);
}

suite('Webhooks on real MySQL', { timeout: 120_000 }, () => {
  it('seals the secret, delivers per company and keeps the tenants apart', async () => {
    const { database, fleet, receiverA, receiverB } = await start();
    const adminA = await fleet.worldA.loginAs('subject-admin-a');
    const adminB = await fleet.worldB.loginAs('subject-admin-b');
    const made = await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } });
    expect(made.status, made.text).toBe(201);
    const secret = made.json.secret as string;
    const id = made.json.endpoint.id as string;
    await adminB.post(W, {
      json: { url: 'https://hooks.receiver-b.example.com/x', events: ['vehicle.created'] },
    });

    const area = await fleet.area(adminA);
    await fleet.vehicle(adminA, area, 'W1');
    await tick(fleet.platformA);
    await tick(fleet.platformB);

    expect(receiverA.calls).toHaveLength(1);
    expect(receiverA.calls[0]?.secrets).toEqual([secret]);
    expect(receiverB.calls).toHaveLength(0);

    // The secret is stored sealed: nowhere in the tables, in clear.
    const dump = JSON.stringify([
      await database.rows(`SELECT * FROM \`${T.endpoints}\``),
      await database.rows(`SELECT * FROM \`${T.deliveries}\``),
    ]);
    expect(dump).not.toContain(secret);
    const rows = await database.rows<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM \`${T.endpoints}\``,
    );
    expect(rows).toEqual([{ company_id: fleet.tenantA }]);

    expect((await adminB.get(`${W}/${id}`)).status).toBe(404);
    const history = (await adminA.get(`${W}/${id}/deliveries`)).json;
    expect(history.items[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(JSON.stringify(history)).not.toContain(secret);
  });

  it('records a failure, keeps the event id on retry and refuses the sixth endpoint', async () => {
    const { fleet, receiverA } = await start();
    const adminA = await fleet.worldA.loginAs('subject-admin-a');
    const id = (await adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } })).json
      .endpoint.id as string;
    receiverA.status = 500;
    await adminA.post(`${W}/${id}/test`, { json: {} });
    await tick(fleet.platformA);
    const failed = (await adminA.get(`${W}/${id}/deliveries`)).json.items[0];
    expect(failed).toMatchObject({ lastStatusCode: 500, attempts: 1 });
    receiverA.status = 200;
    expect(
      (await adminA.post(`${W}/${id}/deliveries/${failed.id}/retry`, { json: {} })).status,
    ).toBe(200);
    await tick(fleet.platformA);
    const done = (await adminA.get(`${W}/${id}/deliveries`)).json.items[0];
    expect(done).toMatchObject({ status: 'delivered', eventId: failed.eventId });

    for (let n = 0; n < 4; n += 1)
      expect(
        (
          await adminA.post(W, {
            json: { url: `https://h${n}.receiver.example.com/x`, events: ['vehicle.created'] },
          })
        ).status,
      ).toBe(201);
    const sixth = await adminA.post(W, {
      json: { url: 'https://h9.receiver.example.com/x', events: ['vehicle.created'] },
    });
    expect(sixth.status).toBe(422);
  });
});
