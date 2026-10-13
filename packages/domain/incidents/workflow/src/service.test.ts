import { describe, expect, it } from 'vitest';
import { INCIDENT_COMMANDS, IncidentError, type Incident } from '../../cases/src/index.js';
import { allowedCommands, mayRun } from './access.js';
import {
  ADMIN,
  FLEET_EDITOR,
  FULL,
  MANAGER,
  OTHER_REPORTER,
  REPORTER,
  TENANT_A,
  VIEWER,
  actorOf,
  draft,
  put,
  setup,
  type World,
} from './test-support.js';

const fail = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

const run = (
  world: World,
  incident: Incident,
  command: string,
  extra: Record<string, unknown> = {},
  actor = ADMIN,
  key?: string,
) =>
  world.workflow.execute(
    TENANT_A,
    actor,
    incident.id,
    { command, version: incident.version, ...extra },
    key,
  );

describe('report (cases 3 and 4 of the package: requirements of the draft)', () => {
  it('reports a complete draft, stamps who and when, and emits one status event', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await run(world, created, 'report', { comment: 'Listo' });
    expect(reported).toMatchObject({
      status: 'reported',
      version: 2,
      reportedAt: '2026-10-13T18:00:00.000Z',
      reportedBy: ADMIN.id,
    });
    const entry = (await world.store.history(TENANT_A, created.id)).at(-1);
    expect(entry).toMatchObject({
      command: 'report',
      from: 'draft',
      to: 'reported',
      comment: 'Listo',
      changedFields: ['reportedAt', 'reportedBy', 'status'],
    });
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.status_changed',
      payload: {
        incidentId: created.id,
        vehicleId: created.vehicleId,
        version: 2,
        status: 'reported',
      },
    });
    expect(world.store.audit.at(-1)?.action).toBe('incident.report');
  });

  it('names every missing requirement at once', async () => {
    const world = setup();
    const created = await world.cases.create(TENANT_A, MANAGER, {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    const error = await fail(run(world, created, 'report'));
    expect([error.code, error.missingRequirements]).toEqual([
      'missing_requirements',
      [
        'occurred_at',
        'location',
        'description',
        'severity',
        'driver_or_reason',
        'vehicle_operable',
        'photo_or_justification',
      ],
    ]);
  });

  it('accepts the reason for having no driver instead of one', async () => {
    const world = setup();
    const created = await draft(world, { driverId: null, noDriverReason: 'Vehículo estacionado' });
    expect((await run(world, created, 'report')).status).toBe('reported');
  });

  it('asks a clean photo or a justification, or only the photo, by company setting (case 4)', async () => {
    const world = setup();
    const noJustification = await draft(world, { noPhotoJustification: null });
    world.evidence.add('photo', false);
    const pending = await fail(run(world, noJustification, 'report'));
    expect(pending.missingRequirements).toEqual(['photo_or_justification']);
    const justified = await draft(world);
    expect((await run(world, justified, 'report')).status).toBe('reported');

    world.settings.photo = 'photo_required';
    const stillJustified = await draft(world);
    expect((await fail(run(world, stillJustified, 'report'))).missingRequirements).toEqual([
      'photo_or_justification',
    ]);
    world.evidence.add('photo');
    expect((await run(world, stillJustified, 'report')).status).toBe('reported');
    world.settings.photo = 'photo_or_justification';
    world.evidence.items = [];
    world.evidence.add('photo');
    expect((await run(world, noJustification, 'report')).status).toBe('reported');
  });
});

describe('review, insure and no_insurance', () => {
  it('needs a responsible to review and moves a reopened case back to review', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await run(world, created, 'report');
    expect((await fail(run(world, reported, 'review'))).missingRequirements).toEqual([
      'responsible',
    ]);
    const assigned = await run(world, reported, 'assign', { responsibleId: MANAGER.subject });
    expect((await run(world, assigned, 'review')).status).toBe('under_review');
    const reopened = await put(world, assigned, { status: 'reopened' });
    expect((await run(world, reopened, 'review')).status).toBe('under_review');
  });

  it('lists claim number, insurer and date when insuring without them (case 3)', async () => {
    const world = setup();
    const created = await draft(world);
    const review = await put(world, created, { status: 'under_review', responsibleId: ADMIN.id });
    const error = await fail(run(world, review, 'insure'));
    expect([error.code, error.missingRequirements]).toEqual([
      'missing_requirements',
      ['insurer', 'claim_number', 'insurer_reported_on'],
    ]);
    expect(await world.store.get(TENANT_A, created.id)).toMatchObject({ version: review.version });
  });

  it('asks for the report or complaint where the type needs it, and for the policy of the day', async () => {
    const world = setup();
    const theft = await draft(world, { type: 'theft_partial' });
    const review = await put(world, theft, { status: 'under_review', ...FULL });
    expect((await fail(run(world, review, 'insure'))).missingRequirements).toEqual([
      'required_documents',
    ]);
    world.evidence.add('police_report', false);
    expect((await fail(run(world, review, 'insure'))).missingRequirements).toEqual([
      'required_documents',
    ]);
    world.evidence.add('police_report');
    expect((await run(world, review, 'insure')).status).toBe('insurance_process');

    world.refs.revisions = [];
    const uncovered = await draft(world);
    const review2 = await put(world, uncovered, { status: 'under_review', ...FULL });
    expect((await fail(run(world, review2, 'insure'))).missingRequirements).toEqual([
      'policy_at_event',
    ]);
  });

  it('keeps the result of the insurer a case already has, and starts it as pending otherwise', async () => {
    const world = setup();
    const created = await draft(world);
    const review = await put(world, created, {
      status: 'under_review',
      ...FULL,
      insurerResult: null,
    });
    expect((await run(world, review, 'insure')).insurerResult).toBe('pending');
    const second = await draft(world);
    const withResult = await put(world, second, { status: 'under_review', ...FULL });
    expect((await run(world, withResult, 'insure')).insurerResult).toBe('accepted');
  });

  it('records the decision to go on without the insurer only with its reason', async () => {
    const world = setup();
    const created = await draft(world);
    const review = await put(world, created, { status: 'under_review' });
    expect((await fail(run(world, review, 'no_insurance'))).missingRequirements).toEqual([
      'no_insurance_reason',
    ]);
    const ready = await put(world, review, { noInsuranceReason: 'Decisión explícita' });
    expect((await run(world, ready, 'no_insurance')).status).toBe('no_insurance');
  });
});

describe('reject and appeal (case 7)', () => {
  it('needs a reason and a clean letter to reject, and an appeal note to appeal', async () => {
    const world = setup();
    const created = await draft(world);
    const process = await put(world, created, { status: 'insurance_process' });
    expect((await fail(run(world, process, 'reject'))).missingRequirements).toEqual([
      'rejection_reason',
      'rejection_letter',
    ]);
    world.evidence.add('rejection_letter', false);
    const reasoned = await put(world, process, { rejectionReason: 'Fuera de cobertura' });
    expect((await fail(run(world, reasoned, 'reject'))).missingRequirements).toEqual([
      'rejection_letter',
    ]);
    world.evidence.add('rejection_letter');
    const rejected = await run(world, reasoned, 'reject');
    expect(rejected).toMatchObject({ status: 'insurance_rejected', insurerResult: 'rejected' });
    expect((await fail(run(world, rejected, 'appeal'))).missingRequirements).toEqual([
      'appeal_note',
    ]);
    const noted = await put(world, rejected, { appealNote: 'Documentos adicionales' });
    const approved = await put(world, noted, {
      assumptionApproval: { by: ADMIN.id, at: '2026-10-13T10:00:00.000Z' },
    });
    const appealed = await run(world, approved, 'appeal');
    expect(appealed).toMatchObject({
      status: 'insurance_process',
      insurerResult: 'pending',
      assumptionApproval: null,
    });
  });

  it('clears the earlier appeal note on a new rejection, so each appeal needs its own', async () => {
    const world = setup();
    world.evidence.add('rejection_letter');
    const created = await draft(world);
    const process = await put(world, created, {
      status: 'insurance_process',
      rejectionReason: 'Motivo',
      appealNote: 'Nota anterior',
    });
    const rejected = await run(world, process, 'reject');
    expect(rejected.appealNote).toBeNull();
  });

  it('refuses to assume the cost without saying so (cost_assumed)', async () => {
    const world = setup();
    world.repairs.snapshot = { available: true, orders: [] };
    world.evidence.add('budget');
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { status: 'insurance_rejected' });
    expect((await fail(run(world, rejected, 'repair'))).missingRequirements).toEqual([
      'cost_assumed',
    ]);
    expect((await fail(run(world, rejected, 'resolve'))).missingRequirements).toEqual([
      'resolution_summary',
      'vehicle_status_decision',
      'cost_assumed',
    ]);
    const assumed = await put(world, rejected, { costAssumed: true });
    expect((await run(world, assumed, 'repair')).status).toBe('repair');
  });
});

describe('repair needs an order or a budget (case 5, ADR-0014)', () => {
  async function inReview(world: World, status: Incident['status'] = 'no_insurance') {
    const created = await draft(world, { type: 'other' });
    return put(world, created, { status, ...FULL });
  }

  it('passes with only a linked order, or with only a clean budget', async () => {
    const world = setup();
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'in_progress', version: 1, hasCosts: false }],
    };
    expect((await run(world, await inReview(world), 'repair')).status).toBe('repair');
    world.repairs.snapshot = { available: true, orders: [] };
    world.evidence.add('budget');
    expect((await run(world, await inReview(world), 'repair')).status).toBe('repair');
  });

  it('fails with a budget still in quarantine and no order, or with only a cancelled order', async () => {
    const world = setup();
    world.evidence.add('budget', false);
    expect((await fail(run(world, await inReview(world), 'repair'))).missingRequirements).toEqual([
      'repair_order_or_budget',
    ]);
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'cancelled', version: 1, hasCosts: false }],
    };
    expect((await fail(run(world, await inReview(world), 'repair'))).missingRequirements).toEqual([
      'repair_order_or_budget',
    ]);
  });

  it('fails closed without INC-COSTS even with a clean budget', async () => {
    const world = setup();
    world.evidence.add('budget');
    const incident = await inReview(world);
    const error = await fail(
      world.failClosed.execute(TENANT_A, ADMIN, incident.id, {
        command: 'repair',
        version: incident.version,
      }),
    );
    expect(error.missingRequirements).toEqual(['repair_order_or_budget']);
  });

  it('asks the insurer result from the insurer process and the responsible from a reopened case', async () => {
    const world = setup();
    world.evidence.add('budget');
    const process = await inReview(world, 'insurance_process');
    const pending = await put(world, process, { insurerResult: 'pending' });
    expect((await fail(run(world, pending, 'repair'))).missingRequirements).toEqual([
      'insurer_result',
    ]);
    const partial = await put(world, pending, { insurerResult: 'partial' });
    expect((await run(world, partial, 'repair')).status).toBe('repair');
    const reopened = await put(world, await inReview(world, 'reopened'), { responsibleId: null });
    expect((await fail(run(world, reopened, 'repair'))).missingRequirements).toEqual([
      'responsible',
    ]);
  });
});

describe('resolve', () => {
  it('asks the summary and the vehicle decision, then the checks of the repair', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const review = await put(world, created, { status: 'under_review' });
    expect((await fail(run(world, review, 'resolve'))).missingRequirements).toEqual([
      'resolution_summary',
      'vehicle_status_decision',
    ]);
    const repair = await put(world, created, { status: 'repair', ...FULL });
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'in_progress', version: 1, hasCosts: false }],
    };
    expect((await fail(run(world, repair, 'resolve'))).missingRequirements).toEqual([
      'repair_orders_finished',
      'repair_costs',
      'final_evidence',
    ]);
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'closed', version: 2, hasCosts: true }],
    };
    world.costs.costs = { available: true, hasCosts: true, hasRepairLine: false };
    world.evidence.add('other', true, 'post_repair');
    const resolved = await run(world, repair, 'resolve');
    expect(resolved).toMatchObject({ status: 'resolved', resolvedAt: '2026-10-13T18:00:00.000Z' });
  });

  it('accepts a clean invoice as the final evidence, and an own repair line when there are no orders', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const repair = await put(world, created, { status: 'repair', ...FULL });
    world.evidence.add('invoice');
    world.costs.costs = { available: true, hasCosts: true, hasRepairLine: false };
    expect((await fail(run(world, repair, 'resolve'))).missingRequirements).toEqual([
      'repair_costs',
    ]);
    world.costs.costs = { available: true, hasCosts: true, hasRepairLine: true };
    expect((await run(world, repair, 'resolve')).status).toBe('resolved');
  });

  it('fails closed without INC-COSTS from repair', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const repair = await put(world, created, { status: 'repair', ...FULL });
    world.evidence.add('invoice');
    const error = await fail(
      world.failClosed.execute(TENANT_A, ADMIN, repair.id, {
        command: 'resolve',
        version: repair.version,
      }),
    );
    expect(error.missingRequirements).toEqual(['repair_orders_finished', 'repair_costs']);
  });

  it('asks the approval of the assumption when D20 says the cost exceeds the threshold', async () => {
    const world = setup();
    world.settings.threshold = { amountMinor: '500000', currency: 'MXN' };
    world.costs.borne = {
      available: true,
      companyBorne: [{ currency: 'MXN', amountMinor: '500001' }],
    };
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { status: 'insurance_rejected', ...FULL });
    expect((await fail(run(world, rejected, 'resolve'))).missingRequirements).toEqual([
      'assumption_approval',
    ]);
    world.costs.borne = {
      available: true,
      companyBorne: [{ currency: 'MXN', amountMinor: '500000' }],
    };
    expect((await run(world, rejected, 'resolve')).status).toBe('resolved');
  });

  it('does not ask the approval without a threshold, and fails when the configuration cannot be read', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { status: 'insurance_rejected', ...FULL });
    expect((await run(world, rejected, 'resolve')).status).toBe('resolved');
    const again = await draft(world, { type: 'other' });
    const second = await put(world, again, { status: 'insurance_rejected', ...FULL });
    world.settings.fail = true;
    await expect(run(world, second, 'resolve')).rejects.toThrow('settings unavailable');
    expect((await world.store.get(TENANT_A, again.id))?.status).toBe('insurance_rejected');
  });
});

describe('cancel (case 13)', () => {
  it('needs a reason, and cancels with it', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await put(world, created, { status: 'under_review' });
    expect((await fail(run(world, reported, 'cancel'))).missingRequirements).toEqual(['reason']);
    expect(
      (await fail(run(world, reported, 'cancel', { reason: '   ' }))).missingRequirements,
    ).toEqual(['reason']);
    const cancelled = await run(world, reported, 'cancel', { reason: 'Duplicado' });
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Duplicado' });
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.cancelled',
      payload: { incidentId: created.id, version: cancelled.version },
    });
    expect((await world.store.history(TENANT_A, created.id)).at(-1)?.comment).toBe('Duplicado');
  });

  it('is refused with linked orders or costs, and fails closed without INC-COSTS', async () => {
    const world = setup();
    const created = await draft(world);
    const review = await put(world, created, { status: 'under_review' });
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'scheduled', version: 1, hasCosts: false }],
    };
    expect((await fail(run(world, review, 'cancel', { reason: 'x' }))).missingRequirements).toEqual(
      ['no_repairs'],
    );
    world.repairs.snapshot = { available: true, orders: [] };
    world.costs.costs = { available: true, hasCosts: true, hasRepairLine: false };
    expect((await fail(run(world, review, 'cancel', { reason: 'x' }))).missingRequirements).toEqual(
      ['no_costs'],
    );
    const error = await fail(
      world.failClosed.execute(TENANT_A, ADMIN, review.id, {
        command: 'cancel',
        version: review.version,
        reason: 'x',
      }),
    );
    expect(error.missingRequirements).toEqual(['no_costs', 'no_repairs']);
  });

  it('lets the author cancel a draft even without INC-COSTS (a draft has no costs or orders)', async () => {
    const world = setup();
    const own = await world.cases.create(TENANT_A, REPORTER, {
      vehicleId: 'vehicle-1',
      type: 'other',
    });
    const cancelled = await world.failClosed.execute(TENANT_A, REPORTER, own.id, {
      command: 'cancel',
      version: 1,
      reason: 'Me equivoqué',
    });
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('assign', () => {
  it('names a responsible who sees and manages cases, once per change', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await put(world, created, { status: 'reported' });
    expect((await fail(run(world, reported, 'assign'))).missingRequirements).toEqual([
      'responsible',
    ]);
    const assigned = await run(world, reported, 'assign', { responsibleId: MANAGER.subject });
    expect(assigned.responsibleId).toBe(MANAGER.id);
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.assigned',
      payload: { incidentId: created.id, version: assigned.version },
    });
    const again = await run(world, assigned, 'assign', { responsibleId: MANAGER.subject });
    expect(again.version).toBe(assigned.version);
  });

  it('refuses a generic editor (422), a foreign or unknown member (404) and a draft (409)', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await put(world, created, { status: 'reported' });
    const generic = await fail(run(world, reported, 'assign', { responsibleId: 'only-generic' }));
    expect([generic.code, generic.rule]).toEqual(['rule_violation', 'responsible_not_eligible']);
    for (const member of ['member-b', 'nobody'])
      expect((await fail(run(world, reported, 'assign', { responsibleId: member }))).code).toBe(
        'not_found',
      );
    const fresh = await draft(world);
    expect((await fail(run(world, fresh, 'assign', { responsibleId: MANAGER.subject }))).code).toBe(
      'invalid_transition',
    );
  });
});

describe('permissions (case 2)', () => {
  const states: Record<string, Incident['status']> = {
    report: 'draft',
    assign: 'reported',
    review: 'reported',
    insure: 'under_review',
    no_insurance: 'under_review',
    reject: 'insurance_process',
    appeal: 'insurance_rejected',
    repair: 'no_insurance',
    resolve: 'repair',
    cancel: 'under_review',
  };

  it('answers 403 to anyone without the permission of the command, however complete the case is', async () => {
    for (const [command, status] of Object.entries(states))
      for (const actor of [VIEWER, FLEET_EDITOR, REPORTER]) {
        const world = setup();
        const created = await draft(world, { type: 'other' });
        const incident = await put(world, created, { status, ...FULL });
        // The reporter is not the author of this draft, and never edits.
        const extra =
          command === 'assign'
            ? { responsibleId: 'x' }
            : command === 'cancel'
              ? { reason: 'x' }
              : {};
        const error = await fail(run(world, incident, command, extra, actor));
        expect([command, actor.id, error.code]).toEqual([command, actor.id, 'forbidden']);
      }
  });

  it('lets the author with incidents:report report and cancel their own draft, and no other', async () => {
    const world = setup();
    const own = await world.cases.create(TENANT_A, REPORTER, { ...COMPLETE_FOR_REPORTER });
    const other = await world.cases.create(TENANT_A, OTHER_REPORTER, { ...COMPLETE_FOR_REPORTER });
    expect((await fail(run(world, other, 'report', {}, REPORTER))).code).toBe('forbidden');
    expect((await fail(run(world, other, 'cancel', { reason: 'x' }, REPORTER))).code).toBe(
      'forbidden',
    );
    const reported = await run(world, own, 'report', {}, REPORTER);
    expect(reported.reportedBy).toBe(REPORTER.id);
    // Once reported it is no longer a draft, so the author's right ends.
    expect((await fail(run(world, reported, 'cancel', { reason: 'x' }, REPORTER))).code).toBe(
      'forbidden',
    );
  });

  it('knows the permissions of the approvals, the close and the reopening', async () => {
    const world = setup();
    const created = await draft(world);
    const generic = actorOf('00000000-0000-4000-8000-0000000000b1', [
      'view',
      'approve',
      'reopen',
      'incidents:view',
    ]);
    const closer = actorOf('00000000-0000-4000-8000-0000000000b2', [
      'incidents:view',
      'incidents:close',
    ]);
    expect(mayRun(generic, created, 'approve_close')).toBe(false);
    expect(mayRun(generic, created, 'reopen')).toBe(false);
    expect(mayRun(closer, created, 'close')).toBe(false);
    expect(
      mayRun(
        { ...closer, permissions: [...closer.permissions, 'incidents:view_costs'] },
        created,
        'close',
      ),
    ).toBe(true);
    expect(mayRun(ADMIN, created, 'approve_assumption')).toBe(true);
    expect(mayRun(ADMIN, created, 'reopen')).toBe(true);
    const mechanic = actorOf('00000000-0000-4000-8000-0000000000b3', ['incidents:view'], true);
    expect(mayRun(mechanic, created, 'report')).toBe(false);
  });

  it('lists nothing to run for a reader with only incidents:view (US-032)', async () => {
    const world = setup();
    const created = await draft(world);
    const reported = await put(world, created, { status: 'reported' });
    expect(allowedCommands(reported, VIEWER)).toEqual([]);
    expect(await world.workflow.nextSteps(TENANT_A, VIEWER, reported.id)).toEqual([]);
    expect(allowedCommands(reported, ADMIN)).toEqual(['assign', 'review', 'cancel']);
    expect(allowedCommands(reported, FLEET_EDITOR)).toEqual([]);
  });

  it('answers 403 without incidents:view and 404 for other tenants, closed to mechanics', async () => {
    const world = setup();
    const created = await draft(world);
    const blind = actorOf('00000000-0000-4000-8000-0000000000b4', ['incidents:edit']);
    expect((await fail(run(world, created, 'report', {}, blind))).code).toBe('forbidden');
    const stranger = await fail(
      world.workflow.execute('tenant-b', ADMIN, created.id, { command: 'report', version: 1 }),
    );
    expect(stranger.code).toBe('not_found');
    const mechanic = actorOf('00000000-0000-4000-8000-0000000000b3', ['incidents:view'], true);
    expect((await fail(run(world, created, 'report', {}, mechanic))).code).toBe('not_found');
    expect((await fail(run(world, { ...created, id: 'bad id' }, 'report'))).code).toBe('not_found');
    await expect(world.workflow.nextSteps('tenant-b', ADMIN, created.id)).rejects.toThrow(
      IncidentError,
    );
  });
});

const COMPLETE_FOR_REPORTER = {
  vehicleId: 'vehicle-1',
  type: 'collision',
  severity: 'low',
  driverId: 'driver-1',
  vehicleOperable: true,
  occurredAt: '2026-10-13T12:00:00.000Z',
  location: { text: 'Calle Sintética' },
  description: 'Descripción sintética',
  noPhotoJustification: 'Sin foto',
};

describe('next-steps (US-032)', () => {
  it('lists the allowed commands with what the case still lacks, and nothing that depends on input', async () => {
    const world = setup();
    const created = await world.cases.create(TENANT_A, MANAGER, {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    expect(await world.workflow.nextSteps(TENANT_A, ADMIN, created.id)).toEqual([
      {
        command: 'report',
        missingRequirements: [
          'occurred_at',
          'location',
          'description',
          'severity',
          'driver_or_reason',
          'vehicle_operable',
          'photo_or_justification',
        ],
      },
      { command: 'cancel', missingRequirements: ['no_costs', 'no_repairs'].filter(() => false) },
    ]);
    const review = await put(world, created, { status: 'under_review' });
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, review.id);
    expect(steps.map((step) => step.command)).toEqual([
      'assign',
      'insure',
      'no_insurance',
      'cancel',
    ]);
    expect(steps.find((step) => step.command === 'insure')?.missingRequirements).toEqual([
      'policy_at_event',
      'insurer',
      'claim_number',
      'insurer_reported_on',
    ]);
  });

  it('does not offer the approval of the assumption unless the amount calls for it', async () => {
    const world = setup();
    world.settings.threshold = { amountMinor: '100', currency: 'MXN' };
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { status: 'insurance_rejected', ...FULL });
    world.costs.borne = {
      available: true,
      companyBorne: [{ currency: 'MXN', amountMinor: '100' }],
    };
    const quiet = await world.workflow.nextSteps(TENANT_A, ADMIN, rejected.id);
    expect(JSON.stringify(quiet)).not.toContain('assumption_approval');
    world.costs.borne = { available: true, companyBorne: [{ currency: 'USD', amountMinor: '1' }] };
    expect(
      (await world.workflow.nextSteps(TENANT_A, ADMIN, rejected.id)).find(
        (step) => step.command === 'repair',
      )?.missingRequirements,
    ).toContain('assumption_approval');
  });
});

describe('version, idempotency and the commands of the second part (cases 10 and the keys)', () => {
  it('lets one of two commands with the same version win; the other is stale without effects', async () => {
    const world = setup();
    const created = await draft(world);
    const settled = await Promise.allSettled([
      run(world, created, 'report'),
      run(world, created, 'cancel', { reason: 'x' }),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as IncidentError).code).toBe('stale_version');
    expect(
      (await world.store.history(TENANT_A, created.id)).filter((e) => e.command !== 'create'),
    ).toHaveLength(1);
    expect(world.store.events.filter((e) => e.event.type !== 'incident.created')).toHaveLength(1);
  });

  it('refuses a stale version before it looks at the requirements', async () => {
    const world = setup();
    const created = await draft(world);
    const error = await fail(
      world.workflow.execute(TENANT_A, ADMIN, created.id, { command: 'report', version: 7 }),
    );
    expect(error.code).toBe('stale_version');
  });

  it('replays the stored result for the same key and body, whatever the version is by now', async () => {
    const world = setup();
    const created = await draft(world);
    const first = await run(world, created, 'report', {}, ADMIN, 'key-report-1');
    const moved = await put(world, first, { status: 'reported' });
    const replayed = await run(world, created, 'report', {}, ADMIN, 'key-report-1');
    expect(replayed).toEqual(first);
    expect(moved.version).toBeGreaterThan(first.version);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.status_changed'),
    ).toHaveLength(1);
    const clash = await fail(
      run(world, created, 'report', { comment: 'otro' }, ADMIN, 'key-report-1'),
    );
    expect(clash.code).toBe('idempotency_conflict');
  });

  it('runs a command once when twins race with the same key, and answers both the same', async () => {
    const world = setup();
    const created = await draft(world);
    const [a, b] = await Promise.all([
      run(world, created, 'report', {}, ADMIN, 'key-twin-0001'),
      run(world, created, 'report', {}, ADMIN, 'key-twin-0001'),
    ]);
    expect(a).toEqual(b);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.status_changed'),
    ).toHaveLength(1);
  });

  it('does not replay to a caller who may no longer run the command, nor to another incident', async () => {
    const world = setup();
    const created = await draft(world);
    await run(world, created, 'report', {}, ADMIN, 'key-report-2');
    expect((await fail(run(world, created, 'report', {}, VIEWER, 'key-report-2'))).code).toBe(
      'forbidden',
    );
    const other = await draft(world);
    expect((await fail(run(world, other, 'report', {}, ADMIN, 'key-report-2'))).code).toBe(
      'idempotency_conflict',
    );
  });

  it('forgets a key after its time, so the same key is a new command', async () => {
    let clock = new Date('2026-10-13T18:00:00.000Z');
    const world = setup(() => clock);
    const created = await draft(world);
    const first = await run(world, created, 'report', {}, ADMIN, 'key-expiring-1');
    clock = new Date('2026-10-14T19:00:00.000Z');
    const second = await fail(run(world, created, 'report', {}, ADMIN, 'key-expiring-1'));
    expect(second.code).toBe('invalid_transition');
    expect(first.status).toBe('reported');
  });

  it('rejects a malformed key, and asks for a key on the money-bearing commands', async () => {
    const world = setup();
    const created = await draft(world);
    expect((await fail(run(world, created, 'report', {}, ADMIN, 'short'))).code).toBe(
      'invalid_input',
    );
    for (const command of ['approve_assumption', 'approve_close', 'close', 'reopen']) {
      expect((await fail(run(world, created, command))).code).toBe('idempotency_key_required');
      expect((await fail(run(world, created, command, {}, ADMIN, 'key-second-part'))).code).toBe(
        'invalid_transition',
      );
    }
  });
});

describe('input of the commands', () => {
  it('names every bad field of the body and rejects fields of another command', async () => {
    const world = setup();
    const created = await draft(world);
    const body = await fail(world.workflow.execute(TENANT_A, ADMIN, created.id, 'x'));
    expect(body.fieldErrors).toEqual([{ field: 'body', code: 'invalid' }]);
    const error = await fail(
      world.workflow.execute(TENANT_A, ADMIN, created.id, {
        command: 'jump',
        version: 0,
        reason: 'x',
        responsibleId: 'bad id',
        comment: 7,
        extra: true,
      }),
    );
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'command', code: 'invalid' },
        { field: 'version', code: 'invalid' },
        { field: 'extra', code: 'unknown_property' },
        { field: 'responsibleId', code: 'invalid' },
        { field: 'comment', code: 'invalid' },
      ]),
    );
    const missing = await fail(world.workflow.execute(TENANT_A, ADMIN, created.id, {}));
    expect(missing.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'command', code: 'required' },
        { field: 'version', code: 'required' },
      ]),
    );
    const misplaced = await fail(
      run(world, created, 'report', { reason: 'x', responsibleId: 'a' }),
    );
    expect(misplaced.fieldErrors).toEqual([
      { field: 'responsibleId', code: 'unknown_property' },
      { field: 'reason', code: 'unknown_property' },
    ]);
  });
});

describe('timeline, audit and events carry no free text', () => {
  it('keeps the comment in the timeline only', async () => {
    const world = setup();
    const created = await draft(world);
    await run(world, created, 'cancel', { reason: 'Texto libre sintético del motivo' });
    expect(JSON.stringify(world.store.events)).not.toContain('Texto libre');
    expect(JSON.stringify(world.store.audit)).not.toContain('Texto libre');
    const entry = (await world.store.history(TENANT_A, created.id)).at(-1);
    expect(JSON.stringify(entry?.before)).not.toContain('Texto libre');
    expect(entry?.comment).toBe('Texto libre sintético del motivo');
  });
});

export { INCIDENT_COMMANDS };
