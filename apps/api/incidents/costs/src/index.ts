import type { CostsView } from '../../../../../packages/domain/incidents/costs/src/index.js';
import { runSession, type IncidentApiResponse } from '../../cases/src/index.js';
import type { IncidentCostApiDeps } from './types.js';

export type * from './types.js';
export type { CostsView };

/**
 * Costs of a case (`incidents:view_costs`). Tenant, actor and grants come only from the session.
 * A caller without the permission gets a 403 with no amount, currency or total in the answer.
 */
export class IncidentCostApi {
  public constructor(private readonly deps: IncidentCostApiDeps) {}

  public get(
    token: string,
    correlationId: string,
    incidentId: string,
  ): Promise<IncidentApiResponse<CostsView>> {
    return runSession(
      this.deps,
      token,
      correlationId,
      incidentId,
      async (tenantId, actor) => (await this.deps.costs.get(tenantId, actor, incidentId)).costs,
    );
  }

  public update(
    token: string,
    correlationId: string,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<CostsView>> {
    return runSession(
      this.deps,
      token,
      correlationId,
      incidentId,
      async (tenantId, actor) =>
        (await this.deps.costs.update(tenantId, actor, incidentId, input, idempotencyKey)).costs,
    );
  }
}
