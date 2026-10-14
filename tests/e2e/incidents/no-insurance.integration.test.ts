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
});
