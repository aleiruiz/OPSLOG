import { describe, expect, it } from 'vitest';
import { demoPolicies, makePolicy } from '../insurance/fixtures';
import { createMockApi, demoCredentials } from './mockApi';
import { createMockInsuranceStore } from './mockInsurance';
import type { InsurancePolicyInput } from './types';

const input: InsurancePolicyInput = {
  vehicleId: 'veh-001',
  insurer: '  Seguros   Demo ',
  policyNumber: 'pol 9/1',
  coverageType: 'comprehensive',
  startsOn: '2026-11-01',
  endsOn: '2027-10-31',
};
const amount = { kind: 'amount', amountMinor: 500_000, currency: 'MXN' } as const;
const failure = (status: number, code: string) => ({ ok: false, error: { status, code } });

describe('mock insurance store', () => {
  it('lists by end date, filters (including the covered day), hides archived rows and pages with a cursor', async () => {
    const { port } = createMockInsuranceStore([
      ...demoPolicies(28),
      makePolicy({ id: 'pol-arch', archivedAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    const first = await port.list({ limit: 25 });
    expect(first).toMatchObject({ ok: true, value: { total: 28, nextCursor: 'mock:25' } });
    const all = await port.list({ limit: 100 });
    const ends = (all.ok ? all.value.items : []).map((item) => item.endsOn);
    expect(ends).toEqual([...ends].sort());
    const tail = await port.list({ limit: 25, cursor: 'mock:25' });
    expect(tail.ok && tail.value.nextCursor).toBeNull();
    const withArchived = await port.list({ includeArchived: 'true', limit: 100 });
    expect(withArchived.ok && withArchived.value.total).toBe(29);
    const expired = await port.list({ status: 'expired', limit: 100 });
    expect(expired.ok && expired.value.items.every((item) => item.status === 'expired')).toBe(true);
    const covering = await port.list({ coversOn: '2026-10-06', limit: 100 });
    expect(covering.ok && covering.value.items.every((item) => item.covering)).toBe(true);
    const type = await port.list({ coverageType: 'third_party', vehicleId: 'veh-003' });
    expect(type.ok && type.value.items.every((item) => item.vehicleId === 'veh-003')).toBe(true);
  });

  it('derives status and covering from the clock: both ends are inclusive and a future policy is not covering', async () => {
    const store = createMockInsuranceStore(
      [
        makePolicy({ id: 'a', startsOn: '2026-10-06', endsOn: '2026-10-06' }),
        makePolicy({ id: 'b', startsOn: '2025-10-06', endsOn: '2026-10-05' }),
        makePolicy({ id: 'c', startsOn: '2026-10-07', endsOn: '2027-10-06' }),
      ],
      { now: () => new Date('2026-10-06T23:59:59.000Z') },
    );
    const read = async (id: string) => {
      const result = await store.port.get(id);
      return result.ok
        ? [result.value.status, result.value.daysToExpiry, result.value.covering]
        : null;
    };
    expect(await read('a')).toEqual(['expiring', 0, true]);
    expect(await read('b')).toEqual(['expired', -1, false]);
    expect(await read('c')).toEqual(['valid', 365, false]);
  });

  it('rejects malformed queries with a uniform 400', async () => {
    const { port } = createMockInsuranceStore();
    for (const query of [
      { limit: 10 as 25 },
      { cursor: 'otro' },
      { vehicleId: 'no válido' },
      { coverageType: 'nada' as 'other' },
      { status: 'volando' as 'valid' },
      { coversOn: '2026-02-30' },
      { includeArchived: 'si' as 'true' },
    ])
      expect(await port.list(query)).toMatchObject(failure(400, 'bad_request'));
  });

  it('creates a policy with normalized text, version 1 and a first revision', async () => {
    const store = createMockInsuranceStore([]);
    const created = await store.port.create({
      ...input,
      coverageNotes: ' Incluye cristales ',
      deductible: amount,
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        insurer: 'Seguros Demo',
        policyNumber: 'POL 9/1',
        coverageNotes: 'Incluye cristales',
        revision: 1,
        version: 1,
        hasDeductible: true,
        deductible: amount,
      },
    });
    const id = created.ok ? created.value.id : '';
    const history = await store.port.history(id);
    expect(history.ok && history.value.items).toHaveLength(1);
    expect((await store.port.create({ ...input, deductible: null })).ok).toBe(true);
  });

  it.each([
    ['unknown key', { extra: 1 }],
    ['vehicle id', { vehicleId: 'no válido' }],
    ['short insurer', { insurer: 'x' }],
    ['numeric insurer', { insurer: 7 }],
    ['numeric notes', { coverageNotes: 7 }],
    ['control characters in notes', { coverageNotes: 'a\nb' }],
    ['policy number', { policyNumber: '***' }],
    ['numeric policy number', { policyNumber: 7 }],
    ['coverage', { coverageType: 'nada' }],
    ['period', { startsOn: '2027-01-02', endsOn: '2027-01-01' }],
    ['date', { endsOn: '2027-02-30' }],
    ['deductible kind', { deductible: { kind: 'otro' } }],
    ['deductible text', { deductible: 'mucho' }],
    ['amount of zero', { deductible: { ...amount, amountMinor: 0 } }],
    ['amount with a decimal', { deductible: { ...amount, amountMinor: 1.5 } }],
    ['currency', { deductible: { ...amount, currency: 'mxn' } }],
    ['amount with an extra key', { deductible: { ...amount, extra: 1 } }],
    ['percentage above 100', { deductible: { kind: 'percent', basisPoints: 10_001 } }],
    ['percentage with an extra key', { deductible: { kind: 'percent', basisPoints: 5, x: 1 } }],
  ])('rejects a creation with a bad %s with a uniform 400', async (_name, change) => {
    const { port } = createMockInsuranceStore([]);
    expect(
      await port.create({ ...input, ...change } as unknown as InsurancePolicyInput),
    ).toMatchObject(failure(400, 'bad_request'));
  });

  it('refuses a vehicle that is unknown or archived with the same 422 on field vehicle_id', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.vehicles.archive('veh-002', 1);
    for (const vehicleId of ['veh-inexistente', 'veh-002'])
      expect(await api.insurance.create({ ...input, vehicleId })).toMatchObject({
        ok: false,
        error: { status: 422, code: 'invalid_vehicle', fieldErrors: [{ field: 'vehicle_id' }] },
      });
    expect(await api.insurance.create(input)).toMatchObject({ ok: true });
  });

  it('gates the deductible by view_costs: hidden on every read, and any request that mentions it is a 403 before validation', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.dispatch);
    // pol-002 has an amount deductible in the demo set.
    const read = await api.insurance.get('pol-002');
    expect(read).toMatchObject({ ok: true, value: { hasDeductible: true, deductible: null } });
    const list = await api.insurance.list({ limit: 100 });
    expect(list.ok && list.value.items.every((item) => item.deductible === null)).toBe(true);
    expect(list.ok && list.value.items.some((item) => item.hasDeductible)).toBe(true);
    const history = await api.insurance.history('pol-002');
    expect(history.ok && history.value.items.every((item) => item.deductible === null)).toBe(true);
    // Even an explicit null or a malformed value is a 403, never a 400.
    for (const deductible of [null, amount, 'basura'])
      expect(
        await api.insurance.create({ ...input, deductible } as unknown as InsurancePolicyInput),
      ).toMatchObject(failure(403, 'forbidden'));
    expect(
      await api.insurance.renew('pol-002', {
        version: 1,
        startsOn: '2026-11-01',
        endsOn: '2027-10-31',
        deductible: null,
      }),
    ).toMatchObject(failure(403, 'forbidden'));
    // Omitting the key is allowed: the renewal carries the deductible over untouched.
    expect(
      await api.insurance.renew('pol-002', {
        version: 1,
        startsOn: '2026-11-01',
        endsOn: '2027-10-31',
      }),
    ).toMatchObject({ ok: true, value: { hasDeductible: true, deductible: null } });
    await api.auth.login(demoCredentials.admin);
    expect(await api.insurance.get('pol-002')).toMatchObject({
      ok: true,
      value: { deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' } },
    });
  });

  it('edits only the insurer and the notes, and bumps the version', async () => {
    const store = createMockInsuranceStore([makePolicy({ coverageNotes: 'Antes' })]);
    expect(
      await store.port.update('pol-001', { version: 1, insurer: ' Otra   aseguradora ' }),
    ).toMatchObject({
      ok: true,
      value: { insurer: 'Otra aseguradora', coverageNotes: 'Antes', version: 2, revision: 1 },
    });
    expect(await store.port.update('pol-001', { version: 2, coverageNotes: null })).toMatchObject({
      ok: true,
      value: { coverageNotes: null },
    });
    expect(
      await store.port.update('pol-001', { version: 3, coverageNotes: ' Hola ' }),
    ).toMatchObject({
      ok: true,
      value: { coverageNotes: 'Hola' },
    });
    expect(await store.port.update('pol-001', { version: 1, insurer: 'Vieja' })).toMatchObject(
      failure(409, 'stale_version'),
    );
    expect(await store.port.update('pol-999', { version: 1, insurer: 'xx' })).toMatchObject(
      failure(404, 'not_found'),
    );
    for (const patch of [
      { version: 4 },
      { version: 0, insurer: 'xx' },
      { version: 4, insurer: 'x' },
      { version: 4, insurer: 7 },
      { version: 4, coverageNotes: 7 },
      { version: 4, coverageNotes: 'a\nb' },
      { version: 4, policyNumber: 'X' },
    ])
      expect(
        await store.port.update('pol-001', patch as unknown as { version: number }),
      ).toMatchObject(failure(400, 'bad_request'));
  });

  it('renews by appending a revision: number, coverage and deductible carry over when omitted, and null removes the deductible', async () => {
    const store = createMockInsuranceStore([
      makePolicy({ deductible: amount, hasDeductible: true }),
    ]);
    const renewed = await store.port.renew('pol-001', {
      version: 1,
      startsOn: '2027-03-01',
      endsOn: '2028-02-29',
    });
    expect(renewed).toMatchObject({
      ok: true,
      value: {
        revision: 2,
        version: 2,
        policyNumber: 'POL-2026-0001',
        coverageType: 'comprehensive',
        deductible: amount,
        endsOn: '2028-02-29',
      },
    });
    const changed = await store.port.renew('pol-001', {
      version: 2,
      startsOn: '2028-03-01',
      endsOn: '2029-02-28',
      policyNumber: 'nueva-1',
      coverageType: 'third_party',
      deductible: { kind: 'percent', basisPoints: 1500 },
    });
    expect(changed).toMatchObject({
      ok: true,
      value: { revision: 3, policyNumber: 'NUEVA-1', coverageType: 'third_party' },
    });
    expect(
      await store.port.renew('pol-001', {
        version: 3,
        startsOn: '2029-03-01',
        endsOn: '2030-02-28',
        deductible: null,
      }),
    ).toMatchObject({ ok: true, value: { revision: 4, hasDeductible: false, deductible: null } });
    const history = await store.port.history('pol-001');
    expect(history.ok && history.value.items.map((item) => [item.revision, item.status])).toEqual([
      [4, 'valid'],
      [3, 'replaced'],
      [2, 'replaced'],
      [1, 'replaced'],
    ]);
    expect(history.ok && history.value.items[3]?.deductible).toEqual(amount);
  });

  it('refuses malformed renewals, a stale one, an unknown policy and a dead vehicle', async () => {
    const store = createMockInsuranceStore(
      [makePolicy(), makePolicy({ id: 'pol-002', vehicleId: 'veh-9' })],
      {
        isLiveVehicle: (id) => id !== 'veh-9',
      },
    );
    const period = { startsOn: '2027-03-01', endsOn: '2028-02-29' };
    for (const body of [
      { version: 1 },
      { version: 0, ...period },
      { version: 1, ...period, extra: 1 },
      { version: 1, ...period, policyNumber: '***' },
      { version: 1, ...period, coverageType: 'nada' },
      { version: 1, ...period, deductible: 'mucho' },
      { version: 1, startsOn: '2028-01-01', endsOn: '2027-01-01' },
    ])
      expect(await store.port.renew('pol-001', body as never)).toMatchObject(
        failure(400, 'bad_request'),
      );
    expect(await store.port.renew('pol-001', { version: 7, ...period })).toMatchObject(
      failure(409, 'stale_version'),
    );
    expect(await store.port.renew('pol-999', { version: 1, ...period })).toMatchObject(
      failure(404, 'not_found'),
    );
    expect(await store.port.renew('pol-002', { version: 1, ...period })).toMatchObject(
      failure(422, 'invalid_vehicle'),
    );
  });

  it('archives once, then treats the policy as read-only (409 immutable)', async () => {
    const store = createMockInsuranceStore([makePolicy()]);
    expect(await store.port.archive('pol-001', 0)).toMatchObject(failure(400, 'bad_request'));
    expect(await store.port.archive('pol-001', 9)).toMatchObject(failure(409, 'stale_version'));
    expect(await store.port.archive('pol-001', 1)).toMatchObject({
      ok: true,
      value: { archivedAt: '2026-10-06T12:00:00.000Z', version: 2 },
    });
    expect(await store.port.archive('pol-001', 2)).toMatchObject(failure(409, 'immutable'));
    expect(await store.port.update('pol-001', { version: 2, insurer: 'xx' })).toMatchObject(
      failure(409, 'immutable'),
    );
    expect(
      await store.port.renew('pol-001', {
        version: 2,
        startsOn: '2027-03-01',
        endsOn: '2028-02-29',
      }),
    ).toMatchObject(failure(409, 'immutable'));
    expect(await store.port.archive('pol-999', 1)).toMatchObject(failure(404, 'not_found'));
    expect(await store.port.history('pol-001')).toMatchObject({ ok: true, value: { total: 1 } });
  });

  it('pages the history of a seeded multi-revision policy, newest first, and validates its query', async () => {
    const store = createMockInsuranceStore([makePolicy({ revision: 3 })]);
    const first = await store.port.history('pol-001', { limit: 25 });
    expect(first.ok && first.value.items.map((item) => item.revision)).toEqual([3, 2, 1]);
    expect(first.ok && first.value.items[2]?.startsOn).toBe('2024-03-01');
    const tail = await store.port.history('pol-001', { limit: 25, cursor: 'mock:2' });
    expect(tail.ok && tail.value.items.map((item) => item.revision)).toEqual([1]);
    const middle = await store.port.history('pol-001', { limit: 25, cursor: 'mock:1' });
    expect(middle.ok && middle.value.nextCursor).toBeNull();
    expect(await store.port.history('pol-001', { limit: 10 as 25 })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(await store.port.history('pol-001', { cursor: 'otro' })).toMatchObject(
      failure(400, 'bad_request'),
    );
    expect(await store.port.history('pol-999')).toMatchObject(failure(404, 'not_found'));
  });

  it('lets the controls change or archive a policy as another actor, and ignores unknown ids', () => {
    const store = createMockInsuranceStore([makePolicy()]);
    store.changeExternally('pol-001', { insurer: 'Cambiada' });
    store.changeExternally('pol-999', { insurer: 'Nada' });
    expect(store.snapshot()[0]).toMatchObject({ insurer: 'Cambiada', version: 2 });
    store.archiveExternally('pol-001');
    store.archiveExternally('pol-999');
    expect(store.snapshot()[0]).toMatchObject({
      archivedAt: '2026-10-06T12:00:00.000Z',
      version: 3,
    });
  });

  it('is guarded by the role of the mock API', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.viewer);
    expect(await api.insurance.list()).toMatchObject({ ok: true });
    expect(await api.insurance.create(input)).toMatchObject(failure(403, 'forbidden'));
    expect(await api.insurance.update('pol-001', { version: 1, insurer: 'xx' })).toMatchObject(
      failure(403, 'forbidden'),
    );
    expect(
      await api.insurance.renew('pol-001', {
        version: 1,
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
      }),
    ).toMatchObject(failure(403, 'forbidden'));
    await api.auth.login(demoCredentials.dispatch);
    expect(await api.insurance.archive('pol-001', 1)).toMatchObject(failure(403, 'forbidden'));
    api.controls.expireSession();
    expect(await api.insurance.get('pol-001')).toMatchObject(failure(401, 'unauthorized'));
  });
});
