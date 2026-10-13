import {
  IncidentError,
  type Incident,
  type IncidentActor,
  type IncidentCommand,
  type IncidentExtraWrite,
} from '../../cases/src/index.js';
import type { IncidentClosure } from './closures.js';
import { approvalNeeded } from './facts.js';
import type { WorkflowPorts } from './ports.js';
import { activeOrders, type Facts } from './requirements.js';

/** The snapshot of the cycle that is closing, from the case as it stands and the facts read for the command. */
export function closureOf(
  incident: Incident,
  facts: Facts,
  stamp: { readonly time: string; readonly actor: IncidentActor },
): IncidentClosure {
  return {
    tenantId: incident.tenantId,
    incidentId: incident.id,
    cycle: incident.cycle,
    statusBefore: incident.status,
    resolvedFrom: facts.origin as NonNullable<Facts['origin']>,
    resolvedAt: incident.resolvedAt,
    resolutionSummary: incident.resolutionSummary,
    totalLoss: incident.totalLoss,
    vehicleStatusDecision: incident.vehicleStatusDecision,
    insurerResult: incident.insurerResult,
    costAssumed: incident.costAssumed,
    closeApprovedBy: incident.closeApproval?.by ?? null,
    closeApprovedAt: incident.closeApproval?.at ?? null,
    orders: activeOrders(facts.repairs).map((order) => ({
      orderId: order.orderId,
      version: order.version,
      status: order.status,
    })),
    closedAt: stamp.time,
    closedBy: stamp.actor.id,
  };
}

const missing = (id: string) => new IncidentError('missing_requirements', [], null, [id]);

/**
 * What a command checks again, and writes, inside the transaction of its own write (invariant 3):
 * the cost totals are read there, so an approval is never judged on costs that changed after the
 * facts were loaded, and the closure snapshot commits or fails with the case. A failure here aborts
 * the whole mutation.
 */
export function inTransaction(
  command: IncidentCommand,
  ports: WorkflowPorts,
  incident: Incident,
  closure: IncidentClosure | null,
): IncidentExtraWrite | undefined {
  const { tenantId, id } = incident;
  const guard = async (tx: unknown): Promise<void> => {
    if (command === 'approve_assumption' || command === 'approve_close') {
      if ((await ports.settings.closeCostThreshold(tenantId)) === null)
        throw missing('d20_configured');
      return;
    }
    if (command === 'close') {
      if ((await approvalNeeded(ports, tenantId, id, tx)) && incident.closeApproval === null)
        throw missing('close_approval');
      return;
    }
    // `repair` and `resolve` out of a rejection rest on the assumption approval.
    if (
      incident.status === 'insurance_rejected' &&
      (command === 'repair' || command === 'resolve') &&
      incident.assumptionApproval === null &&
      (await approvalNeeded(ports, tenantId, id, tx))
    )
      throw missing('assumption_approval');
  };
  const relevant =
    command === 'approve_assumption' ||
    command === 'approve_close' ||
    command === 'close' ||
    ((command === 'repair' || command === 'resolve') && incident.status === 'insurance_rejected');
  if (!relevant) return undefined;
  return {
    run: async (tx) => {
      await guard(tx);
      if (!closure) return true;
      // Snapshot of the costs first: the closure row is the last thing written.
      await ports.closureCosts.snapshot({ tenantId, incidentId: id, cycle: closure.cycle }, tx);
      return ports.closures.record(closure, tx);
    },
  };
}
