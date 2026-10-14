import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { journeySteps, FREE_TEXT, type JourneySteps } from './steps.js';
import { P, startIncidentsWorld, type IncidentsWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const CLAIM = 'REP-ACEPTADO-1';

suite('journey 1: the insurer accepts and the case closes (MySQL, two synthetic companies)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
  }, 180_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  it('goes from the reporter draft to a closed case through the insurer route, one permission at a time', async () => {
    const created = await s.draft(w.reporter);
    // D8: the author may complete its own draft with incidents:report, without incidents:edit.
    const own = await w.reporter.send('PATCH', `${P}/${created.id}`, {
      json: { version: created.version, severity: 'high' },
    });
    expect(own.status, own.text).toBe(200);
    const photo = await s.evidence(w.reporter, created.id, own.json.version, 'photo', 'on_site');
    await s.scan();
    const reported = await s.step(w.reporter, created.id, photo.version, 'report');
    // Once reported it is the manager's case: the author can no longer edit it.
    const late = await w.reporter.send('PATCH', `${P}/${created.id}`, {
      json: { version: reported.version, severity: 'low' },
    });
    expect([late.status, late.json.code]).toEqual([403, 'forbidden']);
    const assigned = await s.step(w.manager, created.id, reported.version, 'assign', {
      responsibleId: w.managerId,
    });
    const review = await s.step(w.manager, created.id, assigned.version, 'review');
    const lacking = await s.go(w.manager, created.id, {
      command: 'insure',
      version: review.version,
    });
    expect([lacking.status, lacking.json.missingRequirements]).toEqual([
      422,
      expect.arrayContaining(['insurer', 'claim_number', 'insurer_reported_on']),
    ]);
    const filed = await s.put(w.manager, created.id, 'insurance', review.version, {
      insurerName: 'Aseguradora Sintética',
      claimNumber: CLAIM,
      insurerReportedOn: s.today(),
    });
    const insured = await s.step(w.manager, created.id, filed.version, 'insure');
    const unfinished = await s.go(w.manager, created.id, {
      command: 'resolve',
      version: insured.version,
    });
    expect(unfinished.json.missingRequirements).toEqual(
      expect.arrayContaining(['insurer_result', 'resolution_summary']),
    );
    // Time passes between the filing and the answer of the insurer: the clock is the test's.
    await w.advance(3 * 24 * 3_600_000);
    const accepted = await s.put(w.manager, created.id, 'insurance', insured.version, {
      insurerResult: 'accepted',
    });
    const summary = await s.put(w.manager, created.id, 'resolution', accepted.version, {
      resolutionSummary: 'Resuelto con la aseguradora de forma sintética',
      vehicleStatusDecision: 'active',
    });
    const resolved = await s.step(w.manager, created.id, summary.version, 'resolve');
    // Without a threshold no approval is asked and the plain close is offered.
    expect(await s.nextSteps(w.manager, created.id)).toContain('close');
    expect(await s.nextSteps(w.supervisor, created.id)).not.toContain('approve_close');
    const denied = await s.go(
      w.reporter,
      created.id,
      { command: 'close', version: resolved.version },
      true,
    );
    expect(denied.status).toBe(403);
    const closed = await s.step(w.supervisor, created.id, resolved.version, 'close', {}, true);

    const view = await s.read(w.manager, created.id);
    expect(view).toMatchObject({
      status: 'closed',
      cycle: 1,
      insurance: { insurerResult: 'accepted' },
    });
    expect(closed.version).toBe(view.version);
    expect((await s.timeline(created.id)).map((row) => row.command)).toEqual([
      'create',
      'update',
      'evidence_attached',
      'report',
      'assign',
      'review',
      'insurance_updated',
      'insure',
      'insurance_updated',
      'resolution_updated',
      'resolve',
      'close',
    ]);
    const closures = await w.database.rows<{ cycle: number; status_before: string }>(
      'SELECT cycle, status_before FROM opslog_incident_closures WHERE incident_id = ?',
      [created.id],
    );
    expect(closures).toEqual([expect.objectContaining({ cycle: 1, status_before: 'resolved' })]);
    // The case never changes the vehicle by itself (D11).
    const vehicle = await w.adminA.get(`/api/vehicles/${w.vehicleA}`);
    expect(vehicle.json.status).toBe('active');
    const types = await w.database.rows<{ type: string }>(
      'SELECT DISTINCT type FROM opslog_tenant_outbox WHERE entity_id = ?',
      [created.id],
    );
    expect(types.map((row) => row.type)).toEqual(
      expect.arrayContaining(['incident.status_changed', 'incident.closed']),
    );
    await s.expectNoLeak([FREE_TEXT, CLAIM, 'Resuelto con la aseguradora']);
  });

  it('shows the amounts only to who holds incidents:view_costs, and the other company sees nothing', async () => {
    const { id } = await s.underReview();
    expect((await w.reporter.get(`${P}/${id}/costs`)).status).toBe(403);
    expect((await w.supervisor.get(`${P}/${id}/costs`)).status).toBe(200);
    for (const browser of [w.managerB, w.adminB])
      expect((await browser.get(`${P}/${id}`)).status).toBe(404);
  });
});
