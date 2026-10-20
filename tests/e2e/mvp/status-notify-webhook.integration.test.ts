import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from './world.js';

/**
 * Journey «cambio de estado de un vehículo → notificación → correo → webhook firmado» over two real
 * MySQL databases and the HTTP surface (MVP-INTEGRATE, alcance 3). A vehicle goes out of service: the
 * person who follows it gets the in-app notice and the e-mail of the sink, and the company's endpoint
 * gets a signed delivery on a local receiver. Nothing reaches company B. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

const HOOKS = `${API}/webhooks/endpoints`;
const URL_A = 'https://hooks.receiver-a.example.com/opslog';

suite('Journey: estado de vehículo → notificación + correo → webhook', { timeout: 180_000 }, () => {
  let w: MvpWorld;
  let vehicleId: string;
  let secret: string;
  let endpointId: string;
  beforeAll(async () => {
    w = await startMvpWorld();
    const created = await w.adminA.post(HOOKS, {
      json: { url: URL_A, events: ['vehicle.status_changed'] },
    });
    expect(created.status, created.text).toBe(201);
    secret = created.json.secret as string;
    endpointId = created.json.endpoint.id as string;
    // Company B subscribes too: its receiver must stay empty.
    const foreign = await w.adminB.post(HOOKS, {
      json: {
        url: 'https://hooks.receiver-b.example.com/opslog',
        events: ['vehicle.status_changed'],
      },
    });
    expect(foreign.status, foreign.text).toBe(201);
    const area = await w.area(w.adminA, 'Flota estado');
    vehicleId = await w.vehicle(w.adminA, area, 'ST1');
    // The viewer follows the vehicle (the «Seguir» button of the detail).
    const followed = await w.viewerA.put(`${API}/subscriptions/vehicle/${vehicleId}`);
    expect(followed.status, followed.text).toBeLessThan(300);
    await tick(w.platformA);
    await tick(w.platformB);
    w.receiverA.received.length = 0;
    w.mailA.messages.length = 0;
  }, 120_000);
  afterAll(async () => w?.stop(), 60_000);

  it('changes the status, which persists, audits and queues the events', async () => {
    const current = await w.adminA.get(`/api/vehicles/${vehicleId}`);
    const moved = await w.adminA.post(`/api/vehicles/${vehicleId}/status`, {
      json: {
        version: current.json.version,
        status: 'out_of_service',
        reason: 'Falla de motor del recorrido',
      },
    });
    expect(moved.status, moved.text).toBe(200);
    expect((await w.adminA.get(`/api/vehicles/${vehicleId}`)).json.status).toBe('out_of_service');
    await tick(w.platformA);
    await tick(w.platformA);
    await tick(w.platformB);
    const trail = await w.auditorA.get(`${API}/audit/entities/vehicle/${vehicleId}`);
    expect(trail.status, trail.text).toBe(200);
    expect(trail.json.items.length).toBeGreaterThanOrEqual(2);
  });

  it('gives the follower the in-app notice and the e-mail of the sink, without the free text', async () => {
    const list = await w.viewerA.get(`${API}/notifications?limit=100`);
    const notices = (
      list.json.items as { eventKind: string; link: string; title: string }[]
    ).filter((item) => item.eventKind === 'vehicle_out_of_service');
    expect(notices.length).toBe(1);
    expect(notices[0]?.link).toContain(vehicleId);
    expect(JSON.stringify(notices)).not.toContain('Falla de motor');
    expect((await w.viewerA.get(`${API}/notifications/unread-count`)).json.unread).toBeGreaterThan(
      0,
    );

    const mail = w.mailA.messages.filter(
      (message) => message.template === 'vehicle_out_of_service',
    );
    expect(mail.length).toBeGreaterThan(0);
    expect(JSON.stringify(mail)).not.toContain('Falla de motor');
    expect(w.mailA.messages.every((message) => message.companyId === w.tenantA)).toBe(true);
    expect(w.mailB.messages.filter((m) => m.template === 'vehicle_out_of_service')).toEqual([]);
  });

  it('delivers one signed event to the local receiver with the identity of the vehicle only', async () => {
    expect(w.receiverA.received).toHaveLength(1);
    expect(w.receiverA.verify(0, secret)).toMatchObject({ ok: true });
    // A different secret or a tampered body does not verify.
    expect(w.receiverA.verify(0, 'whsec_otro')).toEqual({ ok: false, reason: 'bad_signature' });
    const body = JSON.parse(w.receiverA.bodyOf(0)) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain(vehicleId);
    expect(JSON.stringify(body)).not.toMatch(/Falla de motor|licen|@/i);
    const history = await w.adminA.get(`${HOOKS}/${endpointId}/deliveries`);
    expect(history.json.items[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(JSON.stringify(history.json)).not.toContain(secret);
  });

  it('keeps company B out of it', async () => {
    expect(w.receiverB.received).toEqual([]);
    const foreign = await w.viewerB.get(`${API}/notifications?limit=100`);
    expect(JSON.stringify(foreign.json)).not.toContain(vehicleId);
    expect((await w.adminB.get(`${HOOKS}/${endpointId}`)).status).toBe(404);
    expect((await w.viewerA.get(`${HOOKS}/${endpointId}`)).status).toBe(403);
  });
});
