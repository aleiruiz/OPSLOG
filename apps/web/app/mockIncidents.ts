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
      ...(session.can('view_pii') ? ['view_pii'] : []),
    ],
    userId: () => session.userId() ?? '',
    viewPii: () => session.can('view_pii'),
    incidents: [
      completeEvent({ id: 'inc-001', folio: 'SIN-2026-000001', status: 'draft' }),
      completeEvent({ id: 'inc-002', folio: 'SIN-2026-000002', status: 'reported', version: 3 }),
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
