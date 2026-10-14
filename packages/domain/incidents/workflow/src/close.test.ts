import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident } from '../../cases/src/index.js';
import { allowedCommands, mayRun } from './access.js';
import { approvalRequired } from './d20.js';
import type { LinkedRepairOrder } from './ports.js';
import {
  ADMIN,
  FLEET_EDITOR,
  FULL,
  TENANT_A,
  actorOf,
  draft,
  put,
  reload,
  resolvedFrom,
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
  key = `key-${command}-${incident.id}-${incident.version}`,
) =>
  world.workflow.execute(
    TENANT_A,
    actor,
    incident.id,
    { command, version: incident.version, ...extra },
    key,
  );
const MXN = (amountMinor: string) => ({ currency: 'MXN', amountMinor });
const THRESHOLD = { amountMinor: '500000', currency: 'MXN' };
const borne = (world: World, ...amounts: { currency: string; amountMinor: string }[]) => {
  world.costs.borne = { available: true, companyBorne: amounts };
};

/** A case resolved straight from review, ready to close unless the test says otherwise. */
async function resolved(world: World, patch: Partial<Incident> = {}) {
  const created = await draft(world, { type: 'other' });
  return put(
    world,
    created,
    { ...FULL, status: 'resolved', resolvedAt: '2026-10-13T17:00:00.000Z', ...patch },
    [resolvedFrom('under_review')],
  );
}

describe('D20 by amount (case 8)', () => {
  it('asks for an approval only when what the company bears is strictly above the threshold', () => {
    const totals = (...amounts: { currency: string; amountMinor: string }[]) =>
      ({ available: true, companyBorne: amounts }) as const;
    expect(approvalRequired(null, totals(MXN('900000000')))).toBe(false);
    expect(approvalRequired(THRESHOLD, totals(MXN('499999')))).toBe(false);
    expect(approvalRequired(THRESHOLD, totals(MXN('500000')))).toBe(false);
    expect(approvalRequired(THRESHOLD, totals(MXN('500001')))).toBe(true);
    expect(approvalRequired(THRESHOLD, totals(MXN('-100'), MXN('0')))).toBe(false);
    expect(approvalRequired(THRESHOLD, totals({ currency: 'USD', amountMinor: '10000' }))).toBe(
      true,
    );
    expect(approvalRequired(THRESHOLD, totals({ currency: 'USD', amountMinor: '0' }))).toBe(false);
    expect(approvalRequired(THRESHOLD, { available: false })).toBe(true);
  });

  it('closes without approval at or below the threshold, and asks one above it, then accepts it', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    for (const amount of ['499999', '500000']) {
      borne(world, MXN(amount));
      const incident = await resolved(world);
      const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, incident.id);
      expect(steps.find((step) => step.command === 'close')?.missingRequirements).toEqual([]);
      expect((await run(world, incident, 'close')).status).toBe('closed');
    }
    borne(world, MXN('500001'));
    const incident = await resolved(world);
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, incident.id);
    expect(steps.find((step) => step.command === 'close')?.missingRequirements).toEqual([
      'close_approval',
    ]);
    const refused = await fail(run(world, incident, 'close'));
    expect([refused.code, refused.missingRequirements]).toEqual([
      'missing_requirements',
      ['close_approval'],
    ]);
    const approved = await run(world, incident, 'approve_close');
    expect(approved.closeApproval).toEqual({ by: ADMIN.id, at: '2026-10-13T18:00:00.000Z' });
    expect((await run(world, approved, 'close')).status).toBe('closed');
  });

  it('lists the approvals as steps only while they are due (amount above the threshold, none standing)', async () => {
    const world = setup();
    const commandsOf = async (incident: Incident) =>
      (await world.workflow.nextSteps(TENANT_A, ADMIN, incident.id)).map((step) => step.command);
    // No threshold: nothing to approve.
    borne(world, MXN('900000'));
    expect(await commandsOf(await resolved(world))).not.toContain('approve_close');
    world.settings.threshold = THRESHOLD;
    // At the threshold, not above it.
    borne(world, MXN('500000'));
    expect(await commandsOf(await resolved(world))).not.toContain('approve_close');
    // Above it: the approval is the step, and it is not once given.
    borne(world, MXN('500001'));
    const incident = await resolved(world);
    expect(await commandsOf(incident)).toContain('approve_close');
    const approved = await run(world, incident, 'approve_close');
    expect(await commandsOf(approved)).not.toContain('approve_close');
    // Costs outgrew it: due again.
    world.closureCosts.stale = true;
    expect(await commandsOf(approved)).toContain('approve_close');
    // The assumption approval follows the same rule.
    world.closureCosts.stale = false;
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { status: 'insurance_rejected', ...FULL });
    borne(world, MXN('500000'));
    expect(await commandsOf(rejected)).not.toContain('approve_assumption');
    borne(world, MXN('500001'));
    expect(await commandsOf(rejected)).toContain('approve_assumption');
  });

  it('records what each approval covered, and asks again when the costs outgrow it (close and assumption)', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    borne(world, MXN('600000'));
    const incident = await resolved(world);
    const approved = await run(world, incident, 'approve_close');
    expect(world.closureCosts.approved.map((a) => a.kind)).toEqual(['close']);
    // Costs grew in maintenance after the approval: it no longer stands, in the steps and at the close.
    world.closureCosts.stale = true;
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, approved.id);
    expect(steps.find((step) => step.command === 'close')?.missingRequirements).toEqual([
      'close_approval',
    ]);
    expect((await fail(run(world, approved, 'close'))).missingRequirements).toEqual([
      'close_approval',
    ]);
    // Approving again is not a no-op now: it records the new figures.
    const again = await run(world, approved, 'approve_close', {}, ADMIN, 'key-reapprove-close');
    expect(again.version).toBe(approved.version + 1);
    expect(world.closureCosts.approved).toHaveLength(2);
    world.closureCosts.stale = false;
    expect((await run(world, again, 'close')).status).toBe('closed');
  });

  it('the assumption approval also lapses when the costs outgrow it', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    world.evidence.add('invoice');
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { ...FULL, status: 'insurance_rejected' });
    borne(world, MXN('600000'));
    const approved = await run(world, rejected, 'approve_assumption');
    world.closureCosts.stale = true;
    expect((await fail(run(world, approved, 'resolve'))).missingRequirements).toEqual([
      'assumption_approval',
    ]);
    world.closureCosts.stale = false;
    expect((await run(world, approved, 'resolve')).status).toBe('resolved');
  });

  it('asks an approval for a cost in another currency, and drops the demand when recoveries bring it down', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    borne(world, { currency: 'USD', amountMinor: '10000' });
    const incident = await resolved(world);
    expect((await fail(run(world, incident, 'close'))).missingRequirements).toEqual([
      'close_approval',
    ]);
    borne(world, MXN('450000'));
    expect((await run(world, incident, 'close')).status).toBe('closed');
  });

  it('asks for the approval when the totals cannot be read, and fails the command when the settings cannot', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const incident = await resolved(world);
    world.costs.borne = { available: false };
    expect((await fail(run(world, incident, 'close'))).missingRequirements).toEqual([
      'close_approval',
    ]);
    world.settings.fail = true;
    await expect(run(world, incident, 'close')).rejects.toThrow('settings unavailable');
    expect((await reload(world, incident)).status).toBe('resolved');
  });

  it('never asks or invents an approval without a threshold, and refuses to record one', async () => {
    const world = setup();
    world.costs.borne = { available: false };
    const incident = await resolved(world);
    const refused = await fail(run(world, incident, 'approve_close'));
    expect(refused.missingRequirements).toEqual(['d20_configured']);
    expect((await run(world, incident, 'close')).status).toBe('closed');
  });

  it('follows the same table for the assumption after a rejection, and asks again at the close', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    world.evidence.add('invoice');
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { ...FULL, status: 'insurance_rejected' });
    borne(world, MXN('500000'));
    const resolve = await run(world, rejected, 'resolve');
    expect(resolve.status).toBe('resolved');

    // Over the threshold the assumption needs its approval first.
    borne(world, MXN('500001'));
    const other = await put(world, created, { ...FULL, status: 'insurance_rejected' });
    expect((await fail(run(world, other, 'resolve'))).missingRequirements).toEqual([
      'assumption_approval',
    ]);
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, other.id);
    expect(steps.find((step) => step.command === 'resolve')?.missingRequirements).toEqual([
      'assumption_approval',
    ]);
    const approved = await run(world, other, 'approve_assumption');
    expect(approved.assumptionApproval?.by).toBe(ADMIN.id);
    // Costs grew after the assumption was approved at a lower figure: the close asks its own approval.
    expect((await run(world, approved, 'resolve')).status).toBe('resolved');
    const closing = await reload(world, other);
    expect((await fail(run(world, closing, 'close'))).missingRequirements).toEqual([
      'close_approval',
    ]);
  });

  it('reads the totals again inside the transaction: costs that grew after the facts were read refuse the close', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const incident = await resolved(world);
    let reads = 0;
    world.costs.totals = async () => {
      reads += 1;
      return { available: true, companyBorne: [MXN(reads === 1 ? '100' : '900000')] };
    };
    const error = await fail(run(world, incident, 'close'));
    expect(error.missingRequirements).toEqual(['close_approval']);
    expect(await world.closures.list(TENANT_A, incident.id)).toEqual([]);
    expect(world.store.events.filter((entry) => entry.event.type === 'incident.closed')).toEqual(
      [],
    );
    expect((await reload(world, incident)).status).toBe('resolved');
  });

  it('checks the threshold again for an approval, and the assumption approval inside the write', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { ...FULL, status: 'insurance_rejected' });
    let reads = 0;
    world.settings.closeCostThreshold = async () => {
      reads += 1;
      return reads === 1 ? THRESHOLD : null;
    };
    expect((await fail(run(world, rejected, 'approve_assumption'))).missingRequirements).toEqual([
      'd20_configured',
    ]);
    reads = 0;
    world.costs.totals = async () => {
      reads += 1;
      return { available: true, companyBorne: [MXN(reads === 1 ? '1' : '900000')] };
    };
    world.settings.closeCostThreshold = async () => THRESHOLD;
    world.evidence.add('budget');
    world.repairs.snapshot = { available: true, orders: [] };
    expect((await fail(run(world, rejected, 'repair'))).missingRequirements).toEqual([
      'assumption_approval',
    ]);
  });
});

describe('approvals', () => {
  it('needs incidents:approve (the generic verb grants nothing), records once and emits no status change', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const incident = await resolved(world);
    const generic = actorOf('00000000-0000-4000-8000-0000000000b1', [
      'incidents:view',
      'approve',
      'edit',
    ]);
    expect(mayRun(generic, incident, 'approve_close')).toBe(false);
    expect(mayRun(FLEET_EDITOR, incident, 'approve_close')).toBe(false);
    expect((await fail(run(world, incident, 'approve_close', {}, generic))).code).toBe('forbidden');

    const approved = await run(world, incident, 'approve_close');
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.updated',
      payload: { incidentId: incident.id, version: approved.version },
    });
    expect((await world.store.history(TENANT_A, incident.id)).at(-1)).toMatchObject({
      command: 'approve_close',
      from: 'resolved',
      to: 'resolved',
      changedFields: ['closeApproval'],
    });
    // The same approval again changes nothing, with a new key as well.
    const again = await run(world, approved, 'approve_close', {}, ADMIN, 'key-another-one');
    expect(again.version).toBe(approved.version);
    expect(world.store.events.filter((e) => e.event.type === 'incident.updated')).toHaveLength(1);
  });

  it('is only offered where the state allows it and drops when the resolution changes', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const incident = await resolved(world);
    expect(allowedCommands(incident, ADMIN)).toEqual(
      expect.arrayContaining(['approve_close', 'close', 'assign', 'cancel']),
    );
    expect(allowedCommands(incident, ADMIN)).not.toContain('approve_assumption');
    const approved = await run(world, incident, 'approve_close');
    const edited = await world.process.updateResolution(TENANT_A, ADMIN, incident.id, {
      version: approved.version,
      resolutionSummary: 'Resolución corregida',
    });
    expect(edited.closeApproval).toBeNull();
  });

  it('records the assumption approval after a rejection and drops it with an appeal', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const created = await draft(world, { type: 'other' });
    const rejected = await put(world, created, { ...FULL, status: 'insurance_rejected' });
    const approved = await run(world, rejected, 'approve_assumption');
    expect(approved.status).toBe('insurance_rejected');
    expect((await run(world, approved, 'approve_assumption')).version).toBe(approved.version);
    const appealed = await run(world, approved, 'appeal');
    expect(appealed.assumptionApproval).toBeNull();
  });
});

describe('close with snapshot (cases 9, 11 and 16)', () => {
  it('closes, stamps who and when, writes one closure row, one event and the timeline', async () => {
    const world = setup();
    const incident = await resolved(world, { insurerResult: 'accepted' });
    world.repairs.snapshot = {
      available: true,
      orders: [
        { orderId: 'o1', status: 'closed', version: 4, hasCosts: true },
        { orderId: 'o2', status: 'cancelled', version: 2, hasCosts: false },
      ],
    };
    const closed = await run(world, incident, 'close', { comment: 'Cierre' });
    expect(closed).toMatchObject({
      status: 'closed',
      closedAt: '2026-10-13T18:00:00.000Z',
      closedBy: ADMIN.id,
    });
    expect(await world.closures.list(TENANT_A, incident.id)).toEqual([
      {
        tenantId: TENANT_A,
        incidentId: incident.id,
        cycle: 1,
        statusBefore: 'resolved',
        resolvedFrom: 'under_review',
        resolvedAt: '2026-10-13T17:00:00.000Z',
        resolutionSummary: FULL.resolutionSummary,
        totalLoss: null,
        vehicleStatusDecision: 'active',
        insurerResult: 'accepted',
        costAssumed: true,
        closeApprovedBy: null,
        closeApprovedAt: null,
        orders: [{ orderId: 'o1', version: 4, status: 'closed' }],
        closedAt: '2026-10-13T18:00:00.000Z',
        closedBy: ADMIN.id,
      },
    ]);
    expect(world.closureCosts.taken).toEqual([
      {
        tenantId: TENANT_A,
        incidentId: incident.id,
        cycle: 1,
        closedAt: '2026-10-13T18:00:00.000Z',
      },
    ]);
    const events = world.store.events.filter((entry) => entry.event.type === 'incident.closed');
    expect(events.map((entry) => entry.event.payload)).toEqual([
      { incidentId: incident.id, vehicleId: incident.vehicleId, version: closed.version },
    ]);
    expect((await world.store.history(TENANT_A, incident.id)).at(-1)).toMatchObject({
      command: 'close',
      from: 'resolved',
      to: 'closed',
      comment: 'Cierre',
    });
    expect(world.store.audit.at(-1)?.action).toBe('incident.close');
  });

  it('re-reads the linked orders inside the transaction: a reopened order aborts, the snapshot keeps the fresh ones', async () => {
    const world = setup();
    const incident = await resolved(world, { insurerResult: 'accepted' });
    const closedOrder: LinkedRepairOrder = {
      orderId: 'o1',
      status: 'closed',
      version: 4,
      hasCosts: true,
    };
    const reads: unknown[] = [];
    // The first read (before the write) sees the order closed; the one in the transaction sees what happened since.
    let inTransaction: LinkedRepairOrder = { ...closedOrder, status: 'in_progress', version: 5 };
    (world.repairs as { linkedOrders: unknown }).linkedOrders = async (
      _tenant: string,
      _incident: string,
      tx?: unknown,
    ) => {
      reads.push(tx);
      return {
        available: true,
        orders: [reads.length === 1 ? closedOrder : inTransaction],
      };
    };
    await expect(run(world, incident, 'close')).rejects.toMatchObject({
      code: 'missing_requirements',
      missingRequirements: ['repair_orders_closed'],
    });
    expect(reads).toHaveLength(2);
    expect(await world.closures.list(TENANT_A, incident.id)).toEqual([]);
    expect(world.closureCosts.taken).toEqual([]);
    expect((await world.store.get(TENANT_A, incident.id))?.status).toBe('resolved');
    // The order changed in a way that still allows the closure: the closure keeps the version it saw there.
    reads.length = 0;
    inTransaction = { ...closedOrder, version: 6 };
    await run(world, incident, 'close');
    expect(await world.closures.list(TENANT_A, incident.id)).toMatchObject([
      { orders: [{ orderId: 'o1', version: 6, status: 'closed' }] },
    ]);
  });

  it('closes without reading orders again when the route never went through repair and the port is unavailable', async () => {
    const world = setup();
    const incident = await resolved(world, { insurerResult: 'accepted' });
    world.repairs.snapshot = { available: false };
    const closed = await run(world, incident, 'close');
    expect(closed.status).toBe('closed');
    expect(await world.closures.list(TENANT_A, incident.id)).toMatchObject([{ orders: [] }]);
  });

  it('needs incidents:close together with incidents:view_costs', async () => {
    const world = setup();
    const incident = await resolved(world);
    for (const permissions of [
      ['incidents:view', 'incidents:close'],
      ['incidents:view', 'incidents:view_costs'],
      ['incidents:view', 'close', 'view_costs'],
    ])
      expect(
        (
          await fail(
            run(
              world,
              incident,
              'close',
              {},
              actorOf('00000000-0000-4000-8000-0000000000c1', permissions),
            ),
          )
        ).code,
      ).toBe('forbidden');
  });

  it('names what is missing: evidence still being scanned and orders not yet closed', async () => {
    const world = setup();
    const incident = await resolved(world);
    world.evidence.add('other', false);
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'completed', version: 2, hasCosts: true }],
    };
    expect((await fail(run(world, incident, 'close'))).missingRequirements).toEqual([
      'no_pending_evidence',
      'repair_orders_closed',
    ]);
    world.evidence.items = [];
    world.repairs.snapshot = { available: true, orders: [] };
    expect((await run(world, incident, 'close')).status).toBe('closed');
  });

  it('revalidates what resolving asked on the route of the cycle', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const viaRepair = await put(
      world,
      created,
      { ...FULL, status: 'resolved', resolutionSummary: null },
      [resolvedFrom('repair')],
    );
    world.repairs.snapshot = {
      available: true,
      orders: [{ orderId: 'o1', status: 'completed', version: 2, hasCosts: false }],
    };
    world.costs.costs = { available: true, hasCosts: true, hasRepairLine: false };
    expect((await fail(run(world, viaRepair, 'close'))).missingRequirements).toEqual([
      'resolution_summary',
      'repair_costs',
      'final_evidence',
      'repair_orders_closed',
    ]);
    const insurer = await put(
      world,
      viaRepair,
      { resolutionSummary: 'x', insurerResult: 'pending' },
      [resolvedFrom('insurance_process')],
    );
    expect((await fail(run(world, insurer, 'close'))).missingRequirements).toEqual([
      'insurer_result',
      'repair_orders_closed',
    ]);
  });

  it('does not close a case whose route is unknown, nor one through repair without INC-COSTS', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const unknown = await put(world, created, { ...FULL, status: 'resolved' });
    expect((await fail(run(world, unknown, 'close'))).missingRequirements).toEqual([
      'resolve_origin',
    ]);
    const viaRepair = await put(world, unknown, { resolutionSummary: 'x' }, [
      resolvedFrom('repair'),
    ]);
    const missing = await fail(
      world.failClosed.execute(
        TENANT_A,
        ADMIN,
        viaRepair.id,
        { command: 'close', version: viaRepair.version },
        'key-fail-closed-2',
      ),
    );
    expect(missing.missingRequirements).toEqual(
      expect.arrayContaining(['repair_orders_finished', 'repair_costs', 'repair_orders_closed']),
    );
  });

  it('closes a case that never touched repair even without INC-COSTS connected', async () => {
    const world = setup();
    const incident = await resolved(world);
    const closed = await world.failClosed.execute(
      TENANT_A,
      ADMIN,
      incident.id,
      { command: 'close', version: incident.version },
      'key-fail-closed',
    );
    expect(closed.status).toBe('closed');
  });

  it('refuses every other command and every edit once closed (case 11)', async () => {
    const world = setup();
    const closed = await run(world, await resolved(world), 'close');
    expect(allowedCommands(closed, ADMIN)).toEqual(['reopen']);
    for (const command of ['assign', 'review', 'cancel', 'resolve', 'close', 'approve_close'])
      expect(
        (
          await fail(
            run(
              world,
              closed,
              command,
              command === 'assign' ? { responsibleId: ADMIN.subject } : {},
            ),
          )
        ).code,
        command,
      ).toBe('invalid_transition');
    expect(
      (
        await fail(
          world.process.updateResolution(TENANT_A, ADMIN, closed.id, {
            version: closed.version,
            totalLoss: true,
          }),
        )
      ).code,
    ).toBe('invalid_transition');
    expect(
      (
        await fail(
          world.process.updateInsurance(TENANT_A, ADMIN, closed.id, {
            version: closed.version,
            claimNumber: 'X',
          }),
        )
      ).code,
    ).toBe('invalid_transition');
  });

  it('keeps one closure for the same key and body, and refuses another body or a missing key (case 9)', async () => {
    const world = setup();
    const incident = await resolved(world);
    const [a, b] = await Promise.all([
      run(world, incident, 'close', {}, ADMIN, 'key-close-twin'),
      run(world, incident, 'close', {}, ADMIN, 'key-close-twin'),
    ]);
    expect(a).toEqual(b);
    expect(await world.closures.list(TENANT_A, incident.id)).toHaveLength(1);
    expect(world.store.events.filter((e) => e.event.type === 'incident.closed')).toHaveLength(1);
    expect(
      (await fail(run(world, incident, 'close', { comment: 'otro' }, ADMIN, 'key-close-twin')))
        .code,
    ).toBe('idempotency_conflict');
    const second = await resolved(world);
    expect(
      (
        await fail(
          world.workflow.execute(TENANT_A, ADMIN, second.id, {
            command: 'close',
            version: second.version,
          }),
        )
      ).code,
    ).toBe('idempotency_key_required');
  });

  it('leaves no state change, closure, snapshot or event when the cost snapshot fails (case 16)', async () => {
    const world = setup();
    const incident = await resolved(world);
    world.closureCosts.fail = true;
    await expect(run(world, incident, 'close')).rejects.toThrow('cost snapshot failed');
    expect(await reload(world, incident)).toEqual(incident);
    expect(await world.closures.list(TENANT_A, incident.id)).toEqual([]);
    expect(world.store.events.filter((e) => e.event.type === 'incident.closed')).toEqual([]);
    expect(await world.store.history(TENANT_A, incident.id)).toHaveLength(2);
    world.closureCosts.fail = false;
    expect((await run(world, incident, 'close')).status).toBe('closed');
  });

  it('refuses the closure when its cycle already has a row', async () => {
    const world = setup();
    const incident = await resolved(world);
    const closure = {
      tenantId: TENANT_A,
      incidentId: incident.id,
      cycle: 1,
      statusBefore: 'resolved',
      resolvedFrom: 'under_review',
    } as never;
    await world.closures.record(closure);
    expect((await fail(run(world, incident, 'close'))).code).toBe('stale_version');
    expect((await reload(world, incident)).status).toBe('resolved');
  });
});

describe('vehicle decision (case 14)', () => {
  it('refuses active while another cause holds the vehicle, at resolve and at close', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const review = await put(world, created, { ...FULL, status: 'under_review' });
    world.blocks.blocked_ = true;
    const blocked = await fail(run(world, review, 'resolve'));
    expect([blocked.code, blocked.rule]).toEqual(['rule_violation', 'vehicle_blocked']);
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, review.id);
    expect(steps.find((step) => step.command === 'resolve')?.missingRequirements).toEqual([
      'vehicle_blocked',
    ]);
    const other = await put(world, review, { vehicleStatusDecision: 'restricted' });
    expect((await run(world, other, 'resolve')).status).toBe('resolved');

    const incident = await resolved(world);
    expect((await fail(run(world, incident, 'close'))).rule).toBe('vehicle_blocked');
    world.blocks.blocked_ = false;
    expect((await run(world, incident, 'close')).status).toBe('closed');
  });

  it('fails the command when the blocks cannot be read', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const review = await put(world, created, { ...FULL, status: 'under_review' });
    world.blocks.fail = true;
    await expect(run(world, review, 'resolve')).rejects.toThrow('blocks unavailable');
  });
});

describe('reopen with cycle (case 12)', () => {
  const cycle = async (world: World, incident: Incident) => {
    const closed = await run(world, incident, 'close');
    return run(world, closed, 'reopen', { reason: 'Nueva evidencia' });
  };

  it('needs incidents:reopen and a reason', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    const closed = await run(world, await resolved(world), 'close');
    const closer = actorOf('00000000-0000-4000-8000-0000000000d1', [
      'incidents:view',
      'incidents:close',
      'incidents:view_costs',
      'reopen',
    ]);
    expect((await fail(run(world, closed, 'reopen', { reason: 'x' }, closer))).code).toBe(
      'forbidden',
    );
    const lacking = await fail(run(world, closed, 'reopen'));
    expect([lacking.code, lacking.missingRequirements]).toEqual([
      'missing_requirements',
      ['reason'],
    ]);
    const steps = await world.workflow.nextSteps(TENANT_A, ADMIN, closed.id);
    expect(steps).toEqual([{ command: 'reopen', missingRequirements: [] }]);
  });

  it('opens a new cycle, clears the approvals and the closing stamp, and keeps the snapshot', async () => {
    const world = setup();
    world.settings.threshold = THRESHOLD;
    borne(world, MXN('900000'));
    const incident = await resolved(world);
    const approved = await run(world, incident, 'approve_close');
    const reopened = await cycle(world, approved);
    expect(reopened).toMatchObject({
      status: 'reopened',
      cycle: 2,
      reopenCount: 1,
      closeApproval: null,
      assumptionApproval: null,
      closedAt: null,
      closedBy: null,
    });
    const [first] = await world.closures.list(TENANT_A, incident.id);
    expect(first).toMatchObject({ cycle: 1, closeApprovedBy: ADMIN.id });
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.reopened',
      payload: { incidentId: incident.id, version: reopened.version, cycle: 2 },
    });
    expect((await world.store.history(TENANT_A, incident.id)).at(-1)).toMatchObject({
      command: 'reopen',
      from: 'closed',
      to: 'reopened',
      comment: 'Nueva evidencia',
      before: expect.objectContaining({ cycle: 1, reopenCount: 0 }),
    });
  });

  it('closes again in cycle two with two intact rows and the full timeline', async () => {
    const world = setup();
    const incident = await resolved(world);
    const reopened = await cycle(world, incident);
    const review = await run(world, reopened, 'review');
    expect(review.status).toBe('under_review');
    const resolvedAgain = await run(
      world,
      await put(world, review, { resolutionSummary: 'Segunda resolución' }),
      'resolve',
    );
    const closed = await run(world, resolvedAgain, 'close');
    expect(closed.cycle).toBe(2);
    const rows = await world.closures.list(TENANT_A, incident.id);
    expect(rows.map((row) => [row.cycle, row.resolutionSummary])).toEqual([
      [1, FULL.resolutionSummary],
      [2, 'Segunda resolución'],
    ]);
    expect(rows[1]?.resolvedFrom).toBe('under_review');
    expect(
      (await world.store.history(TENANT_A, incident.id)).map((entry) => entry.command),
    ).toEqual(['create', 'resolve', 'close', 'reopen', 'review', 'resolve', 'close']);
    expect(closed.reopenCount).toBe(1);
  });

  it('can go on from reopened to repair with a responsible', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const closed = await put(world, created, { ...FULL, status: 'closed', responsibleId: null });
    const reopened = await run(world, closed, 'reopen', { reason: 'Falta reparar' });
    world.evidence.add('budget');
    world.repairs.snapshot = { available: true, orders: [] };
    expect((await fail(run(world, reopened, 'repair'))).missingRequirements).toEqual([
      'responsible',
    ]);
  });

  it('does not reopen a cancelled case', async () => {
    const world = setup();
    const created = await draft(world, { type: 'other' });
    const cancelled = await put(world, created, { status: 'cancelled' });
    expect((await fail(run(world, cancelled, 'reopen', { reason: 'x' }))).code).toBe(
      'invalid_transition',
    );
  });
});
