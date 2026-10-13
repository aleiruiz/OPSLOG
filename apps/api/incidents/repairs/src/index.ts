import type { RepairLinkView } from '../../../../../packages/domain/incidents/repairs/src/index.js';
import { runSession, type IncidentApiResponse } from '../../cases/src/index.js';
import type {
  IncidentRepairApiDeps,
  RepairLinkChangeView,
  RepairLinkItemView,
  RepairLinkListView,
  RepairUnlinkView,
} from './types.js';

export type * from './types.js';

/** Repair links of a case. Tenant, actor and grants come only from the session; no amount is ever returned. */
export class IncidentRepairApi {
  public constructor(private readonly deps: IncidentRepairApiDeps) {}

  private async item(tenantId: string, view: RepairLinkView): Promise<RepairLinkItemView> {
    return {
      ...view,
      linkedBy: {
        id: view.linkedBy.replace(/^user-/, ''),
        displayName: await this.deps.labels.member(tenantId, view.linkedBy),
      },
    };
  }

  public list(
    token: string,
    correlationId: string,
    incidentId: string,
  ): Promise<IncidentApiResponse<RepairLinkListView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => ({
      items: await Promise.all(
        (await this.deps.repairs.list(tenantId, actor, incidentId)).map((view) =>
          this.item(tenantId, view),
        ),
      ),
    }));
  }

  public link(
    token: string,
    correlationId: string,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<RepairLinkChangeView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => {
      const { incident, link } = await this.deps.repairs.link(
        tenantId,
        actor,
        incidentId,
        input,
        idempotencyKey,
      );
      return { version: incident.version, item: await this.item(tenantId, link) };
    });
  }

  public unlink(
    token: string,
    correlationId: string,
    incidentId: string,
    linkId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<RepairUnlinkView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => ({
      version: (
        await this.deps.repairs.unlink(tenantId, actor, incidentId, linkId, input, idempotencyKey)
      ).version,
    }));
  }
}
