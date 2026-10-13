import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const P = '/api/v1/incidents';
const FREE_TEXT = 'Texto libre sintético del flujo';
const COMMENT = 'Comentario libre sintético de la transición';
const REASON = 'Motivo libre sintético de la cancelación';

suite('incident workflow on real MySQL with two synthetic tenants', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;
  let managerA: Awaited<ReturnType<FleetWorld['worldA']['loginAs']>>;
  let managerB: typeof managerA;
  let managerAId: string;
  let editorAId: string;
  let managerBId: string;
  let vehicleA: string;
  let vehicleB: string;
  let policyA: string;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
    managerAId = (
      await fleet.worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a')
    ).identityId;
    editorAId = (await fleet.worldA.member('subject-admin-a', 'editor', 'subject-editor-wf'))
      .identityId;
    managerA = await fleet.worldA.loginAs('subject-manager-a');
    managerBId = (
      await fleet.worldB.member('subject-admin-b', 'incident_manager', 'subject-manager-b')
    ).identityId;
    managerB = await fleet.worldB.loginAs('subject-manager-b');
    vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'WF-A');
    vehicleB = await fleet.vehicle(fleet.adminB, await fleet.area(fleet.adminB), 'WF-B');
    const policy = await fleet.adminA.post('/api/insurance-policies', {
      json: {
        vehicleId: vehicleA,
        insurer: 'Aseguradora Sintética',
        policyNumber: 'SYNTH-POL-WF',
        coverageType: 'comprehensive',
        startsOn: '2020-01-01',
        endsOn: '2099-12-31',
      },
    });
    expect(policy.status, policy.text).toBe(201);
    policyA = policy.json.id as string;
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  const today = () => new Date().toISOString().slice(0, 10);
  async function draft(over: Record<string, unknown> = {}) {
    const created = await managerA.post(P, {
      json: {
        vehicleId: vehicleA,
        type: 'collision',
        severity: 'low',
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: FREE_TEXT,
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
        policyId: policyA,
        ...over,
      },
    });
    expect(created.status, created.text).toBe(201);
    return created.json as { id: string; version: number };
  }
  const transition = (id: string, json: Record<string, unknown>, key?: string) =>
    managerA.post(`${P}/${id}/transitions`, {
      json,
      ...(key ? { headers: { 'idempotency-key': key } } : {}),
    });
  const read = async (id: string) => (await managerA.get(`${P}/${id}`)).json;

  it('runs the insurer route with the requirements named at each step, and keeps free text out of audit and outbox (cases 1 to 3, 7)', async () => {
    const { id, version } = await draft();
    const reported = await transition(id, { command: 'report', version, comment: COMMENT });
    expect(reported.status, reported.text).toBe(200);
    expect(reported.json.status).toBe('reported');

    const generic = await transition(id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: editorAId,
    });
    expect([generic.status, generic.json.code, generic.json.field]).toEqual([
      422,
      'rule_violation',
      'responsible_not_eligible',
    ]);
    const foreign = await transition(id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: managerBId,
    });
    expect(foreign.status).toBe(404);
    const assigned = await transition(id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: managerAId,
    });
    expect(assigned.status, assigned.text).toBe(200);
    const review = await transition(id, { command: 'review', version: assigned.json.version });
    expect(review.json.status).toBe('under_review');

    const lacking = await transition(id, { command: 'insure', version: review.json.version });
    expect([lacking.status, lacking.json.code, lacking.json.missingRequirements]).toEqual([
      422,
      'missing_requirements',
      ['insurer', 'claim_number', 'insurer_reported_on'],
    ]);
    const insurer = await managerA.put(`${P}/${id}/insurance`, {
      json: {
        version: review.json.version,
        insurerName: 'Aseguradora Sintética',
        claimNumber: 'REP-WF-1',
        insurerReportedOn: today(),
      },
    });
    expect(insurer.status, insurer.text).toBe(200);
    const insured = await transition(id, { command: 'insure', version: insurer.json.version });
    expect(insured.json).toMatchObject({ status: 'insurance_process' });

    const noLetter = await transition(id, { command: 'reject', version: insured.json.version });
    expect(noLetter.json.missingRequirements).toEqual(['rejection_reason', 'rejection_letter']);
    const reason = await managerA.put(`${P}/${id}/insurance`, {
      json: { version: insured.json.version, rejectionReason: 'Fuera de cobertura' },
    });
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 5),
    ]);
    const letter = await managerA.post(`${P}/${id}/evidence`, {
      json: {
        version: reason.json.version,
        category: 'rejection_letter',
        stage: 'other',
        name: 'carta.png',
        contentType: 'image/png',
        clientCompressed: true,
        contentBase64: png.toString('base64'),
      },
    });
    expect(letter.status, letter.text).toBe(201);
    // In quarantine the letter does not count.
    const quarantined = await transition(id, { command: 'reject', version: letter.json.version });
    expect(quarantined.json.missingRequirements).toEqual(['rejection_letter']);
    await fleet.platformA.pipeline.processScans();
    const rejected = await transition(id, { command: 'reject', version: letter.json.version });
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.json).toMatchObject({
      status: 'insurance_rejected',
      insurance: { insurerResult: 'rejected' },
    });
    const noNote = await transition(id, { command: 'appeal', version: rejected.json.version });
    expect(noNote.json.missingRequirements).toEqual(['appeal_note']);
    const note = await managerA.put(`${P}/${id}/insurance`, {
      json: { version: rejected.json.version, appealNote: 'Documentos adicionales' },
    });
    const appealed = await transition(id, { command: 'appeal', version: note.json.version });
    expect(appealed.json).toMatchObject({ status: 'insurance_process' });

    const stored = await database.rows<{ status: string; version: number }>(
      'SELECT status, version FROM opslog_incident_incidents WHERE id = ?',
      [id],
    );
    expect(stored[0]).toMatchObject({ status: 'insurance_process' });
    const timeline = await database.rows<{ command: string }>(
      'SELECT command FROM opslog_incident_transitions WHERE incident_id = ? ORDER BY sequence',
      [id],
    );
    expect(timeline.map((row) => row.command)).toEqual(
      expect.arrayContaining(['report', 'assign', 'review', 'insure', 'reject', 'appeal']),
    );
    const events = JSON.stringify(await database.rows('SELECT * FROM opslog_tenant_outbox'));
    expect(events).toContain('incident.status_changed');
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await database.rows(`SELECT * FROM ${table}`));
      for (const secret of [
        FREE_TEXT,
        COMMENT,
        'REP-WF-1',
        'Fuera de cobertura',
        'Documentos adicionales',
      ])
        expect(dump, `${table} ${secret}`).not.toContain(secret);
    }
  });

  it('fails closed on repair and on cancelling a started case while there are no costs (cases 5 and 13)', async () => {
    const { id, version } = await draft({ type: 'other' });
    const reported = await transition(id, { command: 'report', version });
    const assigned = await transition(id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: managerAId,
    });
    const review = await transition(id, { command: 'review', version: assigned.json.version });
    const decided = await managerA.put(`${P}/${id}/insurance`, {
      json: {
        version: review.json.version,
        noInsuranceReason: 'Decisión sintética sin aseguradora',
      },
    });
    const noInsurance = await transition(id, {
      command: 'no_insurance',
      version: decided.json.version,
    });
    expect(noInsurance.json.status).toBe('no_insurance');
    const repair = await transition(id, { command: 'repair', version: noInsurance.json.version });
    expect([repair.status, repair.json.missingRequirements]).toEqual([
      422,
      expect.arrayContaining(['repair_order_or_budget']),
    ]);
    const cancel = await transition(id, {
      command: 'cancel',
      version: noInsurance.json.version,
      reason: REASON,
    });
    expect(cancel.status).toBe(422);
    expect(cancel.json.missingRequirements).toEqual(expect.arrayContaining(['no_costs']));
    expect((await read(id)).status).toBe('no_insurance');
  });

  it('resolves a direct-route case with its summary and decision, and locks every write once it is cancelled (cases 6 and 11)', async () => {
    const { id, version } = await draft({ type: 'other' });
    const reported = await transition(id, { command: 'report', version });
    const assigned = await transition(id, {
      command: 'assign',
      version: reported.json.version,
      responsibleId: managerAId,
    });
    const review = await transition(id, { command: 'review', version: assigned.json.version });
    const lacking = await transition(id, { command: 'resolve', version: review.json.version });
    expect(lacking.json.missingRequirements).toEqual([
      'resolution_summary',
      'vehicle_status_decision',
    ]);
    const filled = await managerA.put(`${P}/${id}/resolution`, {
      json: {
        version: review.json.version,
        resolutionSummary: 'Resuelto sin aseguradora',
        vehicleStatusDecision: 'active',
      },
    });
    expect(filled.status, filled.text).toBe(200);
    const resolved = await transition(id, { command: 'resolve', version: filled.json.version });
    expect(resolved.json).toMatchObject({ status: 'resolved' });
    expect(resolved.json.resolution.resolvedAt).not.toBeNull();

    const cancelled = await draft();
    const done = await transition(cancelled.id, {
      command: 'cancel',
      version: cancelled.version,
      reason: REASON,
    });
    expect(done.json).toMatchObject({ status: 'cancelled' });
    const v = done.json.version as number;
    const locked = [
      await managerA.send('PATCH', `${P}/${cancelled.id}`, {
        json: { version: v, severity: 'high' },
      }),
      await managerA.put(`${P}/${cancelled.id}/insurance`, {
        json: { version: v, claimNumber: 'X' },
      }),
      await managerA.put(`${P}/${cancelled.id}/resolution`, {
        json: { version: v, totalLoss: true },
      }),
      await transition(cancelled.id, { command: 'report', version: v }),
      await managerA.post(`${P}/${cancelled.id}/third-parties`, {
        json: { version: v, kind: 'vehicle', name: 'Tercero', plates: 'SYN-1' },
      }),
    ];
    expect(locked.map((reply) => reply.status)).toEqual([409, 409, 409, 409, 409]);
    expect((await read(cancelled.id)).version).toBe(v);
    const steps = await managerA.get(`${P}/${cancelled.id}/next-steps`);
    expect(steps.json.items).toEqual([]);
  });

  it('replays an idempotent command, lets one of two racing commands win and refuses a stale version (cases 10 and 11)', async () => {
    const { id, version } = await draft();
    const first = await transition(id, { command: 'report', version }, 'wf-key-000001');
    const replay = await transition(id, { command: 'report', version }, 'wf-key-000001');
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    const clash = await transition(
      id,
      { command: 'report', version, comment: 'otro' },
      'wf-key-000001',
    );
    expect([clash.status, clash.json.code]).toEqual([409, 'idempotency_conflict']);
    const events = await database.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opslog_incident_transitions WHERE incident_id = ? AND command = 'report'",
      [id],
    );
    expect(events[0]?.n).toBe(1);

    const racing = await draft();
    const results = await Promise.all([
      transition(racing.id, { command: 'report', version: racing.version }),
      transition(racing.id, { command: 'cancel', version: racing.version, reason: REASON }),
    ]);
    expect(results.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const stale = await transition(racing.id, { command: 'report', version: 1 });
    expect(stale.status).toBe(409);
    const rows = await database.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opslog_incident_transitions WHERE incident_id = ? AND command <> 'create'",
      [racing.id],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('keeps tenants apart on every workflow endpoint and for the report photo setting (case 15)', async () => {
    const { id, version } = await draft();
    const body = { command: 'report', version };
    const attempts = [
      await managerB.post(`${P}/${id}/transitions`, { json: body }),
      await fleet.adminB.post(`${P}/${id}/transitions`, { json: body }),
      await managerB.get(`${P}/${id}/next-steps`),
      await managerB.put(`${P}/${id}/insurance`, { json: { version, claimNumber: 'B' } }),
      await managerB.put(`${P}/${id}/resolution`, { json: { version, totalLoss: true } }),
    ];
    expect(attempts.map((reply) => [reply.status, reply.json.code])).toEqual(
      attempts.map(() => [404, 'not_found']),
    );
    expect((await read(id)).status).toBe('draft');
    expect(
      await database.rowsB(
        'SELECT sequence FROM opslog_incident_transitions WHERE incident_id = ?',
        [id],
      ),
    ).toEqual([]);

    // The strict setting of one company never reaches the other.
    const strict = await fleet.adminA.put('/api/alerts/settings', {
      json: {
        version: 0,
        expiryWindowDays: 7,
        recipientRoles: ['admin'],
        incidentReportPhoto: 'photo_required',
      },
    });
    expect(strict.status, strict.text).toBe(200);
    const refused = await transition(id, body);
    expect(refused.json.missingRequirements).toEqual(['photo_or_justification']);
    const draftB = await managerB.post(P, {
      json: {
        vehicleId: vehicleB,
        type: 'collision',
        severity: 'low',
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: FREE_TEXT,
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
      },
    });
    expect(draftB.status, draftB.text).toBe(201);
    const reportedB = await managerB.post(`${P}/${draftB.json.id}/transitions`, {
      json: { command: 'report', version: draftB.json.version },
    });
    expect(reportedB.status, reportedB.text).toBe(200);
  });
});
