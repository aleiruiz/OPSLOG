import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../fleet/mysql.js';
import { journeySteps, type JourneySteps } from './steps.js';
import { P, startIncidentsWorld, type IncidentsWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;

suite('journey 4: total loss proposes decommissioning and never applies it (MySQL)', () => {
  let w: IncidentsWorld;
  let s: JourneySteps;

  beforeAll(async () => {
    w = await startIncidentsWorld();
    s = journeySteps(w);
  }, 180_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);

  it('proposes decommissioning while open, records the decision at the closure and leaves the vehicle to its own module', async () => {
    const review = await s.underReview({
      type: 'theft_total',
      severity: 'high',
      vehicleOperable: false,
    });
    const before = await s.read(w.manager, review.id);
    expect(before.vehicleProposal).toMatchObject({ suggestedStatus: 'out_of_service' });
    const flagged = await s.put(w.manager, review.id, 'resolution', review.version, {
      totalLoss: true,
    });
    const view = await s.read(w.manager, review.id);
    expect(view.vehicleProposal).toMatchObject({ suggestedStatus: 'decommissioned' });
    expect(view.resolution.totalLoss).toBe(true);

    // The insurer asks for the police report of a theft; no route of this type reaches repair.
    const noReport = await s.go(w.manager, review.id, {
      command: 'insure',
      version: flagged.version,
    });
    expect(noReport.json.missingRequirements).toEqual(
      expect.arrayContaining(['required_documents']),
    );
    const report = await s.evidence(w.manager, review.id, flagged.version, 'police_report');
    await s.scan();
    const repair = await s.go(w.manager, review.id, { command: 'repair', version: report.version });
    expect(repair.status, repair.text).toBe(409);
    const filed = await s.put(w.manager, review.id, 'insurance', report.version, {
      insurerName: 'Aseguradora Sintética',
      claimNumber: 'REP-PERDIDA-1',
      insurerReportedOn: s.today(),
    });
    const insured = await s.step(w.manager, review.id, filed.version, 'insure');
    const accepted = await s.put(w.manager, review.id, 'insurance', insured.version, {
      insurerResult: 'accepted',
    });
    const decided = await s.put(w.manager, review.id, 'resolution', accepted.version, {
      resolutionSummary: 'Pérdida total indemnizada de forma sintética',
      vehicleStatusDecision: 'decommissioned',
    });
    const resolved = await s.step(w.manager, review.id, decided.version, 'resolve');
    await s.step(w.supervisor, review.id, resolved.version, 'close', {}, true);

    const [closure] = await w.database.rows<{
      total_loss: number | null;
      vehicle_status_decision: string;
    }>(
      'SELECT total_loss, vehicle_status_decision FROM opslog_incident_closures WHERE incident_id = ?',
      [review.id],
    );
    expect(closure).toMatchObject({ vehicle_status_decision: 'decommissioned' });
    expect(Number(closure?.total_loss)).toBe(1);
    // Closed cases propose nothing, and the vehicle was not touched by the case (D11).
    expect((await s.read(w.manager, review.id)).vehicleProposal).toBeNull();
    const vehicle = await w.adminA.get(`/api/vehicles/${w.vehicleA}`);
    expect(vehicle.json.status).toBe('active');
    expect((await w.managerB.get(`${P}/${review.id}`)).status).toBe(404);
  });
});
