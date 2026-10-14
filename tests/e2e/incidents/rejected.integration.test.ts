import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { journeySteps, type Case, type JourneySteps } from './steps.js';
import { P, startIncidentsWorld, type IncidentsWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const THRESHOLD = '500000';
const REASON = 'Fuera de cobertura sintética';
const NOTE = 'Documentos adicionales sintéticos';

suite('journey 2: rejected, appealed and assumed under the D20 threshold (MySQL)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
    await s.threshold(THRESHOLD);
  }, 180_000);
  afterAll(async () => {
    await s.threshold(null).catch(() => undefined);
    await w?.stop();
  }, 60_000);

  /** Under review, filed with the insurer and rejected twice (the letter is clean): the case waits for a decision. */
  async function rejected(): Promise<Case> {
    const review = await s.underReview();
    const filed = await s.put(w.manager, review.id, 'insurance', review.version, {
      insurerName: 'Aseguradora Sintética',
      claimNumber: 'REP-RECHAZO',
      insurerReportedOn: s.today(),
    });
    const insured = await s.step(w.manager, review.id, filed.version, 'insure');
    const reason = await s.put(w.manager, review.id, 'insurance', insured.version, {
      rejectionReason: REASON,
    });
    const letter = await s.evidence(w.manager, review.id, reason.version, 'rejection_letter');
    await s.scan();
    const first = await s.step(w.manager, review.id, letter.version, 'reject');
    const note = await s.put(w.manager, review.id, 'insurance', first.version, {
      appealNote: NOTE,
    });
    // The appeal goes back to the insurer, which answers again some days later.
    const appealed = await s.step(w.manager, review.id, note.version, 'appeal');
    expect((await s.read(w.manager, review.id)).status).toBe('insurance_process');
    await w.advance(5 * 24 * 3_600_000);
    return s.step(w.manager, review.id, appealed.version, 'reject');
  }

  it('appeals once and the second rejection leaves the cost to the company', async () => {
    const { id, version } = await rejected();
    const view = await s.read(w.manager, id);
    expect(view).toMatchObject({
      status: 'insurance_rejected',
      insurance: { insurerResult: 'rejected' },
    });
    const steps = await s.timeline(id);
    expect(steps.map((row) => row.command)).toEqual(
      expect.arrayContaining(['insure', 'reject', 'appeal', 'reject']),
    );
    // The company has not assumed the cost yet: nothing resolves the case.
    const blocked = await s.go(w.manager, id, { command: 'resolve', version });
    expect(blocked.json.missingRequirements).toEqual(
      expect.arrayContaining(['cost_assumed', 'resolution_summary', 'vehicle_status_decision']),
    );
  });

  it('asks no approval for a cost equal to the threshold (D20 is strictly greater)', async () => {
    const start = await rejected();
    const priced = await s.costs(w.manager, start.id, start.version, [
      s.expense('repair', THRESHOLD),
    ]);
    const assumed = await s.put(w.manager, start.id, 'resolution', priced.version, {
      costAssumed: true,
      resolutionSummary: 'Asumido por la empresa de forma sintética',
      vehicleStatusDecision: 'active',
    });
    expect(await s.nextSteps(w.supervisor, start.id)).not.toContain('approve_assumption');
    const resolved = await s.step(w.manager, start.id, assumed.version, 'resolve');
    expect(await s.nextSteps(w.supervisor, start.id)).not.toContain('approve_close');
    const closed = await s.step(w.manager, start.id, resolved.version, 'close', {}, true);
    expect(closed.version).toBeGreaterThan(resolved.version);
    const [row] = await w.database.rows<{ close_approved_by: string | null }>(
      'SELECT close_approved_by FROM opslog_incident_closures WHERE incident_id = ?',
      [start.id],
    );
    expect(row?.close_approved_by).toBeNull();
  });

  it('requires a supervisor approval for one minor unit above it, for the assumption and for the closure', async () => {
    const start = await rejected();
    const priced = await s.costs(w.manager, start.id, start.version, [
      s.expense('repair', THRESHOLD),
      s.expense('other', '1'),
    ]);
    const assumed = await s.put(w.manager, start.id, 'resolution', priced.version, {
      costAssumed: true,
      resolutionSummary: 'Asumido por la empresa de forma sintética',
      vehicleStatusDecision: 'active',
    });
    expect(await s.nextSteps(w.supervisor, start.id)).toContain('approve_assumption');
    const refused = await s.go(w.manager, start.id, {
      command: 'resolve',
      version: assumed.version,
    });
    expect([refused.status, refused.json.missingRequirements]).toEqual([
      422,
      ['assumption_approval'],
    ]);
    // The manager holds incidents:close but not incidents:approve.
    const denied = await s.go(
      w.manager,
      start.id,
      { command: 'approve_assumption', version: assumed.version },
      true,
    );
    expect(denied.status).toBe(403);
    const approved = await s.step(
      w.supervisor,
      start.id,
      assumed.version,
      'approve_assumption',
      {},
      true,
    );
    const resolved = await s.step(w.manager, start.id, approved.version, 'resolve');
    const noClose = await s.go(
      w.manager,
      start.id,
      { command: 'close', version: resolved.version },
      true,
    );
    expect([noClose.status, noClose.json.missingRequirements]).toEqual([422, ['close_approval']]);
    expect(await s.nextSteps(w.supervisor, start.id)).toContain('approve_close');
    const closeApproved = await s.step(
      w.supervisor,
      start.id,
      resolved.version,
      'approve_close',
      {},
      true,
    );
    await s.step(w.manager, start.id, closeApproved.version, 'close', {}, true);
    const [row] = await w.database.rows<{ close_approved_by: string | null }>(
      'SELECT close_approved_by FROM opslog_incident_closures WHERE incident_id = ?',
      [start.id],
    );
    expect(row?.close_approved_by).toBe(`user-${w.supervisorId}`);
    await s.expectNoLeak([REASON, NOTE, '500001', '500000']);
  });

  it('drops the approval when the cost grows afterwards, so the supervisor decides again', async () => {
    const start = await rejected();
    const priced = await s.costs(w.manager, start.id, start.version, [
      s.expense('repair', '600000'),
    ]);
    const assumed = await s.put(w.manager, start.id, 'resolution', priced.version, {
      costAssumed: true,
      resolutionSummary: 'Asumido por la empresa de forma sintética',
      vehicleStatusDecision: 'active',
    });
    const approved = await s.step(
      w.supervisor,
      start.id,
      assumed.version,
      'approve_assumption',
      {},
      true,
    );
    const grown = await s.costs(w.manager, start.id, approved.version, [
      s.expense('repair', '900000'),
    ]);
    const stale = await s.go(w.manager, start.id, { command: 'resolve', version: grown.version });
    expect([stale.status, stale.json.missingRequirements]).toEqual([422, ['assumption_approval']]);
    expect((await w.reporter.get(`${P}/${start.id}/next-steps`)).status).toBe(200);
  });
});
