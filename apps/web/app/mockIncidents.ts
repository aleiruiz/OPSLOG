import type { ApiError } from '@opslog/contracts';
import { completeEvent, createFakeIncidentPorts } from '../features/incidents/fakePorts';
import type { IncidentPorts } from '../features/incidents/ports';
import type { Permission, Result } from './types';

const OWN_PERMISSIONS: readonly Permission[] = [
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
];
/** Grants of other modules the incident screens rely on: listing and registering orders, and the settings. */
const GENERIC_PERMISSIONS: readonly Permission[] = ['view', 'create', 'manage_config', 'view_pii'];
const unauthorized: Result<never> = {
  ok: false,
  error: {
    status: 401,
    code: 'unauthorized',
    message: 'Authentication required',
    correlationId: 'mock',
  } satisfies ApiError,
};

/**
 * Incident routes of the mock API: the in-memory stand-in of the feature (`createFakeIncidentPorts`) behind the
 * same session checks as every other mock port. The signed-in role decides what the fake lets through, using the
 * incident permissions only (ADR-0014). All data is synthetic.
 */
export function createMockIncidentPorts(session: {
  readonly userId: () => string | null;
  readonly can: (permission: Permission) => boolean;
}): IncidentPorts {
  const fake = createFakeIncidentPorts({
    permissions: () => [
      ...OWN_PERMISSIONS.filter(session.can),
      ...GENERIC_PERMISSIONS.filter(session.can),
    ],
    userId: () => session.userId() ?? '',
    viewPii: () => session.can('view_pii'),
    // A corrective order of the first case's vehicle, so the repair tab has something to link.
    orders: [
      {
        id: 'order-mock-1',
        vehicleId: 'veh-001',
        description: 'Cambio de defensa delantera',
        workshop: 'Taller Central',
        createdAt: '2026-10-12T10:00:00.000Z',
        costs: [{ amountMinor: '1500000', currency: 'MXN' }],
      },
    ],
    alerts: [
      {
        id: 'alert-mock-1',
        incidentId: 'inc-002',
        folio: 'SIN-2026-000002',
        kind: 'sla_warning',
        cycle: 1,
        createdAt: '2026-10-13T08:00:00.000Z',
        severity: 'medium',
        deadline: '2026-10-20T12:00:00.000Z',
      },
    ],
    incidents: [
      completeEvent({ id: 'inc-001', folio: 'SIN-2026-000001', status: 'draft' }),
      completeEvent({
        id: 'inc-002',
        folio: 'SIN-2026-000002',
        status: 'reported',
        version: 3,
        sla: {
          cycle: 1,
          state: 'warning',
          startedAt: '2026-10-05T12:00:00.000Z',
          deadline: '2026-11-04T12:00:00.000Z',
          targetDays: 30,
          elapsedPercent: 85,
          resolvedAt: null,
          previousCycles: [],
        },
      }),
    ],
  });
  const guard =
    <A extends unknown[], T>(call: (...args: A) => Promise<Result<T>>) =>
    (...args: A): Promise<Result<T>> =>
      session.userId() === null ? Promise.resolve(unauthorized) : call(...args);
  const wrap = <G extends object>(group: G): G =>
    Object.fromEntries(
      Object.entries(group).map(([name, call]) => [
        name,
        typeof call === 'function'
          ? guard(call as (...args: unknown[]) => Promise<Result<unknown>>)
          : wrap(call as object),
      ]),
    ) as G;
  return wrap(fake.ports);
}
