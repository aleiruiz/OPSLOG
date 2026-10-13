import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident } from '../../cases/src/index.js';
import { setupChildren } from '../../third-parties/src/test-support.js';
import { approvalRequired } from './d20.js';
import { GuardedEvidenceService } from './evidence-guard.js';
import type { EvidenceFact, RepairsSnapshot } from './ports.js';
import { ADMIN, FLEET_EDITOR, FULL, TENANT_A, VIEWER, draft, put, setup } from './test-support.js';

const fail = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe('insurer data (PUT insurance)', () => {
  it('merges what is sent, keeps the rest, and records one entry with field names only', async () => {
    const world = setup();
    const created = await draft(world);
    const review = await put(world, created, { status: 'under_review' });
    const updated = await world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
      version: review.version,
      insurerName: 'Aseguradora Sintética',
      claimNumber: 'REP-9',
      insurerReportedOn: '2026-10-13',
      insurerResult: 'pending',
    });
    expect(updated).toMatchObject({ claimNumber: 'REP-9', version: review.version + 1 });
    const entry = (await world.store.history(TENANT_A, review.id)).at(-1);
    expect(entry).toMatchObject({ command: 'insurance_updated' });
    expect(entry?.changedFields).toEqual([
      'claimNumber',
      'insurerName',
      'insurerReportedOn',
      'insurerResult',
    ]);
    expect(JSON.stringify(world.store.events.at(-1))).not.toContain('REP-9');
    const cleared = await world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
      version: updated.version,
      claimNumber: null,
    });
    expect(cleared.claimNumber).toBeNull();
    expect(cleared.insurerName).toBe('Aseguradora Sintética');
  });

  it('answers a no-op with the case as it is, with no version, entry or event', async () => {
    const world = setup();
    const review = await put(world, await draft(world), { status: 'under_review', ...FULL });
    const events = world.store.events.length;
    const same = await world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
      version: review.version,
      claimNumber: review.claimNumber,
    });
    expect(same).toEqual(review);
    expect(world.store.events).toHaveLength(events);
  });

  it('choosing a policy replaces the snapshot and preloads the insurer name', async () => {
    const world = setup();
    const review = await put(world, await draft(world), { status: 'under_review' });
    const updated = await world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
      version: review.version,
      policyId: 'pol-1',
    });
    expect(updated.coverageStatus).toBe('covered');
    expect(updated.policySnapshot).not.toBeNull();
    expect(updated.insurerName).toBe(updated.policySnapshot?.insurer);
    const named = await put(world, await draft(world), {
      status: 'under_review',
      insurerName: 'Propia',
    });
    const keeps = await world.process.updateInsurance(TENANT_A, ADMIN, named.id, {
      version: named.version,
      policyId: 'pol-1',
    });
    expect(keeps.insurerName).toBe('Propia');
    const none = await world.process.updateInsurance(TENANT_A, ADMIN, named.id, {
      version: keeps.version,
      policyId: null,
    });
    // No chosen policy: the one in force on the day of the event applies.
    expect(none.coverageStatus).toBe('covered');
  });

  it('refuses a report day in the future or before the event', async () => {
    const world = setup();
    const review = await put(world, await draft(world), { status: 'under_review' });
    const future = await fail(
      world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
        version: review.version,
        insurerReportedOn: '2099-01-01',
      }),
    );
    expect([future.code, future.rule]).toEqual(['rule_violation', 'insurer_reported_on_in_future']);
    const before = await fail(
      world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
        version: review.version,
        insurerReportedOn: '2000-01-01',
      }),
    );
    expect(before.rule).toBe('insurer_reported_on_before_event');
  });

  it('answers 403, 404, 409 (terminal and wrong state), stale version and 400 in that order', async () => {
    const world = setup();
    const created = await draft(world);
    const body = { version: created.version, claimNumber: 'X' };
    expect(
      (await fail(world.process.updateInsurance(TENANT_A, ADMIN, created.id, body))).code,
    ).toBe('invalid_transition');
    const review = await put(world, created, { status: 'under_review' });
    for (const actor of [VIEWER, FLEET_EDITOR])
      expect(
        (
          await fail(
            world.process.updateInsurance(TENANT_A, actor, review.id, {
              ...body,
              version: review.version,
            }),
          )
        ).code,
      ).toBe('forbidden');
    expect(
      (await fail(world.process.updateInsurance('tenant-b', ADMIN, review.id, body))).code,
    ).toBe('not_found');
    expect((await fail(world.process.updateInsurance(TENANT_A, ADMIN, review.id, body))).code).toBe(
      'stale_version',
    );
    const bad = await fail(
      world.process.updateInsurance(TENANT_A, ADMIN, review.id, {
        version: review.version,
        insurerResult: 'maybe',
        insurerReportedOn: '2026-02-31',
        claimNumber: 5,
        other: 1,
      }),
    );
    expect(bad.fieldErrors?.map((issue) => issue.field).sort()).toEqual([
      'claimNumber',
      'insurerReportedOn',
      'insurerResult',
      'other',
    ]);
    expect(
      (
        await fail(
          world.process.updateInsurance(TENANT_A, ADMIN, review.id, { version: review.version }),
        )
      ).fieldErrors,
    ).toEqual([{ field: 'body', code: 'required' }]);
    for (const status of ['closed', 'cancelled'] as const) {
      const done = await put(world, await draft(world), { status });
      expect(
        (
          await fail(
            world.process.updateInsurance(TENANT_A, ADMIN, done.id, {
              version: done.version,
              claimNumber: 'Y',
            }),
          )
        ).code,
      ).toBe('invalid_transition');
    }
  });
});

describe('resolution (PUT resolution)', () => {
  it('stores the summary, the decision and the flags, and drops the approvals when it changes', async () => {
    const world = setup();
    const repair = await put(world, await draft(world), {
      status: 'repair',
      assumptionApproval: { by: ADMIN.id, at: '2026-10-13T10:00:00.000Z' },
    });
    const updated = await world.process.updateResolution(TENANT_A, ADMIN, repair.id, {
      version: repair.version,
      resolutionSummary: 'Se reparó',
      vehicleStatusDecision: 'active',
      totalLoss: false,
      costAssumed: true,
    });
    expect(updated).toMatchObject({
      resolutionSummary: 'Se reparó',
      vehicleStatusDecision: 'active',
      totalLoss: false,
      costAssumed: true,
      assumptionApproval: null,
    });
    expect((await world.store.history(TENANT_A, repair.id)).at(-1)?.command).toBe(
      'resolution_updated',
    );
    expect(JSON.stringify(world.store.events.at(-1))).not.toContain('Se reparó');
    const bad = await fail(
      world.process.updateResolution(TENANT_A, ADMIN, repair.id, {
        version: updated.version,
        vehicleStatusDecision: 'sold',
        totalLoss: 'yes',
      }),
    );
    expect(bad.fieldErrors?.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(['vehicleStatusDecision', 'totalLoss']),
    );
  });

  it('does not touch the approvals on a no-op, and is refused from a draft or a closed case', async () => {
    const world = setup();
    const approval = { by: ADMIN.id, at: '2026-10-13T10:00:00.000Z' };
    const resolved = await put(world, await draft(world), {
      status: 'resolved',
      resolutionSummary: 'Igual',
      closeApproval: approval,
    });
    const same = await world.process.updateResolution(TENANT_A, ADMIN, resolved.id, {
      version: resolved.version,
      resolutionSummary: 'Igual',
    });
    expect(same.closeApproval).toEqual(approval);
    for (const status of ['draft', 'reported', 'closed', 'cancelled'] as const) {
      const other = await put(world, await draft(world), { status });
      expect(
        (
          await fail(
            world.process.updateResolution(TENANT_A, ADMIN, other.id, {
              version: other.version,
              costAssumed: true,
            }),
          )
        ).code,
      ).toBe('invalid_transition');
    }
  });
});

describe('D20 by amount', () => {
  const threshold = { amountMinor: '1000', currency: 'MXN' };
  it('asks only above the threshold, in any amount of another currency, or when totals are unknown', () => {
    expect(approvalRequired(null, { available: false })).toBe(false);
    expect(approvalRequired(threshold, { available: false })).toBe(true);
    expect(approvalRequired(threshold, { available: true, companyBorne: [] })).toBe(false);
    const borne = (currency: string, amountMinor: string) => ({
      available: true as const,
      companyBorne: [{ currency, amountMinor }],
    });
    expect(approvalRequired(threshold, borne('MXN', '1000'))).toBe(false);
    expect(approvalRequired(threshold, borne('MXN', '1001'))).toBe(true);
    expect(approvalRequired(threshold, borne('USD', '0'))).toBe(false);
    expect(approvalRequired(threshold, borne('USD', '1'))).toBe(true);
    expect(approvalRequired(threshold, borne('MXN', '99999999999999999999'))).toBe(true);
  });
});

describe('evidence guard (ADR-0014)', () => {
  async function guarded() {
    const world = setupChildren();
    const owner = { ...ADMIN };
    let orders: RepairsSnapshot = { available: true, orders: [] };
    const evidenceFacts = {
      evidence: async (tenantId: string, incidentId: string): Promise<readonly EvidenceFact[]> => {
        const rows = await world.children.evidence(tenantId, incidentId);
        return Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            category: row.category,
            stage: row.stage,
            clean: (await world.files.record(tenantId, row.fileId))?.status === 'clean',
          })),
        );
      },
    };
    const service = new GuardedEvidenceService(world.store, world.children, world.files, {
      evidence: evidenceFacts,
      repairs: { linkedOrders: async () => orders },
    });
    const incident = await world.draft();
    const inRepair = await world.store.apply({
      incident: { ...incident, status: 'repair', version: incident.version + 1 },
      expectedVersion: incident.version,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    if (!inRepair.applied) throw new Error('fixture');
    let current: Incident = inRepair.incident;
    const attach = async (
      category: 'budget' | 'photo',
      status: 'clean' | 'pending_scan' = 'clean',
    ) => {
      const fileId = world.files.add(TENANT_A, owner.id, status);
      const result = await service.attach(TENANT_A, owner, current.id, {
        version: current.version,
        fileId,
        category,
        stage: 'on_site',
      });
      current = result.incident;
      return result.evidence.id;
    };
    return {
      service,
      attach,
      owner,
      orders: (next: RepairsSnapshot) => (orders = next),
      get current() {
        return current;
      },
    };
  }

  it('refuses to unlink the only budget in repair, naming the requirement, and keeps the link', async () => {
    const g = await guarded();
    const budget = await g.attach('budget');
    const error = await fail(
      g.service.detach(TENANT_A, g.owner, g.current.id, budget, { version: g.current.version }),
    );
    expect([error.code, error.missingRequirements]).toEqual([
      'missing_requirements',
      ['repair_order_or_budget'],
    ]);
  });

  it('lets it go when another clean budget or a linked order remains, or the rest is not the budget', async () => {
    const g = await guarded();
    const first = await g.attach('budget');
    await g.attach('budget');
    const after = await g.service.detach(TENANT_A, g.owner, g.current.id, first, {
      version: g.current.version,
    });
    expect(after.version).toBeGreaterThan(1);
    const g2 = await guarded();
    const only = await g2.attach('budget');
    g2.orders({
      available: true,
      orders: [{ orderId: 'o1', status: 'in_progress', version: 1, hasCosts: false }],
    });
    await g2.service.detach(TENANT_A, g2.owner, g2.current.id, only, {
      version: g2.current.version,
    });
    const g3 = await guarded();
    await g3.attach('budget');
    const photo = await g3.attach('photo');
    await g3.service.detach(TENANT_A, g3.owner, g3.current.id, photo, {
      version: g3.current.version,
    });
  });

  it('answers a stale version as the base does', async () => {
    const g = await guarded();
    const budget = await g.attach('budget');
    const stale = await fail(
      g.service.detach(TENANT_A, g.owner, g.current.id, budget, { version: 1 }),
    );
    expect(stale.code).toBe('stale_version');
  });
});
