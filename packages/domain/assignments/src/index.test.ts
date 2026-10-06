import { describe, expect, it } from 'vitest';
import {
  AssignmentError,
  AssignmentService,
  InMemoryAssignmentStore,
  applyEnd,
  assignedEvent,
  endedEvent,
  isCurrent,
  isCurrentPrincipal,
  newAssignment,
  normalizeReason,
  parseEnd,
  parseNewAssignment,
  type AssignmentEmployeeGate,
  type AssignmentStore,
  type AssignmentVehicleGate,
} from './index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const body = (over: Record<string, unknown> = {}) => ({
  vehicleId: 'veh-1',
  employeeId: 'emp-1',
  type: 'principal',
  reason: 'Alta de unidad',
  ...over,
});

function service(
  over: { vehicles?: AssignmentVehicleGate; employees?: AssignmentEmployeeGate } = {},
) {
  let ids = 0;
  let tick = 0;
  const store = new InMemoryAssignmentStore();
  const svc = new AssignmentService(store, {
    ...over,
    now: () => new Date(NOW.getTime() + (tick += 1000)),
    newId: () => `asg-${(ids += 1)}`,
  });
  return { svc, store };
}

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AssignmentError)
      return error.field ? `${error.code}:${error.field}` : error.code;
    throw error;
  }
  return 'ok';
};
const invalid = (run: () => unknown) => expect(run).toThrow(AssignmentError);

describe('parsing', () => {
  it('normalizes a new assignment and defaults replace to false', () => {
    expect(parseNewAssignment(body({ reason: '  Alta   de unidad ' }))).toEqual({
      vehicleId: 'veh-1',
      employeeId: 'emp-1',
      type: 'principal',
      reason: 'Alta de unidad',
      replace: false,
    });
    expect(parseNewAssignment(body({ replace: true })).replace).toBe(true);
  });

  it('rejects unknown properties, missing keys, bad types, ids and reasons', () => {
    for (const input of [
      null,
      [],
      'x',
      body({ tenantId: 'other' }),
      body({ type: 'owner' }),
      body({ type: 7 }),
      body({ replace: 'yes' }),
      body({ replace: true, type: 'secondary' }),
      body({ vehicleId: '' }),
      body({ employeeId: 5 }),
      body({ reason: '' }),
      body({ reason: '   ' }),
      body({ reason: 'x'.repeat(201) }),
      body({ reason: 'bell\u0007' }),
      { vehicleId: 'v', employeeId: 'e', type: 'principal' },
    ])
      invalid(() => parseNewAssignment(input));
  });

  it('parses the closing reason', () => {
    expect(parseEnd({ reason: ' Cambio de turno ' })).toEqual({ reason: 'Cambio de turno' });
    invalid(() => parseEnd({}));
    invalid(() => parseEnd({ reason: 'ok', extra: 1 }));
    invalid(() => parseEnd(undefined));
    invalid(() => normalizeReason(undefined));
  });
});

describe('pure transitions', () => {
  const data = parseNewAssignment(body());
  const created = newAssignment(A, 'asg-1', ACTOR, data, NOW);

  it('starts current at version 1 with an assigned event', () => {
    expect(created).toMatchObject({ version: 1, endedAt: null, assignedBy: ACTOR, tenantId: A });
    expect(isCurrent(created)).toBe(true);
    expect(isCurrentPrincipal(created)).toBe(true);
    expect(assignedEvent(created)).toMatchObject({
      seq: 1,
      kind: 'assigned',
      reason: 'Alta de unidad',
    });
  });

  it('closes once, checks the version and keeps the rest', () => {
    const ended = applyEnd(created, 'ended', 'Baja', ACTOR, 1, new Date('2026-10-07T00:00:00Z'));
    expect(ended).toMatchObject({
      version: 2,
      endKind: 'ended',
      endReason: 'Baja',
      endedBy: ACTOR,
      endedAt: '2026-10-07T00:00:00.000Z',
      vehicleId: 'veh-1',
    });
    expect(isCurrent(ended)).toBe(false);
    expect(isCurrentPrincipal(ended)).toBe(false);
    expect(endedEvent(ended)).toMatchObject({ seq: 2, kind: 'ended', reason: 'Baja' });
    expect(() => applyEnd(ended, 'ended', 'x', ACTOR, 2, NOW)).toThrow(
      expect.objectContaining({ code: 'immutable' }),
    );
    expect(() => applyEnd(created, 'ended', 'x', ACTOR, 9, NOW)).toThrow(
      expect.objectContaining({ code: 'stale_version' }),
    );
    expect(isCurrentPrincipal({ endedAt: null, type: 'secondary' })).toBe(false);
  });
});

describe('create', () => {
  it('assigns, derives the first event and lists it', async () => {
    const { svc } = service();
    const { assignment, replaced } = await svc.create(A, ACTOR, body());
    expect(replaced).toBeNull();
    expect(assignment).toMatchObject({ id: 'asg-1', tenantId: A, version: 1 });
    expect(await svc.get(A, 'asg-1')).toEqual(assignment);
    expect((await svc.history(A, 'asg-1')).items.map((e) => e.kind)).toEqual(['assigned']);
  });

  it('BR-002: rejects a second principal for the vehicle and names the field', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    expect(await code(svc.create(A, ACTOR, body({ employeeId: 'emp-2' })))).toBe(
      'principal_taken:vehicle_id',
    );
  });

  it('BR-003: rejects a second principal vehicle for the driver, but allows other types', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    expect(await code(svc.create(A, ACTOR, body({ vehicleId: 'veh-2' })))).toBe(
      'principal_taken:employee_id',
    );
    expect(await code(svc.create(A, ACTOR, body({ vehicleId: 'veh-2', type: 'secondary' })))).toBe(
      'ok',
    );
    expect(await code(svc.create(A, ACTOR, body({ vehicleId: 'veh-3', type: 'temporary' })))).toBe(
      'ok',
    );
  });

  it('allows many secondaries on a vehicle but one current assignment per pair', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body({ type: 'secondary' }));
    expect(await code(svc.create(A, ACTOR, body({ employeeId: 'emp-2', type: 'secondary' })))).toBe(
      'ok',
    );
    expect(await code(svc.create(A, ACTOR, body({ type: 'temporary' })))).toBe(
      'already_assigned:employee_id',
    );
    expect(await code(svc.create(A, ACTOR, body({ replace: true })))).toBe(
      'already_assigned:employee_id',
    );
  });

  it('US-013: replace closes the current principal and assigns the new one', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    const { assignment, replaced } = await svc.create(
      A,
      ACTOR,
      body({ employeeId: 'emp-2', replace: true, reason: 'Relevo' }),
    );
    expect(replaced).toMatchObject({
      id: 'asg-1',
      endKind: 'replaced',
      endReason: 'Relevo',
      version: 2,
    });
    expect(assignment.employeeId).toBe('emp-2');
    expect((await svc.history(A, 'asg-1')).items.map((e) => e.kind)).toEqual([
      'replaced',
      'assigned',
    ]);
    expect(
      (await svc.list(A, { vehicleId: 'veh-1', status: 'current' })).items.map((a) => a.id),
    ).toEqual(['asg-2']);
    // The driver replaced may be principal elsewhere afterwards (BR-003 only counts current ones).
    expect(await code(svc.create(A, ACTOR, body({ vehicleId: 'veh-2' })))).toBe('ok');
  });

  it('replace without a current principal is a plain assignment; replace cannot free the driver elsewhere', async () => {
    const { svc } = service();
    expect((await svc.create(A, ACTOR, body({ replace: true }))).replaced).toBeNull();
    await svc.create(A, ACTOR, body({ vehicleId: 'veh-2', employeeId: 'emp-2' }));
    expect(
      await code(
        svc.create(A, ACTOR, body({ vehicleId: 'veh-2', employeeId: 'emp-1', replace: true })),
      ),
    ).toBe('principal_taken:employee_id');
    expect((await svc.list(A, { vehicleId: 'veh-2', status: 'current' })).total).toBe(1);
  });

  it('asks the gates (BR-014) before writing anything', async () => {
    const calls: string[] = [];
    const { svc, store } = service({
      vehicles: {
        assertAssignable: async (_t, id) => {
          calls.push(`vehicle:${id}`);
          if (id === 'veh-x') throw new AssignmentError('invalid_vehicle', 'vehicle_id');
        },
      },
      employees: {
        assertAssignable: async (_t, id) => {
          calls.push(`employee:${id}`);
          if (id === 'emp-x') throw new AssignmentError('invalid_employee', 'employee_id');
        },
      },
    });
    expect(await code(svc.create(A, ACTOR, body({ vehicleId: 'veh-x' })))).toBe(
      'invalid_vehicle:vehicle_id',
    );
    expect(await code(svc.create(A, ACTOR, body({ employeeId: 'emp-x' })))).toBe(
      'invalid_employee:employee_id',
    );
    expect(calls).toEqual(['vehicle:veh-x', 'vehicle:veh-1', 'employee:emp-x']);
    expect((await store.list(A, {}, { limit: 10, offset: 0 })).total).toBe(0);
  });

  it('reports a stale closing when the replaced principal changed in between', async () => {
    const { svc, store } = service();
    await svc.create(A, ACTOR, body());
    const realList = store.list.bind(store);
    store.list = async (tenant, filter, window) => {
      const slice = await realList(tenant, filter, window);
      if (filter.type === 'principal' && filter.vehicleId !== undefined)
        await svc.end(A, ACTOR, 'asg-1', 1, { reason: 'Se fue' });
      return slice;
    };
    expect(await code(svc.create(A, ACTOR, body({ employeeId: 'emp-2', replace: true })))).toBe(
      'stale_version',
    );
  });

  it('validates the ids it receives', async () => {
    const { svc } = service();
    expect(await code(svc.create('', ACTOR, body()))).toBe('invalid_input');
    expect(await code(svc.create(A, '', body()))).toBe('invalid_input');
  });
});

describe('end, get, list and history', () => {
  it('closes an assignment, frees the principal slot and keeps the history', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    const ended = await svc.end(A, ACTOR, 'asg-1', 1, { reason: 'Fin de turno' });
    expect(ended).toMatchObject({ version: 2, endKind: 'ended', endedBy: ACTOR });
    expect(await code(svc.end(A, ACTOR, 'asg-1', 2, { reason: 'otra vez' }))).toBe('immutable');
    expect(await code(svc.end(A, ACTOR, 'asg-1', 1, { reason: 'vieja' }))).toBe('immutable');
    expect((await svc.history(A, 'asg-1')).items.map((e) => [e.seq, e.kind])).toEqual([
      [2, 'ended'],
      [1, 'assigned'],
    ]);
    expect(await code(svc.create(A, ACTOR, body({ employeeId: 'emp-2' })))).toBe('ok');
  });

  it('rejects a stale version and unknown ids, and reads another tenant as not found', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    expect(await code(svc.end(A, ACTOR, 'asg-1', 5, { reason: 'x' }))).toBe('stale_version');
    expect(await code(svc.end(A, ACTOR, 'asg-1', 'one', { reason: 'x' }))).toBe('invalid_input');
    expect(await code(svc.end(A, ACTOR, 'asg-1', 1, { reason: '' }))).toBe('invalid_input');
    expect(await code(svc.end(A, '', 'asg-1', 1, { reason: 'x' }))).toBe('invalid_input');
    expect(await code(svc.end(A, ACTOR, 'nope', 1, { reason: 'x' }))).toBe('not_found');
    expect(await code(svc.get(B, 'asg-1'))).toBe('not_found');
    expect(await code(svc.end(B, ACTOR, 'asg-1', 1, { reason: 'x' }))).toBe('not_found');
    expect(await code(svc.history(B, 'asg-1'))).toBe('not_found');
    expect(await code(svc.get(A, 5))).toBe('invalid_input');
  });

  it('turns a lost race into stale_version, or not_found when the row vanished', async () => {
    const { svc, store } = service();
    await svc.create(A, ACTOR, body());
    const realReplace = store.replace.bind(store);
    let racing = true;
    store.replace = async (next, version, event) => {
      if (racing) {
        racing = false;
        await svc.end(A, ACTOR, 'asg-1', 1, { reason: 'ganador' });
      }
      return realReplace(next, version, event);
    };
    expect(await code(svc.end(A, ACTOR, 'asg-1', 1, { reason: 'perdedor' }))).toBe('stale_version');
    const lone = service();
    await lone.svc.create(A, ACTOR, body());
    const realFind = lone.store.find.bind(lone.store);
    let reads = 0;
    lone.store.find = async (tenant, id) => ((reads += 1) > 1 ? null : realFind(tenant, id));
    lone.store.replace = async () => false;
    expect(await code(lone.svc.end(A, ACTOR, 'asg-1', 1, { reason: 'x' }))).toBe('not_found');
  });

  it('lists newest first with filters and windows, per tenant', async () => {
    const { svc } = service();
    await svc.create(A, ACTOR, body());
    await svc.create(
      A,
      ACTOR,
      body({ vehicleId: 'veh-2', employeeId: 'emp-2', type: 'secondary' }),
    );
    await svc.create(
      A,
      ACTOR,
      body({ vehicleId: 'veh-2', employeeId: 'emp-3', type: 'temporary' }),
    );
    await svc.end(A, ACTOR, 'asg-3', 1, { reason: 'fin' });
    await svc.create(B, ACTOR, body());
    const ids = async (query: Record<string, unknown>) =>
      (await svc.list(A, query)).items.map((a) => a.id);
    expect(await ids({})).toEqual(['asg-3', 'asg-2', 'asg-1']);
    expect(await ids({ vehicleId: 'veh-2' })).toEqual(['asg-3', 'asg-2']);
    expect(await ids({ employeeId: 'emp-2' })).toEqual(['asg-2']);
    expect(await ids({ type: 'principal' })).toEqual(['asg-1']);
    expect(await ids({ status: 'ended' })).toEqual(['asg-3']);
    expect(await ids({ status: 'current' })).toEqual(['asg-2', 'asg-1']);
    expect(await svc.list(A, { limit: 1, offset: 1 })).toMatchObject({
      total: 3,
      items: [{ id: 'asg-2' }],
    });
    expect((await svc.list(B)).total).toBe(1);
    expect((await svc.history(A, 'asg-3', { limit: 1 })).items.map((e) => e.kind)).toEqual([
      'ended',
    ]);
    for (const query of [
      { type: 'x' },
      { status: 'x' },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { limit: 1.5 },
      { vehicleId: 3 },
      { employeeId: '' },
    ])
      expect(await code(svc.list(A, query))).toBe('invalid_input');
    expect(await code(svc.history(A, 'asg-3', { limit: 0 }))).toBe('invalid_input');
    expect(await code(svc.list(''))).toBe('invalid_input');
  });
});

describe('in-memory store', () => {
  const stores: [string, () => AssignmentStore][] = [
    ['memory', () => new InMemoryAssignmentStore()],
  ];
  it.each(stores)('refuses to write what the unique keys forbid (%s)', async (_n, make) => {
    const store = make();
    const mk = (id: string, over: Record<string, unknown> = {}) =>
      newAssignment(A, id, ACTOR, parseNewAssignment(body(over)), NOW);
    const first = mk('a1');
    await store.insert(first, assignedEvent(first));
    const clash = mk('a2', { employeeId: 'emp-2' });
    await expect(store.insert(clash, assignedEvent(clash))).rejects.toMatchObject({
      code: 'principal_taken',
      field: 'vehicle_id',
    });
    const other = mk('a3', { vehicleId: 'veh-2' });
    await expect(store.insert(other, assignedEvent(other))).rejects.toMatchObject({
      field: 'employee_id',
    });
    const closing = {
      next: applyEnd(first, 'replaced', 'r', ACTOR, 1, NOW),
      expectedVersion: 7,
      event: endedEvent(applyEnd(first, 'replaced', 'r', ACTOR, 1, NOW)),
    };
    expect(await store.insert(clash, assignedEvent(clash), closing)).toBe(false);
    expect(
      await store.insert(clash, assignedEvent(clash), {
        ...closing,
        next: { ...closing.next, id: 'missing' },
        expectedVersion: 1,
      }),
    ).toBe(false);
    expect(await store.find(A, 'a2')).toBeNull();
    expect(await store.replace(first, 9, assignedEvent(first))).toBe(false);
  });
});
