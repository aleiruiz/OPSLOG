import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import {
  FakeReferences,
  NOW,
  TENANT_A,
  TENANT_B,
  VEHICLE,
  revision,
} from '../../../../../packages/domain/incidents/cases/src/test-support.js';
import {
  IncidentError,
  IncidentService,
  InMemoryIncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import { IncidentApi, type IncidentApiDeps } from './index.js';

const SUBJECT = '00000000-0000-4000-8000-0000000000aa';
const ALL = ['incidents:view', 'incidents:create', 'incidents:edit'] as const;

function world(over: Partial<IncidentApiDeps> = {}) {
  const store = new InMemoryIncidentStore();
  const refs = new FakeReferences();
  let n = 0;
  const incidents = new IncidentService(store, refs, {
    now: () => NOW,
    newId: () => `incident-${++n}`,
  });
  const sessions = new Map<
    string,
    { tenantId: string; permissions: readonly string[]; linked?: boolean }
  >();
  const denials: { action: string; entityId: string; tenantId: string }[] = [];
  const api = new IncidentApi({
    incidents,
    authorize: async (token, correlationId) => {
      const session = sessions.get(token);
      if (!session) throw Object.assign(new Error('x'), { code: 'unauthorized' });
      const context: TenantContext = {
        tenantId: session.tenantId,
        actor: { subject: SUBJECT, kind: 'user' },
        authorizationVersion: 1,
        correlationId,
      };
      return { context, permissions: session.permissions as never };
    },
    mechanicLinked: async (tenantId) => sessions.get(`link:${tenantId}`) !== undefined,
    labels: {
      vehicle: async (_tenant, id) =>
        id === VEHICLE ? { economicNumber: 'U-001', plate: 'ABC123' } : null,
      driver: async (_tenant, id) => (id === 'driver-1' ? 'Ana Pérez' : null),
      member: async () => 'Responsable de siniestros',
    },
    deny: async (context, action, entityId) => {
      denials.push({ action, entityId, tenantId: context.tenantId });
    },
    ...over,
  });
  sessions.set('manager', { tenantId: TENANT_A, permissions: [...ALL] });
  return { api, sessions, denials, refs, store };
}
const draft = { vehicleId: VEHICLE, type: 'collision' };

describe('IncidentApi', () => {
  it('creates, reads and edits with names beside ids and no technical labels', async () => {
    const { api } = world();
    const created = await api.create('manager', 'c1', {
      ...draft,
      driverId: 'driver-1',
      vehicleOperable: false,
    });
    expect(created.ok).toBe(true);
    expect(created.value).toMatchObject({
      folio: 'SIN-2026-000001',
      vehicle: { id: VEHICLE, economicNumber: 'U-001', plate: 'ABC123' },
      driver: { employeeId: 'driver-1', displayName: 'Ana Pérez' },
      createdBy: { id: SUBJECT, displayName: 'Responsable de siniestros' },
      responsible: null,
      reportedBy: null,
      insurance: { claimNumber: null, insurerResult: null, assumptionApproval: null },
      resolution: { resolutionSummary: null, closeApproval: null, closedBy: null },
      allowedCommands: [],
      coverage: { status: 'unknown', policy: null, alert: null },
      vehicleProposal: { suggestedStatus: 'out_of_service' },
    });
    expect(created.value).not.toHaveProperty('tenantId');
    const id = created.value?.id as string;
    const edited = await api.update('manager', 'c2', id, { version: 1, severity: 'high' });
    expect(edited.value).toMatchObject({ severity: 'high', version: 2 });
    expect((await api.get('manager', 'c3', id)).value?.editableFields).toContain('type');
    const timeline = await api.timeline('manager', 'c4', id);
    expect(
      timeline.value?.map((entry) => [entry.sequence, entry.command, entry.actor.displayName]),
    ).toEqual([
      [1, 'create', 'Responsable de siniestros'],
      [2, 'update', 'Responsable de siniestros'],
    ]);
    expect(timeline.value?.[1]?.changedFields).toEqual(['severity']);
  });

  it('falls back to neutral labels for a vehicle or driver that cannot be resolved', async () => {
    const { api } = world({
      labels: {
        vehicle: async () => null,
        driver: async () => null,
        member: async () => 'Persona',
      },
    });
    const created = await api.create('manager', 'c', { ...draft, driverId: 'driver-1' });
    expect(created.value?.vehicle).toEqual({
      id: VEHICLE,
      economicNumber: 'Vehículo no disponible',
      plate: '',
    });
    expect(created.value?.driver?.displayName).toBe('Conductor no disponible');
  });

  it('lists with total and resolves each name once', async () => {
    let lookups = 0;
    const { api } = world({
      labels: {
        vehicle: async () => {
          lookups += 1;
          return { economicNumber: 'U-001', plate: 'ABC123' };
        },
        driver: async () => null,
        member: async () => 'Persona',
      },
    });
    for (let i = 0; i < 3; i += 1) await api.create('manager', 'c', draft);
    lookups = 0;
    const page = await api.list('manager', 'c', { limit: 25 });
    expect(page.value).toMatchObject({ total: 3, tenantId: TENANT_A });
    expect(page.value?.items).toHaveLength(3);
    expect(lookups).toBe(1);
  });

  it('serves suggestions with the coverage alert', async () => {
    const { api, refs } = world();
    refs.assigned = [
      {
        employeeId: 'driver-1',
        type: 'principal',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: null,
      },
    ];
    refs.revisions = [revision('pol-1', 1, '2026-01-01', '2026-03-01')];
    const found = await api.suggestions('manager', 'c', {
      vehicleId: VEHICLE,
      occurredAt: '2026-02-01T12:00:00Z',
    });
    expect(found.value).toMatchObject({
      drivers: [{ employeeId: 'driver-1', displayName: 'Ana Pérez', type: 'principal' }],
      policies: [{ policyId: 'pol-1' }],
      coverage: { status: 'covered', alert: null },
    });
    const none = await api.suggestions('manager', 'c', {
      vehicleId: VEHICLE,
      occurredAt: '2026-08-01T12:00:00Z',
    });
    expect(none.value?.coverage).toEqual({ status: 'none', alert: 'no_policy_on_event_day' });
    refs.revisions = [
      revision('pol-1', 1, '2026-01-01', '2026-12-31'),
      revision('pol-2', 1, '2026-01-01', '2026-12-31'),
    ];
    expect(
      (
        await api.suggestions('manager', 'c', {
          vehicleId: VEHICLE,
          occurredAt: '2026-08-01T12:00:00Z',
        })
      ).value?.coverage.alert,
    ).toBe('several_policies');
  });

  it('maps every failure to status, code, field errors and rule, without echoing values', async () => {
    const { api } = world();
    const bad = await api.create('manager', 'c', { severity: 'secreto-123' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400 } });
    expect(bad.error?.fieldErrors).toEqual(
      expect.arrayContaining([{ field: 'vehicleId', code: 'required' }]),
    );
    expect(JSON.stringify(bad)).not.toContain('secreto-123');
    const future = await api.create('manager', 'c', {
      ...draft,
      occurredAt: '2027-01-01T00:00:00Z',
    });
    expect(future.error).toMatchObject({
      code: 'rule_violation',
      status: 422,
      rule: 'occurred_at_in_future',
    });
    const created = (await api.create('manager', 'c', draft)).value as { id: string };
    expect(
      (await api.update('manager', 'c', created.id, { version: 9, severity: 'low' })).error,
    ).toMatchObject({
      code: 'stale_version',
      status: 409,
    });
    expect((await api.create('manager', 'c', draft, 'bad key')).error?.status).toBe(400);
    const first = await api.create('manager', 'c', draft, 'idem-key-0001');
    expect(
      (await api.create('manager', 'c', { ...draft, type: 'other' }, 'idem-key-0001')).error?.code,
    ).toBe('idempotency_conflict');
    expect((await api.create('manager', 'c', draft, 'idem-key-0001')).value?.id).toBe(
      first.value?.id,
    );
    expect((await api.get('missing', 'c', created.id)).error).toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });

  it('maps unexpected and expired-session errors', async () => {
    const boom = world({
      authorize: async () => {
        throw new Error('database password=hunter2');
      },
    });
    const failed = await boom.api.get('x', 'c', 'i');
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
    expect(JSON.stringify(failed)).not.toContain('hunter2');
    const expired = world({
      authorize: async () => {
        throw Object.assign(new Error('x'), { code: 'expired' });
      },
    });
    expect((await expired.api.get('x', 'c', 'i')).error?.code).toBe('unauthorized');
    const odd = world({
      authorize: async () => {
        throw new IncidentError('duplicate');
      },
    });
    expect((await odd.api.get('x', 'c', 'i')).error).toMatchObject({
      code: 'duplicate',
      status: 409,
    });
  });

  it('answers 403 for the generic verbs, 404 for the mechanic scope, and audits each refusal', async () => {
    const { api, sessions, denials } = world();
    sessions.set('generic', { tenantId: TENANT_A, permissions: ['view', 'create', 'edit'] });
    sessions.set('viewer', { tenantId: TENANT_A, permissions: ['incidents:view'] });
    const created = (await api.create('manager', 'c', draft)).value as { id: string };
    expect((await api.list('generic', 'c', {})).error?.status).toBe(403);
    expect((await api.get('generic', 'c', created.id)).error?.status).toBe(403);
    expect((await api.create('generic', 'c', draft)).error?.status).toBe(403);
    expect(
      (await api.update('viewer', 'c', created.id, { version: 1, severity: 'low' })).error?.status,
    ).toBe(403);
    expect((await api.get('viewer', 'c', created.id)).ok).toBe(true);
    sessions.set('mechanic', { tenantId: TENANT_A, permissions: ['incidents:view'] });
    sessions.set(`link:${TENANT_A}`, { tenantId: TENANT_A, permissions: [] });
    expect((await api.get('mechanic', 'c', created.id)).error?.status).toBe(404);
    expect((await api.list('mechanic', 'c', {})).value).toMatchObject({ items: [], total: 0 });
    expect(denials.map((d) => d.action)).toEqual(
      Array(denials.length).fill('incident.access_denied'),
    );
    expect(denials.map((d) => d.entityId)).toEqual([
      'list',
      created.id,
      'new',
      created.id,
      created.id,
    ]);
  });

  it('answers a uniform 404 across tenants and still answers when the denial audit fails', async () => {
    const { api, sessions } = world({
      deny: async () => {
        throw new Error('audit down');
      },
    });
    sessions.set('other', { tenantId: TENANT_B, permissions: [...ALL] });
    const created = (await api.create('manager', 'c', draft)).value as { id: string };
    for (const result of [
      await api.get('other', 'c', created.id),
      await api.update('other', 'c', created.id, { version: 1, severity: 'low' }),
      await api.timeline('other', 'c', created.id),
      await api.get('other', 'c', '../etc/passwd'),
    ])
      expect(result.error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('records a refused access under an opaque entity id only', async () => {
    const { api, sessions, denials } = world();
    sessions.set('other', { tenantId: TENANT_B, permissions: [...ALL] });
    await api.get('other', 'c', 'nombre con espacios <script>');
    expect(denials).toEqual([
      { action: 'incident.access_denied', entityId: 'unknown', tenantId: TENANT_B },
    ]);
  });

  it('shows the process blocks with names for who approved and the commands the caller may run', async () => {
    const { api, sessions, store } = world({
      allowedCommands: (incident) => (incident.status === 'draft' ? ['report'] : []),
    });
    sessions.set('manager', { tenantId: TENANT_A, permissions: [...ALL] });
    const created = (await api.create('manager', 'c', draft)).value as { id: string };
    expect((await api.get('manager', 'c', created.id)).value?.allowedCommands).toEqual(['report']);
    const stored = (await store.get(TENANT_A, created.id)) as Parameters<
      typeof store.apply
    >[0]['incident'];
    const approval = { by: `user-${SUBJECT}`, at: '2026-10-13T10:00:00.000Z' };
    await store.apply({
      incident: {
        ...stored,
        status: 'resolved',
        version: 2,
        claimNumber: 'REP-1',
        insurerReportedOn: '2026-10-12',
        costAssumed: true,
        assumptionApproval: approval,
        closeApproval: approval,
        closedBy: `user-${SUBJECT}`,
        closedAt: '2026-10-13T11:00:00.000Z',
      },
      expectedVersion: 1,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    const view = (await api.get('manager', 'c', created.id)).value;
    expect(view?.allowedCommands).toEqual([]);
    expect(view?.insurance).toMatchObject({
      claimNumber: 'REP-1',
      insurerReportedOn: '2026-10-12',
      costAssumed: true,
      assumptionApproval: {
        by: { id: SUBJECT, displayName: 'Responsable de siniestros' },
        at: approval.at,
      },
    });
    expect(view?.resolution).toMatchObject({
      closeApproval: { by: { id: SUBJECT } },
      closedBy: { id: SUBJECT, displayName: 'Responsable de siniestros' },
      closedAt: '2026-10-13T11:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain(`user-${SUBJECT}`);
  });
});
