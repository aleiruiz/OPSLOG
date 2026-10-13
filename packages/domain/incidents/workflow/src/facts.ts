import type {
  Incident,
  IncidentCommand,
  IncidentStatus,
  IncidentStore,
} from '../../cases/src/index.js';
import { approvalRequired } from './d20.js';
import type { Facts } from './requirements.js';
import type { WorkflowPorts } from './ports.js';

/** What a command asks beyond the columns of the case, by command and origin. */
interface Needs {
  readonly photo: boolean;
  readonly evidence: boolean;
  readonly repairs: boolean;
  readonly costs: boolean;
  readonly approval: boolean;
  /** The company has a D20 threshold (the approval commands need one). */
  readonly threshold: boolean;
  readonly closeApproval: boolean;
  readonly blocks: boolean;
  /** The route of the closing cycle, from the timeline. */
  readonly origin: boolean;
}
const NONE: Needs = {
  photo: false,
  evidence: false,
  repairs: false,
  costs: false,
  approval: false,
  threshold: false,
  closeApproval: false,
  blocks: false,
  origin: false,
};

function needsOf(command: IncidentCommand, incident: Incident): Needs {
  const rejected = incident.status === 'insurance_rejected';
  const active = incident.vehicleStatusDecision === 'active';
  switch (command) {
    case 'approve_assumption':
    case 'approve_close':
      return { ...NONE, threshold: true };
    case 'close':
      return {
        ...NONE,
        evidence: true,
        repairs: true,
        costs: true,
        closeApproval: true,
        blocks: active,
        origin: true,
      };
    case 'report':
      return { ...NONE, photo: true, evidence: true };
    case 'insure':
    case 'reject':
      return { ...NONE, evidence: true };
    case 'repair':
      return { ...NONE, evidence: true, repairs: true, approval: rejected };
    case 'resolve':
      return {
        ...NONE,
        evidence: true,
        repairs: incident.status === 'repair',
        costs: incident.status === 'repair',
        approval: rejected,
        blocks: active,
        origin: false,
      };
    case 'cancel':
      return { ...NONE, repairs: incident.status !== 'draft', costs: incident.status !== 'draft' };
    default:
      return NONE;
  }
}

/**
 * D20 by amount (ADR-0014): whether what the company bears calls for an approval now. The threshold
 * is read first and the totals only when there is one to compare with; a read that fails throws (500).
 * `tx` joins the transaction of the command, so the decision and the write see the same costs.
 */
export async function approvalNeeded(
  ports: Pick<WorkflowPorts, 'settings' | 'totals'>,
  tenantId: string,
  incidentId: string,
  tx?: unknown,
): Promise<boolean> {
  const threshold = await ports.settings.closeCostThreshold(tenantId);
  if (threshold === null) return false;
  return approvalRequired(threshold, await ports.totals.totals(tenantId, incidentId, tx));
}

/** The state the last `resolve` of the case came from; `null` when the timeline has none. */
async function resolvedFrom(
  history: Pick<IncidentStore, 'history'>,
  tenantId: string,
  incidentId: string,
): Promise<IncidentStatus | null> {
  const entries = await history.history(tenantId, incidentId);
  return [...entries].reverse().find((entry) => entry.command === 'resolve')?.from ?? null;
}

/**
 * Loads, once per call, the facts the commands of one case ask for. They are read before the write
 * to answer with the full list of what is missing; the commands that decide on money check the
 * approval again inside the transaction of the write, and anything else that changes the facts
 * afterwards moves the `version` of the case, so the compare-and-set refuses to commit on stale facts.
 */
export class FactLoader {
  private readonly memo = new Map<string, Promise<unknown>>();
  public constructor(
    private readonly ports: WorkflowPorts,
    private readonly history: Pick<IncidentStore, 'history'>,
    private readonly tenantId: string,
    private readonly incident: Incident,
  ) {}

  private once<T>(name: string, load: () => Promise<T>): Promise<T> {
    if (!this.memo.has(name)) this.memo.set(name, load());
    return this.memo.get(name) as Promise<T>;
  }

  public async forCommand(command: IncidentCommand): Promise<Facts> {
    const needs = needsOf(command, this.incident);
    const { tenantId, incident, ports } = this;
    const [photoMode, evidence, repairs, costs, approval, threshold, blocked, origin] =
      await Promise.all([
        needs.photo ? this.once('photo', () => ports.settings.reportPhoto(tenantId)) : undefined,
        needs.evidence
          ? this.once('evidence', () => ports.evidence.evidence(tenantId, incident.id))
          : [],
        needs.repairs
          ? this.once('repairs', () => ports.repairs.linkedOrders(tenantId, incident.id))
          : undefined,
        needs.costs
          ? this.once('costs', () => ports.costs.presence(tenantId, incident.id))
          : undefined,
        needs.approval || needs.closeApproval
          ? this.once('approval', () => approvalNeeded(ports, tenantId, incident.id))
          : undefined,
        needs.threshold
          ? this.once(
              'threshold',
              async () => (await ports.settings.closeCostThreshold(tenantId)) !== null,
            )
          : undefined,
        needs.blocks
          ? this.once('blocks', () =>
              ports.blocks.blocked(tenantId, incident.vehicleId, incident.id),
            )
          : undefined,
        needs.origin
          ? this.once('origin', () => resolvedFrom(this.history, tenantId, incident.id))
          : undefined,
      ]);
    // A standing approval only counts while the costs have not grown past what it covered.
    const kind = needs.closeApproval ? 'close' : 'assumption';
    const standing = kind === 'close' ? incident.closeApproval : incident.assumptionApproval;
    const stale =
      approval === true && standing !== null
        ? await ports.closureCosts.approvalStale({ tenantId, incidentId: incident.id, kind })
        : false;
    return {
      evidence,
      ...(stale ? { approvalStale: true } : {}),
      ...(photoMode === undefined ? {} : { photoMode }),
      ...(repairs === undefined ? {} : { repairs }),
      ...(costs === undefined ? {} : { costs }),
      ...(approval === undefined
        ? {}
        : needs.closeApproval
          ? { closeApprovalRequired: approval }
          : { assumptionApprovalRequired: approval }),
      ...(threshold === undefined ? {} : { thresholdConfigured: threshold }),
      ...(blocked === undefined ? {} : { vehicleBlocked: blocked }),
      ...(origin === undefined ? {} : { origin }),
    };
  }
}
