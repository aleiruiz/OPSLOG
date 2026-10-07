import { describe, expect, it } from 'vitest';
import { closed, demoAssignments, makeAssignment } from '../assignments/fixtures';
import { createMockAssignmentStore, type MockAssignmentEnvironment } from './mockAssignments';

const env = (overrides: Partial<MockAssignmentEnvironment> = {}): MockAssignmentEnvironment => ({
  isEligibleVehicle: () => true,
  isEligibleDriver: () => true,
  actorId: () => 'user-test',
  ...overrides,
});
const input = (extra: Record<string, unknown> = {}) =>
  ({
    vehicleId: 'veh-100',
    employeeId: 'emp-100',
    type: 'principal',
    reason: 'Ruta de prueba',
    ...extra,
  }) as never;
const fresh = (overrides: Partial<MockAssignmentEnvironment> = {}) =>
  createMockAssignmentStore(env(overrides), []);
const errorOf = <T>(result: { ok: boolean; error?: T } | { ok: true }) =>
  (result as { error: { code: string; status: number; fieldErrors?: { field: string }[] } }).error;

describe('mock assignments store', () => {
  it('assigns at the server clock, records the actor and keeps an append-only history', async () => {
    const store = fresh();
    const created = await store.port.assign(input({ reason: '  Ruta   de prueba ' }));
    expect(created.ok && created.value.replaced).toBeNull();
    const assignment = created.ok ? created.value.assignment : null;
    expect(assignment).toMatchObject({
      reason: 'Ruta de prueba',
      assignedBy: 'user-test',
      startedAt: '2026-10-06T12:00:00.000Z',
      endedAt: null,
      current: true,
      version: 1,
    });
    const history = await store.port.history(assignment?.id ?? '');
    expect(history.ok && history.value.items.map((event) => event.kind)).toEqual(['assigned']);
  });

  it('rejects malformed input with a uniform 400', async () => {
    const store = fresh();
    for (const bad of [
      input({ extra: 1 }),
      input({ vehicleId: '../x' }),
      input({ employeeId: 3 }),
      input({ type: 'permanent' }),
      input({ reason: '' }),
      input({ reason: 'a\u0007b' }),
      input({ replace: 'yes' }),
      input({ type: 'secondary', replace: true }),
    ])
      expect(errorOf(await store.port.assign(bad))).toMatchObject({ status: 400 });
    expect(await store.port.list({ vehicleId: '../x' })).toMatchObject({ ok: false });
    expect(await store.port.list({ employeeId: '../x' })).toMatchObject({ ok: false });
    expect(await store.port.list({ type: 'x' as never })).toMatchObject({ ok: false });
    expect(await store.port.list({ status: 'x' as never })).toMatchObject({ ok: false });
    expect(await store.port.list({ limit: 10 as never })).toMatchObject({ ok: false });
    expect(await store.port.list({ cursor: 'zzz' })).toMatchObject({ ok: false });
  });

  it('refuses an ineligible vehicle or driver with the same 422 whatever the cause (BR-014)', async () => {
    const vehicle = fresh({ isEligibleVehicle: () => false });
    expect(errorOf(await vehicle.port.assign(input()))).toMatchObject({
      code: 'invalid_vehicle',
      status: 422,
      fieldErrors: [{ field: 'vehicle_id' }],
    });
    const driver = fresh({ isEligibleDriver: () => false });
    expect(errorOf(await driver.port.assign(input()))).toMatchObject({
      code: 'invalid_employee',
      fieldErrors: [{ field: 'employee_id' }],
    });
  });

  it('allows one current principal per vehicle (BR-002) and per driver (BR-003), and names the field', async () => {
    const store = fresh();
    await store.port.assign(input());
    expect(errorOf(await store.port.assign(input({ employeeId: 'emp-200' })))).toMatchObject({
      code: 'principal_taken',
      fieldErrors: [{ field: 'vehicle_id' }],
    });
    expect(errorOf(await store.port.assign(input({ vehicleId: 'veh-200' })))).toMatchObject({
      code: 'principal_taken',
      fieldErrors: [{ field: 'employee_id' }],
    });
    // Replacing does not skip BR-003.
    await store.port.assign(input({ vehicleId: 'veh-300', employeeId: 'emp-300' }));
    expect(
      errorOf(await store.port.assign(input({ vehicleId: 'veh-300', employeeId: 'emp-100', replace: true }))),
    ).toMatchObject({ code: 'principal_taken', fieldErrors: [{ field: 'employee_id' }] });
    // Secondary and temporary have no limit.
    for (const type of ['secondary', 'temporary'])
      expect((await store.port.assign(input({ employeeId: `emp-${type}`, type }))).ok).toBe(true);
  });

  it('refuses a repeated current pair of vehicle and driver', async () => {
    const store = fresh();
    await store.port.assign(input({ type: 'secondary' }));
    expect(errorOf(await store.port.assign(input({ type: 'temporary' })))).toMatchObject({
      code: 'already_assigned',
      fieldErrors: [{ field: 'employee_id' }],
    });
  });

  it('replaces the current principal in one step and keeps the replaced one as history', async () => {
    const store = fresh();
    const first = await store.port.assign(input());
    const second = await store.port.assign(input({ employeeId: 'emp-200', replace: true }));
    expect(second.ok && second.value.replaced).toMatchObject({
      endKind: 'replaced',
      endReason: 'Ruta de prueba',
      endedBy: 'user-test',
      current: false,
      version: 2,
    });
    const history = await store.port.history(first.ok ? first.value.assignment.id : '');
    expect(history.ok && history.value.items.map((event) => event.kind)).toEqual([
      'replaced',
      'assigned',
    ]);
    // `replace` without a principal to replace just assigns.
    expect((await store.port.assign(input({ vehicleId: 'veh-9', employeeId: 'emp-9', replace: true }))).ok).toBe(true);
  });

  it('closes an assignment once: unknown is 404, closed is immutable, an old version is stale', async () => {
    const store = fresh();
    const created = await store.port.assign(input());
    const id = created.ok ? created.value.assignment.id : '';
    expect(errorOf(await store.port.end('nope', { version: 1, reason: 'x' }))).toMatchObject({ status: 404 });
    expect(errorOf(await store.port.end(id, { version: 0, reason: 'x' }))).toMatchObject({ status: 400 });
    expect(errorOf(await store.port.end(id, { version: 1, reason: '' }))).toMatchObject({ status: 400 });
    expect(errorOf(await store.port.end(id, { version: 1, reason: 'x', extra: 1 } as never))).toMatchObject({ status: 400 });
    expect(errorOf(await store.port.end(id, { version: 5, reason: 'x' }))).toMatchObject({
      code: 'stale_version',
    });
    const ended = await store.port.end(id, { version: 1, reason: ' Fin  de ruta ' });
    expect(ended.ok && ended.value).toMatchObject({
      endKind: 'ended',
      endReason: 'Fin de ruta',
      current: false,
      version: 2,
    });
    expect(errorOf(await store.port.end(id, { version: 2, reason: 'otra vez' }))).toMatchObject({
      code: 'immutable',
    });
  });

  it('lists newest first with filters and cursor pages, and answers 404 for an unknown id', async () => {
    const store = createMockAssignmentStore(env(), demoAssignments());
    const first = await store.port.list();
    expect(first.ok && [first.value.items.length, first.value.total, first.value.nextCursor]).toEqual([
      25,
      28,
      'mock:25',
    ]);
    const second = await store.port.list({ cursor: 'mock:25' });
    expect(second.ok && second.value.items).toHaveLength(3);
    const current = await store.port.list({ status: 'current' });
    expect(current.ok && current.value.items.every((item) => item.endedAt === null)).toBe(true);
    const ended = await store.port.list({ status: 'ended', employeeId: 'emp-001' });
    expect(ended.ok && ended.value.items.every((item) => item.employeeId === 'emp-001')).toBe(true);
    const byVehicle = await store.port.list({ vehicleId: 'veh-001', type: 'principal' });
    expect(byVehicle.ok && byVehicle.value.total).toBe(2);
    expect(errorOf(await store.port.get('nope'))).toMatchObject({ status: 404 });
    expect(errorOf(await store.port.history('nope'))).toMatchObject({ status: 404 });
    expect((await store.port.get('asg-001')).ok).toBe(true);
  });

  it('shows another actor closing an assignment, and ignores one that is already closed', async () => {
    const seed = [makeAssignment(), closed(makeAssignment({ id: 'asg-002' }))];
    const store = createMockAssignmentStore(env(), seed);
    store.endExternally('asg-001');
    store.endExternally('asg-002');
    store.endExternally('nope');
    const snapshot = store.snapshot();
    expect(snapshot[0]).toMatchObject({ current: false, endedBy: 'user-otra', version: 2 });
    expect(snapshot[1]?.version).toBe(2);
    const events = await store.port.history('asg-002');
    expect(events.ok && events.value.items.map((event) => event.kind)).toEqual(['ended', 'assigned']);
  });
});
