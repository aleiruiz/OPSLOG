import type { Incident, IncidentCommand } from '../../cases/src/index.js';
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
}
const NONE: Needs = {
  photo: false,
  evidence: false,
  repairs: false,
  costs: false,
  approval: false,
};

function needsOf(command: IncidentCommand, incident: Incident): Needs {
  const rejected = incident.status === 'insurance_rejected';
  switch (command) {
    case 'report':
      return { ...NONE, photo: true, evidence: true };
    case 'insure':
    case 'reject':
      return { ...NONE, evidence: true };
    case 'repair':
      return { ...NONE, evidence: true, repairs: true, approval: rejected };
    case 'resolve':
      return {
        photo: false,
        evidence: true,
        repairs: incident.status === 'repair',
        costs: incident.status === 'repair',
        approval: rejected,
      };
    case 'cancel':
      return { ...NONE, repairs: incident.status !== 'draft', costs: incident.status !== 'draft' };
    default:
      return NONE;
  }
}

/**
 * Loads, once per call, the facts the commands of one case ask for. They are read before the write:
 * anything that changes them afterwards moves the `version` of the case (evidence, costs, links), so
 * the compare-and-set of the command refuses to commit on stale facts.
 */
export class FactLoader {
  private readonly memo = new Map<string, Promise<unknown>>();
  public constructor(
    private readonly ports: WorkflowPorts,
    private readonly tenantId: string,
    private readonly incident: Incident,
  ) {}

  private once<T>(name: string, load: () => Promise<T>): Promise<T> {
    if (!this.memo.has(name)) this.memo.set(name, load());
    return this.memo.get(name) as Promise<T>;
  }

  /** D20 on the cost assumption: the threshold, then the totals only when there is one to compare with. */
  private assumptionRequired(): Promise<boolean> {
    return this.once('approval', async () => {
      const threshold = await this.ports.settings.closeCostThreshold(this.tenantId);
      if (threshold === null) return false;
      return approvalRequired(
        threshold,
        await this.ports.totals.totals(this.tenantId, this.incident.id),
      );
    });
  }

  public async forCommand(command: IncidentCommand): Promise<Facts> {
    const needs = needsOf(command, this.incident);
    const { tenantId, incident, ports } = this;
    const [photoMode, evidence, repairs, costs, approval] = await Promise.all([
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
      needs.approval ? this.assumptionRequired() : undefined,
    ]);
    return {
      evidence,
      ...(photoMode === undefined ? {} : { photoMode }),
      ...(repairs === undefined ? {} : { repairs }),
      ...(costs === undefined ? {} : { costs }),
      ...(approval === undefined ? {} : { assumptionApprovalRequired: approval }),
    };
  }
}
