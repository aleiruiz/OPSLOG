import { describe, expect, it } from 'vitest';
import {
  COVERAGE_TYPES,
  InMemoryPolicyStore,
  PolicyError,
  PolicyService,
  applyArchive,
  applyPatch,
  applyRenewal,
  coversOn,
  newPolicy,
  parseDeductible,
  parseNewPolicy,
  parsePolicyPatch,
  parseRenewal,
  revisionOf,
  writesDeductible,
  type Policy,
  type PolicyStore,
  type PolicyVehicleGate,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const body = (over: Record<string, unknown> = {}) => ({
  vehicleId: 'veh-1',
  insurer: 'Aseguradora Ficticia',
  policyNumber: 'pol-001',
  coverageType: 'comprehensive',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  ...over,
});

function service(over: { vehicles?: PolicyVehicleGate; store?: PolicyStore; now?: Date } = {}) {
  let ids = 0;
  let clock = over.now ?? NOW;
  const store = over.store ?? new InMemoryPolicyStore();
  const svc = new PolicyService(store, {
    ...(over.vehicles ? { vehicles: over.vehicles } : {}),
    now: () => clock,
    newId: () => `pol-${(ids += 1)}`,
  });
  return {
    svc,
    store,
    setNow: (value: Date) => {
      clock = value;
    },
  };
}

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return 'ok';
};
const invalid = (run: () => unknown, label = '') => expect(run, label).toThrow(PolicyError);

describe('parsing', () => {
  it('normalizes a new policy and defaults the optional parts', () => {
    expect(
      parseNewPolicy(body({ insurer: '  Aseguradora   Ficticia ', policyNumber: ' pol  001 ' })),
    ).toEqual({
      vehicleId: 'veh-1',
      insurer: 'Aseguradora Ficticia',
      coverageNotes: null,
      revision: {
        policyNumber: 'POL 001',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
        deductible: null,
      },
    });
    expect(
      parseNewPolicy(body({ coverageNotes: ' RC y robo ', deductible: null })).coverageNotes,
    ).toBe('RC y robo');
  });

  it('rejects unknown, missing and malformed fields', () => {
    for (const input of [
      null,
      [],
      'x',
      body({ extra: 1 }),
      body({ vehicleId: '../x' }),
      body({ insurer: 'A' }),
      body({ insurer: 'bad\u0007name' }),
      body({ policyNumber: '' }),
      body({ policyNumber: '-x' }),
      body({ coverageType: 'unknown' }),
      body({ coverageNotes: '' }),
      body({ startsOn: '2026-13-01' }),
      body({ startsOn: '2026-02-30' }),
      body({ startsOn: '1949-12-31' }),
      body({ endsOn: '2101-01-01' }),
      body({ endsOn: 20261231 }),
      body({ startsOn: '2026-06-01', endsOn: '2026-05-31' }),
    ])
      invalid(() => parseNewPolicy(input), JSON.stringify(input));
    for (const key of [
      'vehicleId',
      'insurer',
      'policyNumber',
      'coverageType',
      'startsOn',
      'endsOn',
    ]) {
      const input: Record<string, unknown> = body();
      delete input[key];
      invalid(() => parseNewPolicy(input));
    }
    expect(parseNewPolicy(body({ startsOn: '2026-12-31' })).revision.startsOn).toBe('2026-12-31');
  });

  it('validates deductibles as exact integers of their kind', () => {
    expect(parseDeductible({ kind: 'amount', amountMinor: 500000, currency: 'MXN' })).toEqual({
      kind: 'amount',
      amountMinor: 500000,
      currency: 'MXN',
    });
    expect(parseDeductible({ kind: 'percent', basisPoints: 1500 })).toEqual({
      kind: 'percent',
      basisPoints: 1500,
    });
    for (const value of [
      null,
      'x',
      {},
      { kind: 'other' },
      { kind: 'amount', amountMinor: 0, currency: 'MXN' },
      { kind: 'amount', amountMinor: 1.5, currency: 'MXN' },
      { kind: 'amount', amountMinor: 1_000_000_000_001, currency: 'MXN' },
      { kind: 'amount', amountMinor: '5', currency: 'MXN' },
      { kind: 'amount', amountMinor: 5, currency: 'mxn' },
      { kind: 'amount', amountMinor: 5, currency: 'MXNN' },
      { kind: 'amount', amountMinor: 5 },
      { kind: 'amount', amountMinor: 5, currency: 'MXN', basisPoints: 1 },
      { kind: 'percent', basisPoints: 0 },
      { kind: 'percent', basisPoints: 10001 },
      { kind: 'percent', basisPoints: 1.5 },
      { kind: 'percent', basisPoints: 5, currency: 'MXN' },
    ])
      invalid(() => parseDeductible(value));
    expect(parseDeductible({ kind: 'percent', basisPoints: 10000 })).toMatchObject({
      basisPoints: 10000,
    });
    expect(parseDeductible({ kind: 'amount', amountMinor: 1_000_000_000_000, currency: 'USD' }));
  });

  it('detects a write of the deductible (null and absent are not a write)', () => {
    expect(writesDeductible({ deductible: { kind: 'percent', basisPoints: 5 } })).toBe(true);
    for (const input of [{}, { deductible: null }, { deductible: undefined }, null, [], 'x'])
      expect(writesDeductible(input)).toBe(false);
  });

  it('parses renewals, carrying the rest over from the current revision', () => {
    const current = newPolicy(
      A,
      'p1',
      parseNewPolicy(body({ deductible: { kind: 'percent', basisPoints: 1000 } })),
      NOW,
    );
    const period = { startsOn: '2027-01-01', endsOn: '2027-12-31' };
    expect(parseRenewal(period, current)).toEqual({
      policyNumber: 'POL-001',
      coverageType: 'comprehensive',
      ...period,
      deductible: { kind: 'percent', basisPoints: 1000 },
    });
    expect(
      parseRenewal(
        { ...period, policyNumber: 'pol-002', coverageType: 'third_party', deductible: null },
        current,
      ),
    ).toMatchObject({ policyNumber: 'POL-002', coverageType: 'third_party', deductible: null });
    expect(
      parseRenewal(
        { ...period, deductible: { kind: 'amount', amountMinor: 900, currency: 'USD' } },
        current,
      ).deductible,
    ).toEqual({ kind: 'amount', amountMinor: 900, currency: 'USD' });
    for (const input of [
      {},
      { startsOn: '2027-01-01' },
      { ...period, extra: 1 },
      { ...period, coverageType: 'x' },
      { ...period, policyNumber: '' },
      { startsOn: '2027-02-01', endsOn: '2027-01-01' },
      { ...period, deductible: { kind: 'percent' } },
    ])
      invalid(() => parseRenewal(input, current));
  });

  it('parses patches: insurer and notes only, at least one', () => {
    expect(parsePolicyPatch({ insurer: ' Otra   Aseguradora ' })).toEqual({
      insurer: 'Otra Aseguradora',
    });
    expect(parsePolicyPatch({ coverageNotes: null })).toEqual({ coverageNotes: null });
    expect(parsePolicyPatch({ coverageNotes: 'nota' })).toEqual({ coverageNotes: 'nota' });
    for (const input of [{}, { policyNumber: 'X1' }, { insurer: '' }, { coverageNotes: '' }, null])
      invalid(() => parsePolicyPatch(input));
  });
});

describe('pure state changes', () => {
  const policy = (): Policy => newPolicy(A, 'p1', parseNewPolicy(body()), NOW);

  it('starts at revision 1, version 1', () => {
    expect(policy()).toMatchObject({ revision: 1, version: 1, archivedAt: null, tenantId: A });
    expect(revisionOf(policy(), ACTOR, NOW)).toMatchObject({
      policyId: 'p1',
      revision: 1,
      actorId: ACTOR,
      endsOn: '2026-12-31',
      deductible: null,
    });
  });

  it('checks the version and refuses archived policies', () => {
    const later = new Date('2026-10-07T00:00:00.000Z');
    const archived = applyArchive(policy(), 1, later);
    expect(archived).toMatchObject({ version: 2, archivedAt: later.toISOString() });
    for (const run of [
      () => applyPatch(policy(), { insurer: 'Otra' }, 2, NOW),
      () =>
        applyRenewal(
          policy(),
          parseRenewal({ startsOn: '2027-01-01', endsOn: '2027-12-31' }, policy()),
          2,
          NOW,
        ),
      () => applyArchive(policy(), 3, NOW),
    ])
      expect(run).toThrow(expect.objectContaining({ code: 'stale_version' }));
    for (const run of [
      () => applyPatch(archived, { insurer: 'Otra' }, 2, NOW),
      () => applyRenewal(archived, policy(), 2, NOW),
      () => applyArchive(archived, 2, NOW),
    ])
      expect(run).toThrow(expect.objectContaining({ code: 'immutable' }));
  });

  it('knows whether a day is covered, both ends inclusive', () => {
    const p = { startsOn: '2026-01-01', endsOn: '2026-12-31' };
    expect(coversOn(p, '2025-12-31')).toBe(false);
    expect(coversOn(p, '2026-01-01')).toBe(true);
    expect(coversOn(p, '2026-12-31')).toBe(true);
    expect(coversOn(p, '2027-01-01')).toBe(false);
    expect(COVERAGE_TYPES).toContain('mandatory_liability');
  });
});

describe('PolicyService', () => {
  it('creates, reads, edits, renews keeping history, and archives', async () => {
    const { svc } = service();
    const created = await svc.create(
      A,
      ACTOR,
      body({ deductible: { kind: 'amount', amountMinor: 500000, currency: 'MXN' } }),
    );
    expect(created).toMatchObject({
      id: 'pol-1',
      revision: 1,
      version: 1,
      policyNumber: 'POL-001',
    });
    expect(await svc.get(A, created.id)).toEqual(created);
    const edited = await svc.update(A, created.id, 1, {
      insurer: 'Otra Aseguradora',
      coverageNotes: 'ok',
    });
    expect(edited).toMatchObject({ insurer: 'Otra Aseguradora', version: 2, revision: 1 });
    const renewed = await svc.renew(A, ACTOR, created.id, 2, {
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
      policyNumber: 'pol-002',
    });
    expect(renewed).toMatchObject({
      revision: 2,
      version: 3,
      policyNumber: 'POL-002',
      endsOn: '2027-12-31',
      insurer: 'Otra Aseguradora',
      deductible: { kind: 'amount', amountMinor: 500000, currency: 'MXN' },
    });
    const history = await svc.history(A, created.id);
    expect(history.total).toBe(2);
    expect(history.items.map((r) => [r.revision, r.policyNumber, r.endsOn, r.status])).toEqual([
      [2, 'POL-002', '2027-12-31', 'valid'],
      [1, 'POL-001', '2026-12-31', 'replaced'],
    ]);
    expect(
      (await svc.history(A, created.id, { limit: 1, offset: 1 })).items.map((r) => r.revision),
    ).toEqual([1]);
    await expect(
      svc.renew(A, ACTOR, created.id, 2, { startsOn: '2028-01-01', endsOn: '2028-12-31' }),
    ).rejects.toMatchObject({ code: 'stale_version' });
    const archived = await svc.archive(A, created.id, 3);
    expect(archived.archivedAt).toBe(NOW.toISOString());
    expect(await code(svc.update(A, created.id, 4, { insurer: 'Otra' }))).toBe('immutable');
    expect(
      await code(
        svc.renew(A, ACTOR, created.id, 4, { startsOn: '2028-01-01', endsOn: '2028-12-31' }),
      ),
    ).toBe('immutable');
    expect(await code(svc.archive(A, created.id, 4))).toBe('immutable');
    expect((await svc.history(A, created.id)).total).toBe(2);
  });

  it('is isolated by tenant and answers not_found uniformly', async () => {
    const { svc } = service();
    const created = await svc.create(A, ACTOR, body());
    for (const run of [
      () => svc.get(B, created.id),
      () => svc.get(A, 'pol-404'),
      () => svc.update(B, created.id, 1, { insurer: 'Otra' }),
      () => svc.renew(B, ACTOR, created.id, 1, { startsOn: '2027-01-01', endsOn: '2027-12-31' }),
      () => svc.archive(B, created.id, 1),
      () => svc.history(B, created.id),
    ])
      expect(await code(run())).toBe('not_found');
    expect((await svc.list(B)).total).toBe(0);
    expect((await svc.list(A)).total).toBe(1);
  });

  it('validates identifiers, versions and windows', async () => {
    const { svc } = service();
    expect(await code(svc.get(A, '../x'))).toBe('invalid_input');
    expect(await code(svc.get('bad id', 'pol-1'))).toBe('invalid_input');
    expect(await code(svc.create(A, 'bad actor', body()))).toBe('invalid_input');
    expect(await code(svc.create('bad tenant', ACTOR, body()))).toBe('invalid_input');
    const created = await svc.create(A, ACTOR, body());
    expect(await code(svc.update(A, created.id, 0, { insurer: 'Otra' }))).toBe('invalid_input');
    expect(await code(svc.archive(A, created.id, '1'))).toBe('invalid_input');
    expect(await code(svc.renew(A, 'bad actor', created.id, 1, {}))).toBe('invalid_input');
    expect(await code(svc.history(A, created.id, { limit: 0 }))).toBe('invalid_input');
    expect(await code(svc.history(A, created.id, { offset: -1 }))).toBe('invalid_input');
    expect(await code(svc.list(A, { limit: 101 }))).toBe('invalid_input');
  });

  it('lists with filters, ordered by end date', async () => {
    const { svc } = service();
    const mk = (over: Record<string, unknown>) => svc.create(A, ACTOR, body(over));
    const p1 = await mk({ endsOn: '2026-12-01', policyNumber: 'P1' });
    const p2 = await mk({ endsOn: '2026-10-01', policyNumber: 'P2' });
    const p3 = await mk({
      endsOn: '2026-10-20',
      vehicleId: 'veh-2',
      policyNumber: 'P3',
      coverageType: 'mandatory_liability',
    });
    const p4 = await mk({ startsOn: '2027-01-01', endsOn: '2027-12-31', policyNumber: 'P4' });
    const ids = async (query: Record<string, unknown>) =>
      (await svc.list(A, query)).items.map((p) => p.id);
    expect(await ids({})).toEqual([p2.id, p3.id, p1.id, p4.id]);
    expect(await ids({ vehicleId: 'veh-2' })).toEqual([p3.id]);
    expect(await ids({ coverageType: 'mandatory_liability' })).toEqual([p3.id]);
    expect(await ids({ status: 'expired' })).toEqual([p2.id]);
    expect(await ids({ status: 'expiring' })).toEqual([p3.id]);
    expect(await ids({ status: 'valid' })).toEqual([p1.id, p4.id]);
    expect(await ids({ coversOn: '2026-10-06' })).toEqual([p3.id, p1.id]);
    expect(await ids({ coversOn: '2027-06-01' })).toEqual([p4.id]);
    expect(await ids({ limit: 2, offset: 1 })).toEqual([p3.id, p1.id]);
    await svc.archive(A, p2.id, 1);
    expect(await ids({ status: 'expired' })).toEqual([]);
    expect(await ids({ status: 'expired', includeArchived: true })).toEqual([p2.id]);
    for (const query of [
      { coverageType: 'x' },
      { status: 'x' },
      { includeArchived: 'yes' },
      { vehicleId: '../x' },
      { coversOn: '2026-02-30' },
    ])
      expect(await code(svc.list(A, query))).toBe('invalid_input');
  });

  it('derives the status from the clock: the last day is inclusive', async () => {
    const { svc, setNow } = service({ now: new Date('2026-12-30T10:00:00.000Z') });
    const policy = await svc.create(A, ACTOR, body({ startsOn: '2026-12-30' }));
    expect(svc.expiry(policy)).toEqual({ status: 'expiring', daysToExpiry: 1 });
    expect(svc.covering(policy)).toBe(true);
    setNow(new Date('2026-12-31T23:59:59.000Z'));
    expect(svc.expiry(policy)).toEqual({ status: 'expiring', daysToExpiry: 0 });
    expect(svc.covering(policy)).toBe(true);
    setNow(new Date('2027-01-01T00:00:00.000Z'));
    expect(svc.expiry(policy)).toEqual({ status: 'expired', daysToExpiry: -1 });
    expect(svc.covering(policy)).toBe(false);
    expect((await svc.history(A, policy.id)).items[0]?.status).toBe('expired');
  });

  it('checks the vehicle on create and renew, not on reads, edits or archive', async () => {
    const calls: string[] = [];
    let live = true;
    const { svc } = service({
      vehicles: {
        assertLive: async (tenantId, vehicleId) => {
          calls.push(`${tenantId}/${vehicleId}`);
          if (!live) throw new PolicyError('invalid_vehicle', 'vehicle_id');
        },
      },
    });
    const created = await svc.create(A, ACTOR, body());
    expect(calls).toEqual(['tenant-a/veh-1']);
    live = false;
    await svc.get(A, created.id);
    await svc.update(A, created.id, 1, { insurer: 'Otra' });
    await expect(svc.create(A, ACTOR, body())).rejects.toMatchObject({
      code: 'invalid_vehicle',
      field: 'vehicle_id',
    });
    await expect(
      svc.renew(A, ACTOR, created.id, 2, { startsOn: '2027-01-01', endsOn: '2027-12-31' }),
    ).rejects.toMatchObject({ code: 'invalid_vehicle' });
    // A stale or archived policy never reaches the vehicle module.
    calls.length = 0;
    await expect(
      svc.renew(A, ACTOR, created.id, 1, { startsOn: '2027-01-01', endsOn: '2027-12-31' }),
    ).rejects.toMatchObject({ code: 'stale_version' });
    expect(calls).toEqual([]);
    await svc.archive(A, created.id, 2);
    expect(calls).toEqual([]);
  });

  it('labels the history from the rows read, even when a renewal lands between the reads', async () => {
    const inner = new InMemoryPolicyStore();
    let renewNext: (() => Promise<unknown>) | undefined;
    const store: PolicyStore = {
      find: (...args) => inner.find(...args),
      list: (...args) => inner.list(...args),
      insert: (...args) => inner.insert(...args),
      replace: (...args) => inner.replace(...args),
      revisions: async (...args) => {
        const action = renewNext;
        renewNext = undefined;
        if (action) await action();
        return inner.revisions(...args);
      },
    };
    const { svc } = service({ store });
    const policy = await svc.create(A, ACTOR, body({ endsOn: '2026-12-31' }));
    renewNext = () =>
      svc.renew(A, ACTOR, policy.id, 1, { startsOn: '2027-01-01', endsOn: '2028-12-31' });
    const history = await svc.history(A, policy.id);
    expect(history.items.map((r) => [r.revision, r.status])).toEqual([
      [2, 'valid'],
      [1, 'replaced'],
    ]);
    const older = await svc.history(A, policy.id, { limit: 1, offset: 1 });
    expect(older.items.map((r) => [r.revision, r.status])).toEqual([[1, 'replaced']]);
    expect((await svc.history(A, policy.id, { limit: 1, offset: 5 })).items).toEqual([]);
  });

  it('resolves a lost race as stale_version, or not_found when the row is gone', async () => {
    const inner = new InMemoryPolicyStore();
    let finds = 0;
    let vanish = false;
    const store: PolicyStore = {
      find: async (tenantId, id) => {
        finds += 1;
        return vanish && finds > 1 ? null : inner.find(tenantId, id);
      },
      list: (...args) => inner.list(...args),
      insert: (...args) => inner.insert(...args),
      replace: async () => false,
      revisions: (...args) => inner.revisions(...args),
    };
    const { svc } = service({ store });
    const created = await svc.create(A, ACTOR, body());
    expect(await code(svc.update(A, created.id, 1, { insurer: 'Otra' }))).toBe('stale_version');
    finds = 0;
    vanish = true;
    expect(await code(svc.update(A, created.id, 1, { insurer: 'Otra' }))).toBe('not_found');
  });

  it('returns defensive copies', async () => {
    const { svc, store } = service();
    const policy = await svc.create(A, ACTOR, body());
    const found = (await store.find(A, policy.id)) as { insurer: string };
    found.insurer = 'mutated';
    expect((await svc.get(A, policy.id)).insurer).toBe('Aseguradora Ficticia');
  });
});
