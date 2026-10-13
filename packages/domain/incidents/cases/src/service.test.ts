import { describe, expect, it } from 'vitest';
import { IncidentError } from './errors.js';
import {
  MANAGER,
  NOW,
  OTHER_REPORTER,
  REPORTER,
  TENANT_A,
  TENANT_B,
  VEHICLE,
  actorOf,
  revision,
  setup,
} from './test-support.js';

const codeOf = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};
const draft = { vehicleId: VEHICLE, type: 'collision' };

describe('create (cases 1, 3, 4)', () => {
  it('creates the minimal draft with the first folio of the year', async () => {
    const { service, store } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    expect(incident).toMatchObject({
      status: 'draft',
      version: 1,
      cycle: 1,
      reopenCount: 0,
      areaId: 'area-1',
      folio: 'SIN-2026-000001',
      coverageStatus: 'unknown',
      severity: null,
      occurredAt: null,
      createdBy: MANAGER.id,
    });
    expect(store.audit).toEqual([{ tenantId: TENANT_A, action: 'incident.created' }]);
    expect(store.events[0]?.event.payload).toEqual({
      incidentId: incident.id,
      vehicleId: VEHICLE,
      version: 1,
    });
    const timeline = await service.history(TENANT_A, MANAGER, incident.id);
    expect(timeline).toMatchObject([{ sequence: 1, command: 'create', from: null, to: 'draft' }]);
  });

  it('reports every missing or bad field with names only', async () => {
    const { service } = setup();
    const error = await codeOf(service.create(TENANT_A, MANAGER, { severity: 'x', extra: 1 }));
    expect(error.code).toBe('invalid_input');
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'vehicleId', code: 'required' },
        { field: 'type', code: 'required' },
        { field: 'severity', code: 'invalid' },
        { field: 'extra', code: 'unknown_property' },
      ]),
    );
    expect((await codeOf(service.create(TENANT_A, MANAGER, 'x'))).code).toBe('invalid_input');
  });

  it('uses the tenant calendar year for the folio', async () => {
    // 2027-01-01T02:00Z is still 2026-12-31 20:00 in Mexico City.
    const { service } = setup(() => new Date('2027-01-01T02:00:00.000Z'));
    expect((await service.create(TENANT_A, MANAGER, draft)).folio).toBe('SIN-2026-000001');
  });

  it('numbers folios per tenant and year and never reuses one', async () => {
    const { service, refs } = setup();
    refs.zones.set(TENANT_B, 'UTC');
    const first = await service.create(TENANT_A, MANAGER, draft);
    const second = await service.create(TENANT_A, MANAGER, draft);
    const other = await service.create(TENANT_B, MANAGER, draft);
    expect([first.folio, second.folio, other.folio]).toEqual([
      'SIN-2026-000001',
      'SIN-2026-000002',
      'SIN-2026-000001',
    ]);
  });

  it('rejects an event in the future and one before the vehicle registration', async () => {
    const { service } = setup();
    const future = await codeOf(
      service.create(TENANT_A, MANAGER, { ...draft, occurredAt: '2026-10-13T18:00:00.001Z' }),
    );
    expect([future.code, future.rule]).toEqual(['rule_violation', 'occurred_at_in_future']);
    const early = await codeOf(
      service.create(TENANT_A, MANAGER, { ...draft, occurredAt: '2026-01-10T05:59:59.000Z' }),
    );
    expect(early.rule).toBe('occurred_before_vehicle_registration');
    // 06:00Z is 00:00 local on the registration day: accepted.
    const ok = await service.create(TENANT_A, MANAGER, {
      ...draft,
      occurredAt: '2026-01-10T06:00:00Z',
    });
    expect(ok).toMatchObject({ occurredOn: '2026-01-10', occurredAt: '2026-01-10T06:00:00.000Z' });
    expect(
      (await service.create(TENANT_A, MANAGER, { ...draft, occurredAt: '2026-10-13T18:00:00Z' }))
        .occurredOn,
    ).toBe('2026-10-13');
  });

  it('answers 404 for unknown, foreign vehicles and drivers', async () => {
    const { service } = setup();
    for (const body of [
      { ...draft, vehicleId: 'nope' },
      { ...draft, driverId: 'driver-b' },
      { ...draft, driverId: 'nope' },
    ])
      expect((await codeOf(service.create(TENANT_A, MANAGER, body))).code).toBe('not_found');
    expect(
      (await codeOf(service.create(TENANT_B, MANAGER, { ...draft, vehicleId: 'vehicle-2' }))).code,
    ).toBe('not_found');
  });

  it('keeps a driver and a no-driver reason mutually exclusive', async () => {
    const { service } = setup();
    const error = await codeOf(
      service.create(TENANT_A, MANAGER, { ...draft, driverId: 'driver-1', noDriverReason: 'Robo' }),
    );
    expect(error.fieldErrors).toEqual([{ field: 'noDriverReason', code: 'conflict' }]);
  });

  it('stores structured location and damage', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, {
      ...draft,
      location: { text: 'Av. Reforma', latitude: 19.4326077, longitude: -99.133208 },
      damage: { description: 'Golpe', zones: ['rear', 'front'] },
      vehicleOperable: false,
      driverId: 'driver-1',
    });
    expect(incident.location).toEqual({
      text: 'Av. Reforma',
      latitude: 19.432608,
      longitude: -99.133208,
    });
    expect(incident.damage.zones).toEqual(['front', 'rear']);
    expect(incident.driverId).toBe('driver-1');
  });
});

describe('permissions (cases 8, 9, 16)', () => {
  it('lets a reporter create and edit their own draft only', async () => {
    const { service } = setup();
    const own = await service.create(TENANT_A, REPORTER, draft);
    const edited = await service.update(TENANT_A, REPORTER, own.id, {
      version: 1,
      severity: 'high',
    });
    expect(edited).toMatchObject({ severity: 'high', version: 2, updatedBy: REPORTER.id });
    expect(
      (
        await codeOf(
          service.update(TENANT_A, OTHER_REPORTER, own.id, { version: 2, severity: 'low' }),
        )
      ).code,
    ).toBe('forbidden');
    expect(
      (await service.update(TENANT_A, MANAGER, own.id, { version: 2, severity: 'low' })).severity,
    ).toBe('low');
  });

  it('denies the generic verbs and a viewer without write rights', async () => {
    const { service } = setup();
    const generic = actorOf('00000000-0000-4000-8000-000000000009', ['view', 'create', 'edit']);
    for (const work of [
      service.list(TENANT_A, generic, {}),
      service.get(TENANT_A, generic, 'x'),
      service.history(TENANT_A, generic, 'x'),
      service.create(TENANT_A, generic, draft),
      service.suggestions(TENANT_A, generic, {}),
    ])
      expect((await codeOf(work)).code).toBe('forbidden');
    const incident = await service.create(TENANT_A, MANAGER, draft);
    const viewer = actorOf('00000000-0000-4000-8000-000000000008', ['incidents:view']);
    expect((await service.get(TENANT_A, viewer, incident.id)).id).toBe(incident.id);
    expect((await codeOf(service.create(TENANT_A, viewer, draft))).code).toBe('forbidden');
    expect(
      (await codeOf(service.update(TENANT_A, viewer, incident.id, { version: 1, severity: 'low' })))
        .code,
    ).toBe('forbidden');
    expect((await codeOf(service.suggestions(TENANT_A, viewer, {}))).code).toBe('forbidden');
  });

  it('fails closed for a member with mechanic scope', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    const mechanic = actorOf(
      '00000000-0000-4000-8000-000000000007',
      ['incidents:view', 'incidents:create'],
      true,
    );
    expect(await service.list(TENANT_A, mechanic, {})).toEqual({ items: [], total: 0 });
    expect((await codeOf(service.get(TENANT_A, mechanic, incident.id))).code).toBe('not_found');
    expect((await codeOf(service.history(TENANT_A, mechanic, incident.id))).code).toBe('not_found');
    expect((await codeOf(service.create(TENANT_A, mechanic, draft))).code).toBe('forbidden');
    // A manager with edit rights is not scoped even when linked to a mechanic.
    const linkedManager = { ...MANAGER, mechanicLinked: true };
    expect((await service.list(TENANT_A, linkedManager, {})).total).toBe(1);
  });

  it('answers 404 across tenants', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    expect((await codeOf(service.get(TENANT_B, MANAGER, incident.id))).code).toBe('not_found');
    expect(
      (
        await codeOf(
          service.update(TENANT_B, MANAGER, incident.id, { version: 1, severity: 'low' }),
        )
      ).code,
    ).toBe('not_found');
    expect((await codeOf(service.get(TENANT_A, MANAGER, '../x'))).code).toBe('not_found');
    expect((await service.list(TENANT_B, MANAGER, {})).total).toBe(0);
  });
});

describe('update (cases 6, 8, 12, 14)', () => {
  it('follows the edit matrix by status', async () => {
    const { service, store } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    const inState = (status: string, version = 1) => ({ ...incident, status, version }) as never;
    const put = async (status: string, body: Record<string, unknown>) => {
      const { service: s, store: st } = setup();
      const created = await s.create(TENANT_A, MANAGER, draft);
      await st.apply({
        incident: { ...created, status: status as never, version: 2 },
        expectedVersion: 1,
        folioYear: null,
        transitions: [],
        auditActions: [],
        events: [],
      });
      return codeOf(s.update(TENANT_A, MANAGER, created.id, { version: 2, ...body }));
    };
    void inState;
    void store;
    expect((await put('reported', { vehicleId: 'vehicle-2' })).code).toBe('invalid_transition');
    expect((await put('repair', { type: 'other' })).code).toBe('invalid_transition');
    expect((await put('closed', { severity: 'low' })).code).toBe('invalid_transition');
    expect((await put('cancelled', { description: 'x' })).code).toBe('invalid_transition');
    const ok = async (status: string, body: Record<string, unknown>) => {
      const { service: s, store: st } = setup();
      const created = await s.create(TENANT_A, MANAGER, draft);
      await st.apply({
        incident: { ...created, status: status as never, version: 2 },
        expectedVersion: 1,
        folioYear: null,
        transitions: [],
        auditActions: [],
        events: [],
      });
      return s.update(TENANT_A, MANAGER, created.id, { version: 2, ...body });
    };
    expect((await ok('draft', { vehicleId: 'vehicle-2' })).areaId).toBe('area-2');
    expect((await ok('under_review', { type: 'other' })).type).toBe('other');
    expect((await ok('repair', { severity: 'low', description: 'Texto' })).description).toBe(
      'Texto',
    );
  });

  it('is conditional on the version: the second concurrent patch loses', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    const results = await Promise.allSettled([
      service.update(TENANT_A, MANAGER, incident.id, { version: 1, severity: 'low' }),
      service.update(TENANT_A, MANAGER, incident.id, { version: 1, severity: 'high' }),
    ]);
    const lost = results.filter((r) => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(((lost[0] as PromiseRejectedResult).reason as IncidentError).code).toBe('stale_version');
  });

  it('validates the patch body and treats a no-op as unchanged', async () => {
    const { service, store } = setup();
    const incident = await service.create(TENANT_A, MANAGER, { ...draft, severity: 'low' });
    for (const body of [
      {},
      { version: 1 },
      { severity: 'low' },
      { version: 0, severity: 'low' },
      { version: 1, status: 'closed' },
    ])
      expect((await codeOf(service.update(TENANT_A, MANAGER, incident.id, body))).code).toBe(
        'invalid_input',
      );
    const same = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      severity: 'low',
    });
    expect(same.version).toBe(1);
    expect(store.audit).toHaveLength(1);
  });

  it('records the changed field names and structured facts, never text', async () => {
    const { service, store } = setup();
    const incident = await service.create(TENANT_A, MANAGER, draft);
    await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      description: 'Texto libre',
      severity: 'critical',
      driverId: 'driver-1',
    });
    const timeline = await service.history(TENANT_A, MANAGER, incident.id);
    expect(timeline[1]).toMatchObject({
      sequence: 2,
      command: 'update',
      from: 'draft',
      to: 'draft',
      changedFields: ['description', 'driverId', 'severity'],
    });
    expect(JSON.stringify(timeline)).not.toContain('Texto libre');
    expect(store.events.at(-1)?.event).toEqual({
      type: 'incident.updated',
      payload: { incidentId: incident.id, version: 2 },
    });
  });

  it('swaps a driver for a reason and back', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, { ...draft, driverId: 'driver-1' });
    const none = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      noDriverReason: 'Vehículo robado',
    });
    expect([none.driverId, none.noDriverReason]).toEqual([null, 'Vehículo robado']);
    const back = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 2,
      driverId: 'driver-2',
    });
    expect([back.driverId, back.noDriverReason]).toEqual(['driver-2', null]);
    expect(
      (
        await codeOf(
          service.update(TENANT_A, MANAGER, incident.id, { version: 3, driverId: 'driver-b' }),
        )
      ).code,
    ).toBe('not_found');
  });

  it('recomputes the event day when the instant changes and clears it with null', async () => {
    const { service } = setup();
    const incident = await service.create(TENANT_A, MANAGER, {
      ...draft,
      occurredAt: '2026-10-13T05:00:00Z',
    });
    expect(incident.occurredOn).toBe('2026-10-12');
    const moved = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      occurredAt: '2026-10-13T07:00:00Z',
    });
    expect(moved.occurredOn).toBe('2026-10-13');
    const cleared = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 2,
      occurredAt: null,
    });
    expect([cleared.occurredAt, cleared.occurredOn, cleared.coverageStatus]).toEqual([
      null,
      null,
      'unknown',
    ]);
    expect(
      (
        await codeOf(
          service.update(TENANT_A, MANAGER, incident.id, {
            version: 3,
            occurredAt: '2027-01-01T00:00:00Z',
          }),
        )
      ).rule,
    ).toBe('occurred_at_in_future');
  });
});

describe('idempotency (case 14)', () => {
  it('returns the same case for the same key and body', async () => {
    const { service, store } = setup();
    const [a, b] = await Promise.all([
      service.create(TENANT_A, MANAGER, draft, 'key-0001-aaaa'),
      service.create(TENANT_A, MANAGER, draft, 'key-0001-aaaa'),
    ]);
    expect(b).toEqual(a);
    expect((await service.list(TENANT_A, MANAGER, {})).total).toBe(1);
    expect(store.audit).toHaveLength(1);
    const again = await service.create(
      TENANT_A,
      MANAGER,
      { type: 'collision', vehicleId: VEHICLE },
      'key-0001-aaaa',
    );
    expect(again.id).toBe(a.id);
  });

  it('conflicts when the body differs and scopes the key to the actor', async () => {
    const { service } = setup();
    await service.create(TENANT_A, MANAGER, draft, 'key-0002-aaaa');
    expect(
      (
        await codeOf(
          service.create(TENANT_A, MANAGER, { ...draft, type: 'other' }, 'key-0002-aaaa'),
        )
      ).code,
    ).toBe('idempotency_conflict');
    const other = await service.create(
      TENANT_A,
      REPORTER,
      { ...draft, type: 'other' },
      'key-0002-aaaa',
    );
    expect(other.type).toBe('other');
    expect((await codeOf(service.create(TENANT_A, MANAGER, draft, 'bad key'))).fieldErrors).toEqual(
      [{ field: 'idempotencyKey', code: 'invalid' }],
    );
  });

  it('creates a new case once the key has expired', async () => {
    let now = NOW;
    const { service } = setup(() => now);
    const first = await service.create(TENANT_A, MANAGER, draft, 'key-0003-aaaa');
    now = new Date(NOW.getTime() + 25 * 3600_000);
    const second = await service.create(TENANT_A, MANAGER, draft, 'key-0003-aaaa');
    expect(second.id).not.toBe(first.id);
  });

  it('reports a duplicate id as a conflict', async () => {
    const store = setup();
    const service = new (await import('./service.js')).IncidentService(store.store, store.refs, {
      now: () => NOW,
      newId: () => 'same',
    });
    await service.create(TENANT_A, MANAGER, draft);
    expect((await codeOf(service.create(TENANT_A, MANAGER, draft))).code).toBe('duplicate');
  });
});

describe('coverage (case 6)', () => {
  it('links the only covering policy and keeps the snapshot after a renewal', async () => {
    const { service, refs } = setup();
    refs.revisions = [revision('pol-1', 1, '2026-01-01', '2026-12-31')];
    const incident = await service.create(TENANT_A, MANAGER, {
      ...draft,
      occurredAt: '2026-06-01T12:00:00Z',
    });
    expect(incident.coverageStatus).toBe('covered');
    expect(incident.policySnapshot).toMatchObject({
      policyId: 'pol-1',
      revision: 1,
      policyNumber: 'POL-pol-1',
    });
    refs.revisions = [
      revision('pol-1', 1, '2026-01-01', '2026-12-31'),
      revision('pol-1', 2, '2027-01-01', '2027-12-31'),
    ];
    const edited = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      severity: 'low',
    });
    expect(edited.policySnapshot).toEqual(incident.policySnapshot);
  });

  it('asks to choose among several policies and validates the choice', async () => {
    const { service, refs, store } = setup();
    refs.revisions = [
      revision('pol-1', 1, '2026-01-01', '2026-12-31'),
      revision('pol-1', 2, '2026-07-01', '2027-06-30'),
      revision('pol-2', 1, '2026-03-01', '2026-09-30'),
      revision('pol-3', 1, '2025-01-01', '2025-12-31'),
    ];
    const incident = await service.create(TENANT_A, MANAGER, {
      ...draft,
      occurredAt: '2026-08-01T12:00:00Z',
    });
    expect([incident.coverageStatus, incident.policySnapshot]).toEqual(['multiple', null]);
    const suggestions = await service.suggestions(TENANT_A, MANAGER, {
      vehicleId: VEHICLE,
      occurredAt: '2026-08-01T12:00:00Z',
    });
    expect(suggestions.policies.map((p) => [p.policyId, p.revision])).toEqual([
      ['pol-1', 2],
      ['pol-2', 1],
    ]);
    expect(suggestions.coverageStatus).toBe('multiple');
    const notCovering = await codeOf(
      service.update(TENANT_A, MANAGER, incident.id, { version: 1, policyId: 'pol-3' }),
    );
    expect([notCovering.code, notCovering.rule]).toEqual([
      'rule_violation',
      'policy_not_covering_event_day',
    ]);
    expect(
      (
        await codeOf(
          service.update(TENANT_A, MANAGER, incident.id, { version: 1, policyId: 'foreign' }),
        )
      ).code,
    ).toBe('not_found');
    const chosen = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      policyId: 'pol-2',
    });
    expect(chosen).toMatchObject({
      coverageStatus: 'covered',
      policySnapshot: { policyId: 'pol-2' },
    });
    const cleared = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 2,
      policyId: null,
    });
    expect(cleared.coverageStatus).toBe('multiple');
    expect(store.audit.filter((a) => a.action === 'incident.coverage_none')).toHaveLength(0);
  });

  it('flags no coverage in the timeline and audit', async () => {
    const { service, refs, store } = setup();
    refs.revisions = [revision('pol-1', 1, '2026-02-01', '2026-03-01')];
    const incident = await service.create(TENANT_A, MANAGER, {
      ...draft,
      occurredAt: '2026-08-01T12:00:00Z',
    });
    expect(incident.coverageStatus).toBe('none');
    expect(store.audit.map((a) => a.action)).toEqual([
      'incident.created',
      'incident.coverage_none',
    ]);
    const timeline = await service.history(TENANT_A, MANAGER, incident.id);
    expect(timeline.map((t) => t.command)).toEqual(['create', 'coverage_none']);
    // Moving the event into a covered day, then out again, records the flag once more.
    const covered = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 1,
      occurredAt: '2026-02-15T12:00:00Z',
    });
    expect(covered.coverageStatus).toBe('covered');
    const lost = await service.update(TENANT_A, MANAGER, incident.id, {
      version: 2,
      occurredAt: '2026-08-02T12:00:00Z',
    });
    expect(lost.coverageStatus).toBe('none');
    expect((await service.history(TENANT_A, MANAGER, incident.id)).map((t) => t.command)).toEqual([
      'create',
      'coverage_none',
      'update',
      'update',
      'coverage_none',
    ]);
  });

  it('refuses a policy choice without an event day', async () => {
    const { service, refs } = setup();
    refs.revisions = [revision('pol-1', 1, '2026-01-01', '2026-12-31')];
    const error = await codeOf(service.create(TENANT_A, MANAGER, { ...draft, policyId: 'pol-1' }));
    expect(error.fieldErrors).toEqual([{ field: 'policyId', code: 'conflict' }]);
  });
});

describe('suggestions (case 5)', () => {
  it('suggests the assignment in force at the instant, principal first', async () => {
    const { service, refs } = setup();
    refs.assigned = [
      {
        employeeId: 'driver-1',
        type: 'principal',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-06-01T10:00:00Z',
      },
      {
        employeeId: 'driver-2',
        type: 'principal',
        startedAt: '2026-06-01T10:00:00Z',
        endedAt: null,
      },
      {
        employeeId: 'driver-1',
        type: 'secondary',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: null,
      },
      { employeeId: 'ghost', type: 'temporary', startedAt: '2026-01-01T00:00:00Z', endedAt: null },
    ];
    const at = (occurredAt: string) =>
      service.suggestions(TENANT_A, MANAGER, { vehicleId: VEHICLE, occurredAt });
    expect((await at('2026-06-01T09:59:00Z')).drivers.map((d) => [d.employeeId, d.type])).toEqual([
      ['driver-1', 'principal'],
    ]);
    expect((await at('2026-06-01T10:00:00Z')).drivers.map((d) => [d.employeeId, d.type])).toEqual([
      ['driver-2', 'principal'],
      ['driver-1', 'secondary'],
    ]);
    expect((await at('2025-01-01T00:00:00Z')).drivers).toEqual([]);
    expect(
      (
        await codeOf(
          service.suggestions(TENANT_A, MANAGER, {
            vehicleId: 'nope',
            occurredAt: '2026-06-01T10:00:00Z',
          }),
        )
      ).code,
    ).toBe('not_found');
    expect(
      (await codeOf(service.suggestions(TENANT_A, MANAGER, { vehicleId: VEHICLE }))).fieldErrors,
    ).toEqual([{ field: 'occurredAt', code: 'required' }]);
  });
});

describe('list', () => {
  it('filters, sorts and pages with a tiebreak by id', async () => {
    const { service } = setup();
    const a = await service.create(TENANT_A, MANAGER, {
      ...draft,
      severity: 'low',
      occurredAt: '2026-05-01T12:00:00Z',
    });
    const b = await service.create(TENANT_A, MANAGER, {
      ...draft,
      type: 'other',
      severity: 'critical',
      occurredAt: '2026-04-01T12:00:00Z',
    });
    await service.create(TENANT_A, MANAGER, { vehicleId: 'vehicle-2', type: 'other' });
    const list = (query: unknown) => service.list(TENANT_A, MANAGER, query);
    expect((await list({})).total).toBe(3);
    expect((await list({ sort: 'severity', direction: 'desc', limit: 25 })).items[0]?.id).toBe(
      b.id,
    );
    expect((await list({ sort: 'severity', direction: 'asc' })).items[0]?.severity).toBeNull();
    expect((await list({ sort: 'folio', direction: 'asc' })).items.map((i) => i.id)).toEqual([
      'incident-1',
      'incident-2',
      'incident-3',
    ]);
    expect((await list({ sort: 'occurredAt', direction: 'asc' })).items[0]?.id).toBe('incident-3');
    expect((await list({ sort: 'createdAt' })).items).toHaveLength(3);
    expect((await list({ type: 'other' })).total).toBe(2);
    expect((await list({ severity: 'low' })).items[0]?.id).toBe(a.id);
    expect((await list({ vehicleId: 'vehicle-2' })).total).toBe(1);
    expect((await list({ status: ['draft', 'reported'] })).total).toBe(3);
    expect((await list({ status: 'closed' })).total).toBe(0);
    expect((await list({ createdBy: 'me' })).total).toBe(3);
    expect((await list({ responsible: 'me' })).total).toBe(0);
    expect((await list({ occurredFrom: '2026-04-15', occurredTo: '2026-05-01' })).total).toBe(1);
    expect((await list({ limit: 25, offset: 2 })).items).toHaveLength(1);
  });

  it('rejects malformed queries', async () => {
    const { service } = setup();
    const bad = async (query: unknown, field: string) =>
      expect(
        (await codeOf(service.list(TENANT_A, MANAGER, query))).fieldErrors.map((e) => e.field),
      ).toContain(field);
    await bad({ status: [] }, 'status');
    await bad({ status: ['nope'] }, 'status');
    await bad({ severity: 'x' }, 'severity');
    await bad({ type: 'x' }, 'type');
    await bad({ vehicleId: '' }, 'vehicleId');
    await bad({ responsible: 'you' }, 'responsible');
    await bad({ createdBy: 'you' }, 'createdBy');
    await bad({ occurredFrom: '2026-02-30' }, 'occurredFrom');
    await bad({ occurredFrom: '2026-05-02', occurredTo: '2026-05-01' }, 'occurredTo');
    await bad({ sort: 'status' }, 'sort');
    await bad({ direction: 'up' }, 'direction');
    await bad({ limit: 10 }, 'limit');
    await bad({ offset: -1 }, 'offset');
    await bad({ other: 1 }, 'other');
  });
});
