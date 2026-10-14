import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { journeySteps, FREE_TEXT, type Case, type JourneySteps } from './steps.js';
import { P, startIncidentsWorld, type IncidentsWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const REASON = 'Motivo libre sintético de la reapertura';
const DAY = 24 * 3_600_000;

suite('journey 5: reopening a closed case into a second cycle (MySQL)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
  }, 180_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  async function closed(): Promise<Case> {
    const review = await s.underReview({ policyId: null, type: 'other' });
    const decided = await s.put(w.manager, review.id, 'insurance', review.version, {
      noInsuranceReason: 'Sin póliza sintética',
    });
    const noInsurance = await s.step(w.manager, review.id, decided.version, 'no_insurance');
    const assumed = await s.put(w.manager, review.id, 'resolution', noInsurance.version, {
      costAssumed: true,
      resolutionSummary: 'Primer cierre sintético',
      vehicleStatusDecision: 'active',
    });
    const resolved = await s.step(w.manager, review.id, assumed.version, 'resolve');
    return s.step(w.manager, review.id, resolved.version, 'close', {}, true);
  }

  it('lets only who holds incidents:reopen reopen, asks a reason, replays by key and keeps the first cycle intact', async () => {
    const start = await closed();
    await w.advance(10 * DAY);
    for (const browser of [w.manager, w.reporter]) {
      const denied = await s.go(
        browser,
        start.id,
        { command: 'reopen', version: start.version, reason: REASON },
        true,
      );
      expect(denied.status).toBe(403);
    }
    const noReason = await s.go(
      w.supervisor,
      start.id,
      { command: 'reopen', version: start.version },
      true,
    );
    expect([noReason.status, noReason.json.missingRequirements]).toEqual([422, ['reason']]);
    const withoutKey = await s.go(w.supervisor, start.id, {
      command: 'reopen',
      version: start.version,
      reason: REASON,
    });
    expect([withoutKey.status, withoutKey.json.code]).toEqual([400, 'idempotency_key_required']);

    const headers = w.key();
    const body = { command: 'reopen', version: start.version, reason: REASON };
    const reopened = await w.supervisor.post(`${P}/${start.id}/transitions`, {
      json: body,
      headers,
    });
    expect(reopened.status, reopened.text).toBe(200);
    expect(reopened.json).toMatchObject({ status: 'reopened', cycle: 2, reopenCount: 1 });
    const replay = await w.supervisor.post(`${P}/${start.id}/transitions`, { json: body, headers });
    expect([replay.status, replay.json]).toEqual([200, reopened.json]);
    const clash = await w.supervisor.post(`${P}/${start.id}/transitions`, {
      json: { ...body, reason: 'Otro motivo sintético' },
      headers,
    });
    expect([clash.status, clash.json.code]).toEqual([409, 'idempotency_conflict']);
    expect(
      await w.database.rows(
        "SELECT 1 FROM opslog_incident_transitions WHERE incident_id = ? AND command = 'reopen'",
        [start.id],
      ),
    ).toHaveLength(1);

    // The reopened case goes back to review with a responsible, as the table of states says.
    const review = await s.step(w.manager, start.id, reopened.json.version, 'review');
    expect((await s.read(w.manager, start.id)).status).toBe('under_review');
    expect(review.version).toBeGreaterThan(reopened.json.version);
  });

  it('closes the second cycle with its own snapshot and keeps free text out of audit and outbox', async () => {
    const start = await closed();
    const reopened = await s.step(
      w.supervisor,
      start.id,
      start.version,
      'reopen',
      { reason: REASON },
      true,
    );
    const review = await s.step(w.manager, start.id, reopened.version, 'review');
    const repaired = await s.put(w.manager, start.id, 'resolution', review.version, {
      resolutionSummary: 'Segundo cierre sintético',
      vehicleStatusDecision: 'restricted',
    });
    const resolved = await s.step(w.manager, start.id, repaired.version, 'resolve');
    const second = await s.step(w.manager, start.id, resolved.version, 'close', {}, true);
    const view = await s.read(w.manager, start.id);
    expect(view).toMatchObject({
      status: 'closed',
      cycle: 2,
      reopenCount: 1,
      version: second.version,
    });
    const rows = await w.database.rows<{ cycle: number; resolution_summary: string }>(
      'SELECT cycle, resolution_summary FROM opslog_incident_closures WHERE incident_id = ? ORDER BY cycle',
      [start.id],
    );
    expect(rows.map((row) => [row.cycle, row.resolution_summary])).toEqual([
      [1, 'Primer cierre sintético'],
      [2, 'Segundo cierre sintético'],
    ]);
    expect((await s.timeline(start.id)).map((row) => row.command).slice(-7)).toEqual([
      'resolve',
      'close',
      'reopen',
      'review',
      'resolution_updated',
      'resolve',
      'close',
    ]);
    await s.expectNoLeak([REASON, FREE_TEXT, 'Primer cierre', 'Segundo cierre']);
  });
});
