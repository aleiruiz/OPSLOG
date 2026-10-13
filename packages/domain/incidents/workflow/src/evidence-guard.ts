import {
  IncidentError,
  type Incident,
  type IncidentActor,
  type IncidentStore,
} from '../../cases/src/index.js';
import {
  EvidenceService,
  parseVersionOnly,
  type ChildServiceOptions,
  type IncidentChildStore,
  type IncidentFiles,
} from '../../third-parties/src/index.js';
import type { IncidentEvidenceFacts, IncidentRepairs } from './ports.js';
import { repairOrderOrBudget, type Facts } from './requirements.js';

/**
 * Evidence of a case with the guard of ADR-0014: while the case is in `repair`, unlinking the
 * budget that stands for "an order or a budget" is refused (422 `repair_order_or_budget`) when no
 * order and no other clean budget remain. INC-COSTS applies the same rule to unlinking an order.
 */
export class GuardedEvidenceService extends EvidenceService {
  public constructor(
    incidents: IncidentStore,
    children: IncidentChildStore,
    files: IncidentFiles,
    private readonly facts: { evidence: IncidentEvidenceFacts; repairs: IncidentRepairs },
    options: ChildServiceOptions = {},
  ) {
    super(incidents, children, files, options);
  }

  private async mustKeepRequirement(
    tenantId: string,
    incident: Incident,
    evidenceId: string,
  ): Promise<boolean> {
    const linked = await this.facts.evidence.evidence(tenantId, incident.id);
    const repairs = await this.facts.repairs.linkedOrders(tenantId, incident.id);
    const before: Facts = { evidence: linked, repairs };
    const after: Facts = { evidence: linked.filter((item) => item.id !== evidenceId), repairs };
    return repairOrderOrBudget(before) && !repairOrderOrBudget(after);
  }

  public override async detach(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    evidenceId: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.writable(tenantId, actor, incidentId);
    // A stale version is the base class's answer; the guard judges the state the caller read.
    if (incident.status === 'repair' && parseVersionOnly(input) === incident.version)
      if (await this.mustKeepRequirement(tenantId, incident, evidenceId))
        throw new IncidentError('missing_requirements', [], null, ['repair_order_or_budget']);
    return super.detach(tenantId, actor, incidentId, evidenceId, input);
  }
}
