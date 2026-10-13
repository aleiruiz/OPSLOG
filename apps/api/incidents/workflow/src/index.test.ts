import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import {
  IncidentError,
  type IncidentActor,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  setup,
  TENANT_A,
} from '../../../../../packages/domain/incidents/workflow/src/test-support.js';
import { IncidentWorkflowApi } from './index.js';

const SUBJECT = '00000000-0000-4000-8000-0000000000aa';
const ALL = [
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:close',
  'incidents:view_costs',
] as const;

function world() {
  const base = setup();
  const sessions = new Map<string, { tenantId: string; permissions: readonly string[] }>();
  const denials: string[] = [];
  const api = new IncidentWorkflowApi({
    incidents: base.cases,
    workflow: base.workflow,
    process: base.process,
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
    mechanicLinked: async () => false,
    labels: {
      vehicle: async () => ({ economicNumber: 'U-001', plate: 'ABC123' }),
      driver: async () => 'Ana Pérez',
      member: async () => 'Responsable de siniestros',
    },
    deny: async (_context, action, entityId) => {
      denials.push(`${action}:${entityId}`);
    },
  });
  sessions.set('manager', { tenantId: TENANT_A, permissions: [...ALL] });
  sessions.set('reader', { tenantId: TENANT_A, permissions: ['incidents:view'] });
  return { ...base, api, sessions, denials };
}

describe('IncidentWorkflowApi', () => {
  it('reports a case and answers the view with what the caller may do next', async () => {
    const w = world();
    const created = await w.cases.create(TENANT_A, actorOf(), {
      vehicleId: 'vehicle-1',
      type: 'collision',
      severity: 'low',
      driverId: 'driver-1',
      vehicleOperable: true,
      occurredAt: '2026-10-13T12:00:00.000Z',
      location: { text: 'Calle Sintética' },
      description: 'Descripción sintética',
      noPhotoJustification: 'Sin foto',
    });
    const response = await w.api.transition('manager', 'corr-1', created.id, {
      command: 'report',
      version: created.version,
    });
    expect(response.ok && response.value).toMatchObject({
      status: 'reported',
      allowedCommands: ['assign', 'review', 'cancel'],
    });
    const steps = await w.api.nextSteps('manager', 'corr-2', created.id);
    expect(steps).toEqual({
      ok: true,
      value: {
        items: [
          { command: 'assign', missingRequirements: [] },
          { command: 'review', missingRequirements: ['responsible'] },
          { command: 'cancel', missingRequirements: [] },
        ],
      },
    });
  });

  it('answers 422 with the requirements, 400 without a key where one is required, and audits refusals', async () => {
    const w = world();
    const created = await w.cases.create(TENANT_A, actorOf(), {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    const missing = await w.api.transition('manager', 'c', created.id, {
      command: 'report',
      version: 1,
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { status: 422, code: 'missing_requirements' },
    });
    expect(!missing.ok && missing.error?.missingRequirements).toContain('occurred_at');
    const noKey = await w.api.transition('manager', 'c', created.id, {
      command: 'close',
      version: 1,
    });
    expect(noKey).toMatchObject({ ok: false, error: { status: 400 } });
    const reader = await w.api.transition('reader', 'c', created.id, {
      command: 'report',
      version: 1,
    });
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    expect(w.denials).toContain(`incident.access_denied:${created.id}`);
    expect(await w.api.transition('nobody', 'c', created.id, {})).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
  });

  it('updates insurance and resolution through the process service', async () => {
    const w = world();
    const created = await w.cases.create(TENANT_A, actorOf(), {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    const review = await w.store.get(TENANT_A, created.id);
    await w.store.apply({
      incident: { ...review!, status: 'under_review', version: 2 },
      expectedVersion: 1,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    const insurance = await w.api.updateInsurance('manager', 'c', created.id, {
      version: 2,
      claimNumber: 'REP-1',
    });
    expect(insurance.ok && insurance.value?.insurance).toMatchObject({ claimNumber: 'REP-1' });
    const resolution = await w.api.updateResolution('manager', 'c', created.id, {
      version: 3,
      resolutionSummary: 'Resuelto',
    });
    expect(resolution.ok && resolution.value?.resolution).toMatchObject({
      resolutionSummary: 'Resuelto',
    });
    const stale = await w.api.updateResolution('manager', 'c', created.id, {
      version: 3,
      costAssumed: true,
    });
    expect(stale).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await w.api.nextSteps('reader', 'c', 'unknown-id')).toMatchObject({
      ok: false,
      error: { status: 404 },
    });
  });

  it('never leaks an unexpected failure', async () => {
    const w = world();
    w.workflow.execute = async () => {
      throw new Error('secret database detail');
    };
    const response = await w.api.transition('manager', 'c', 'incident-1', {});
    expect(response).toMatchObject({
      ok: false,
      error: { status: 500, message: 'Request failed' },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(new IncidentError('forbidden').code).toBe('forbidden');
  });
});

function actorOf(): IncidentActor {
  return {
    id: `user-${SUBJECT}`,
    subject: SUBJECT,
    permissions: [...ALL] as never,
    mechanicLinked: false,
  };
}
