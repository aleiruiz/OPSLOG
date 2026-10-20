import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from './world.js';

/**
 * Journey «siniestro → historial de audit con diff restringido» over two real MySQL databases and the
 * HTTP surface (MVP-INTEGRATE, alcance 3). A case is reported and costed; its audit history is read by
 * who may read audit and incidents, and neither the free text nor an amount reaches someone without
 * `incidents:view_costs`. Company B finds nothing. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

const P = `${API}/incidents`;
const FREE_TEXT = 'Texto libre sintético del siniestro';
const AMOUNT = '7777701';

suite('Journey: siniestro → historial de audit', { timeout: 180_000 }, () => {
  let w: MvpWorld;
  let incidentId: string;
  beforeAll(async () => {
    w = await startMvpWorld();
    const area = await w.area(w.adminA, 'Flota siniestros');
    const vehicleId = await w.vehicle(w.adminA, area, 'IA1');
    let key = 0;
    const keyed = () => ({ 'idempotency-key': `mvp-incident-key-${(key += 1)}` });
    const created = await w.managerA.post(P, {
      json: {
        vehicleId,
        type: 'collision',
        severity: 'medium',
        occurredAt: new Date().toISOString(),
        location: { text: FREE_TEXT },
        description: FREE_TEXT,
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
      },
    });
    expect(created.status, created.text).toBe(201);
    incidentId = created.json.id as string;
    let version = created.json.version as number;
    const go = async (json: Record<string, unknown>) => {
      const reply = await w.managerA.post(`${P}/${incidentId}/transitions`, {
        json: { version, ...json },
        headers: keyed(),
      });
      expect(reply.status, reply.text).toBe(200);
      version = reply.json.version as number;
    };
    await go({ command: 'report' });
    await go({ command: 'assign', responsibleId: w.managerAId });
    await go({ command: 'review' });
    const costed = await w.managerA.put(`${P}/${incidentId}/costs`, {
      json: {
        version,
        lines: [
          { kind: 'expense', category: 'repair', amount: { amountMinor: AMOUNT, currency: 'MXN' } },
        ],
      },
      headers: keyed(),
    });
    expect(costed.status, costed.text).toBe(200);
    await tick(w.platformA);
    await tick(w.platformA);
  }, 120_000);
  afterAll(async () => w?.stop(), 60_000);

  const history = (browser: MvpWorld['adminA']) =>
    browser.get(`${API}/audit/entities/incident/${incidentId}?limit=100`);

  it('records every step of the case in its audit history, newest first', async () => {
    const reply = await history(w.adminA);
    expect(reply.status, reply.text).toBe(200);
    const items = reply.json.items as { entityType: string; entityId: string; action: string }[];
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(
      items.every((item) => item.entityType === 'incident' && item.entityId === incidentId),
    ).toBe(true);
    const times = (reply.json.items as { occurredAt: string }[]).map((item) => item.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('shows no free text and no amount to someone who reads the audit but not the costs', async () => {
    const reply = await history(w.incidentAuditorA);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json.items.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(reply.json);
    expect(text).not.toContain(FREE_TEXT);
    expect(text).not.toContain(AMOUNT);
    expect(text).not.toMatch(/amountMinor/);
    // The general list obeys the same rule.
    const list = await w.incidentAuditorA.get(`${API}/audit?limit=100`);
    expect(list.status, list.text).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(AMOUNT);
    expect(JSON.stringify(list.json)).not.toContain(FREE_TEXT);
  });

  it('keeps free text and amounts out of what the administrator reads too, and out of the stores', async () => {
    const text = (await history(w.adminA)).text;
    expect(text).not.toContain(FREE_TEXT);
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await w.database.rows(`SELECT * FROM ${table}`));
      expect(dump, table).not.toContain(FREE_TEXT);
      expect(dump, table).not.toContain(AMOUNT);
    }
  });

  it('refuses the history to who cannot read incidents or the audit, and to company B', async () => {
    // `view_audit` without `incidents:view` does not open a module's records through the audit.
    expect((await history(w.auditorA)).status).toBe(403);
    expect((await history(w.viewerA)).status).toBe(403);
    expect((await history(w.managerA)).status).toBe(403);
    const foreign = await history(w.adminB);
    expect(foreign.status, foreign.text).toBe(200);
    expect(foreign.json.items).toEqual([]);
    expect(JSON.stringify((await w.adminB.get(`${API}/audit?limit=100`)).json)).not.toContain(
      incidentId,
    );
  });
});
