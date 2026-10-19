import type { Browser } from '../../../apps/api/bff/src/test-support.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { journeySteps, type JourneySteps } from './steps.js';
import { P, W, startIncidentsWorld, type IncidentsWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const DESCRIPTION = 'Reparación de defensa sintética';

suite('journey 3: no insurance, a repair order created once and linked (MySQL)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
  }, 180_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  it('creates the corrective order once however many times the same request is sent, and links it', async () => {
    const review = await s.underReview({ policyId: null, type: 'other' });
    const decided = await s.put(w.manager, review.id, 'insurance', review.version, {
      noInsuranceReason: 'Sin póliza sintética',
    });
    const noInsurance = await s.step(w.manager, review.id, decided.version, 'no_insurance');
    const refusal = await s.go(w.manager, review.id, {
      command: 'repair',
      version: noInsurance.version,
    });
    expect(refusal.json.missingRequirements).toEqual(
      expect.arrayContaining(['repair_order_or_budget', 'cost_assumed']),
    );

    // The manager links orders but does not create them: the fleet administrator does, from the sheet.
    // The same request, retried after a lost answer or by a second click, is one order.
    const headers = w.key();
    const body = { vehicleId: w.vehicleA, description: DESCRIPTION };
    const replies = await Promise.all([
      w.adminA.post(W, { json: body, headers }),
      w.adminA.post(W, { json: body, headers }),
    ]);
    const again = await w.adminA.post(W, { json: body, headers });
    expect([...replies, again].map((reply) => reply.status)).toEqual([201, 201, 201]);
    const orderId = again.json.id as string;
    expect(new Set([...replies, again].map((reply) => reply.json.id))).toEqual(new Set([orderId]));
    expect(
      await w.database.rows('SELECT id FROM opslog_maintenance_work_orders WHERE description = ?', [
        DESCRIPTION,
      ]),
    ).toHaveLength(1);
    // Another body under the same key is a conflict, never a second order.
    const clash = await w.adminA.post(W, {
      json: { ...body, description: 'Otra descripción sintética' },
      headers,
    });
    expect([clash.status, clash.json.code]).toEqual([409, 'idempotency_conflict']);
    // A request without a key keeps working and makes its own order.
    const plain = await w.adminA.post(W, { json: body });
    expect(plain.status).toBe(201);
    expect(plain.json.id).not.toBe(orderId);

    const linked = await w.manager.post(`${P}/${review.id}/repairs`, {
      json: { version: noInsurance.version, orderId },
      headers: w.key(),
    });
    expect(linked.status, linked.text).toBe(200);
    const assumed = await s.put(w.manager, review.id, 'resolution', linked.json.version, {
      costAssumed: true,
    });
    const repair = await s.step(w.manager, review.id, assumed.version, 'repair');
    expect((await s.read(w.manager, review.id)).status).toBe('repair');
    // With an order in repair the case cannot be cancelled while the order stands.
    const cancel = await s.go(w.manager, review.id, {
      command: 'cancel',
      version: repair.version,
      reason: 'Motivo sintético',
    });
    expect(cancel.json.missingRequirements).toEqual(expect.arrayContaining(['no_repairs']));
  });

  it('resolves and closes a case without an insurer or an order when the company assumes the cost', async () => {
    const review = await s.underReview({ policyId: null, type: 'other' });
    const decided = await s.put(w.manager, review.id, 'insurance', review.version, {
      noInsuranceReason: 'Sin póliza sintética',
    });
    const noInsurance = await s.step(w.manager, review.id, decided.version, 'no_insurance');
    const assumed = await s.put(w.manager, review.id, 'resolution', noInsurance.version, {
      costAssumed: true,
      resolutionSummary: 'Resuelto sin aseguradora de forma sintética',
      vehicleStatusDecision: 'active',
    });
    const resolved = await s.step(w.manager, review.id, assumed.version, 'resolve');
    await s.step(w.supervisor, review.id, resolved.version, 'close', {}, true);
    expect((await s.read(w.manager, review.id)).status).toBe('closed');
    const lost = await w.database.rows(
      'SELECT 1 FROM opslog_incident_closures WHERE incident_id = ?',
      [review.id],
    );
    expect(lost).toHaveLength(1);
    await s.expectNoLeak([DESCRIPTION, 'Sin póliza sintética']);
  });

  it('walks repair to a completed and closed order, final evidence, resolve from repair and close (acceptance 11)', async () => {
    const review = await s.underReview({ policyId: null, type: 'other' });
    const decided = await s.put(w.manager, review.id, 'insurance', review.version, {
      noInsuranceReason: 'Sin póliza sintética',
    });
    const noInsurance = await s.step(w.manager, review.id, decided.version, 'no_insurance');

    // A real corrective order, driven by its mechanic up to the amounts the case reads live.
    const mechanicMember = await w.worldA.member('subject-admin-a', 'viewer', 'subject-mech-rp');
    const mechanicBrowser = await w.worldA.loginAs('subject-mech-rp');
    const workshop = await w.adminA.post('/api/v1/maintenance/workshops', {
      json: { name: 'Taller Reparación', specialties: ['frenos'] },
    });
    const mechanic = await w.adminA.post('/api/v1/maintenance/mechanics', {
      json: {
        name: 'Mecánico Reparación',
        specialties: ['frenos'],
        kind: 'internal',
        workshopId: workshop.json.id,
        memberId: mechanicMember.identityId,
      },
    });
    expect(mechanic.status, mechanic.text).toBe(201);
    const created = await w.adminA.post(W, {
      json: { vehicleId: w.vehicleA, description: 'Reparación de frenos sintética' },
    });
    const orderId = created.json.id as string;
    const order = async (browser: Browser, json: Record<string, unknown>) =>
      s.ok(
        await browser.post(`${W}/${orderId}/transitions`, {
          json,
          ...(json['command'] === 'close' ? { headers: w.key() } : {}),
        }),
      ).json;
    const linked = s.ok(
      await w.manager.post(`${P}/${review.id}/repairs`, {
        json: { version: noInsurance.version, orderId },
        headers: w.key(),
      }),
    );
    const assumed = await s.put(w.manager, review.id, 'resolution', linked.json.version, {
      costAssumed: true,
    });
    const inRepair = await s.step(w.manager, review.id, assumed.version, 'repair');
    expect((await s.read(w.manager, review.id)).status).toBe('repair');
    const summary = await s.put(w.manager, review.id, 'resolution', inRepair.version, {
      resolutionSummary: 'Reparado de forma sintética',
      vehicleStatusDecision: 'restricted',
    });

    // With the order still open: no finished order, no cost on it and no final evidence.
    const open = await s.go(w.manager, review.id, { command: 'resolve', version: summary.version });
    expect([open.status, open.json.missingRequirements]).toEqual([
      422,
      expect.arrayContaining(['repair_orders_finished', 'repair_costs', 'final_evidence']),
    ]);

    const assigned = await order(w.adminA, {
      command: 'assign',
      version: 1,
      responsibleId: w.managerId,
      workshopId: workshop.json.id,
      mechanicId: mechanic.json.id,
      scheduledDate: '2026-10-13',
    });
    const started = await order(mechanicBrowser, { command: 'start', version: assigned.version });
    const worked = s.ok(
      await mechanicBrowser.put(`${W}/${orderId}/work`, {
        json: {
          version: started.version,
          tasks: [{ description: 'Cambio de balatas' }],
          parts: [{ name: 'Balata', quantity: '4' }],
        },
      }),
    );
    const costed = s.ok(
      await w.adminA.put(`${W}/${orderId}/costs`, {
        json: {
          version: worked.json.version,
          costs: [{ category: 'labor', amount: { amountMinor: '400000', currency: 'MXN' } }],
        },
      }),
    );
    const completed = await order(w.adminA, {
      command: 'complete',
      version: costed.json.version,
      actualDate: s.today(),
      actualKm: 120,
    });
    expect(completed.status).toBe('completed');

    // Completed, with its cost, but no final evidence yet: only that is missing.
    const noPhoto = await s.go(w.manager, review.id, {
      command: 'resolve',
      version: summary.version,
    });
    expect([noPhoto.status, noPhoto.json.missingRequirements]).toEqual([422, ['final_evidence']]);

    // A photo in quarantine does not count; the scan clears it.
    const photo = await s.evidence(w.manager, review.id, summary.version, 'photo', 'post_repair');
    const quarantined = await s.go(w.manager, review.id, {
      command: 'resolve',
      version: photo.version,
    });
    expect(quarantined.json.missingRequirements).toEqual(['final_evidence']);
    await s.scan();
    const resolved = await s.step(w.manager, review.id, photo.version, 'resolve');
    expect((await s.read(w.manager, review.id)).status).toBe('resolved');

    // A completed order is not a closed one: closing the case waits for the workshop to close it.
    const early = await s.go(
      w.supervisor,
      review.id,
      { command: 'close', version: resolved.version },
      true,
    );
    expect([early.status, early.json.missingRequirements]).toEqual([422, ['repair_orders_closed']]);
    await order(w.adminA, {
      command: 'close',
      version: completed.version,
      vehicleStatus: 'restricted',
    });
    await s.step(w.supervisor, review.id, resolved.version, 'close', {}, true);
    expect((await s.read(w.manager, review.id)).status).toBe('closed');

    // The snapshot of the closure holds the order and its amount.
    const snapshot = await w.database.rows<{ totals: unknown }>(
      'SELECT totals FROM opslog_incident_cost_snapshots WHERE incident_id = ?',
      [review.id],
    );
    expect(snapshot).toHaveLength(1);
    expect(JSON.stringify(snapshot[0]?.totals)).toContain('400000');
    const closure = await w.database.rows(
      'SELECT * FROM opslog_incident_closures WHERE incident_id = ?',
      [review.id],
    );
    expect(closure).toHaveLength(1);
    expect(JSON.stringify(closure)).toContain(orderId);
    await s.expectNoLeak(['Reparado de forma sintética', 'Reparación de frenos sintética']);
  });
});
