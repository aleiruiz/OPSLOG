import type { AlertPage } from '../../../../../packages/domain/incidents/sla/src/index.js';
import { runSession, type IncidentApiResponse } from '../../cases/src/index.js';
import type { IncidentSlaApiDeps } from './types.js';

export type * from './types.js';

/**
 * The notices of the incident SLA (`GET /incidents/alerts`). Tenant, actor and grants come only
 * from the session; the reader shows each member the notices their rights and their cases allow.
 */
export class IncidentSlaApi {
  public constructor(private readonly deps: IncidentSlaApiDeps) {}

  public alerts(
    token: string,
    correlationId: string,
    query: unknown,
  ): Promise<IncidentApiResponse<AlertPage>> {
    return runSession(this.deps, token, correlationId, 'alerts', (tenantId, actor) =>
      this.deps.reader.alerts(tenantId, actor, query),
    );
  }
}
