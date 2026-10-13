import {
  INCIDENT_UPDATED_EVENT,
  IncidentError,
  assertNotTerminal,
  can,
  dayInZone,
  resolveCoverage,
  type Incident,
  type IncidentActor,
  type IncidentStatus,
  type IncidentStore,
} from '../../cases/src/index.js';
import { WorkflowBase, type WorkflowOptions } from './base.js';
import { changedFieldsOf } from './effects.js';
import {
  parseInsurance,
  parseResolution,
  type InsuranceChanges,
  type ResolutionChanges,
} from './input.js';
import type { WorkflowPorts } from './ports.js';

/** Where the process data of the insurer may change (SPECS §6.2): from review on, while the insurer or the decision is in play. */
const INSURANCE_STATES: readonly IncidentStatus[] = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'reopened',
];
/** The states from which a case can be resolved, and `resolved` itself until it is closed. */
const RESOLUTION_STATES: readonly IncidentStatus[] = [
  'under_review',
  'no_insurance',
  'insurance_process',
  'insurance_rejected',
  'repair',
  'resolved',
];

export const PROCESS_RULES = {
  insurerReportedInFuture: 'insurer_reported_on_in_future',
  insurerReportedBeforeEvent: 'insurer_reported_on_before_event',
} as const;

/** Process data of the case: what the insurer said and what was decided (INC-WORKFLOW PR 1). */
export class IncidentProcessService extends WorkflowBase {
  public constructor(store: IncidentStore, ports: WorkflowPorts, options: WorkflowOptions = {}) {
    super(store, ports, options);
  }

  /** `incidents:edit` on a case the caller sees (403 otherwise). */
  private async editable(tenantId: string, actor: IncidentActor, id: string): Promise<Incident> {
    const incident = await this.visible(tenantId, actor, id);
    if (!can(actor, 'incidents:edit')) throw new IncidentError('forbidden');
    return incident;
  }

  /** Closed and cancelled cases answer 409 first, then a state outside the list, then a stale version. */
  private guard(incident: Incident, states: readonly IncidentStatus[], version: number): void {
    assertNotTerminal(incident.status);
    if (!states.includes(incident.status)) throw new IncidentError('invalid_transition');
    if (incident.version !== version) throw new IncidentError('stale_version');
  }

  /** A day of the insurer report is a day of the tenant: not in the future, not before the event. */
  private async checkReportedOn(tenantId: string, incident: Incident, day: string): Promise<void> {
    const today = dayInZone(this.now(), await this.ports.references.timeZone(tenantId));
    if (day > today)
      throw new IncidentError('rule_violation', [], PROCESS_RULES.insurerReportedInFuture);
    if (incident.occurredOn !== null && day < incident.occurredOn)
      throw new IncidentError('rule_violation', [], PROCESS_RULES.insurerReportedBeforeEvent);
  }

  /** The policy chosen for the event day replaces the snapshot; the insurer name is preloaded from it. */
  private async coverage(
    tenantId: string,
    incident: Incident,
    policyId: string | null,
  ): Promise<Partial<Incident>> {
    const found = resolveCoverage({
      day: incident.occurredOn,
      revisions: await this.ports.references.policyRevisions(tenantId, incident.vehicleId),
      chosenPolicyId: policyId,
      previous: incident.policySnapshot,
    });
    return {
      coverageStatus: found.status,
      policySnapshot: found.snapshot,
      ...(found.snapshot && incident.insurerName === null
        ? { insurerName: found.snapshot.insurer }
        : {}),
    };
  }

  public async updateInsurance(
    tenantId: string,
    actor: IncidentActor,
    id: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.editable(tenantId, actor, id);
    const { version, policyId, ...fields }: InsuranceChanges = parseInsurance(input);
    this.guard(incident, INSURANCE_STATES, version);
    if (fields.insurerReportedOn)
      await this.checkReportedOn(tenantId, incident, fields.insurerReportedOn);
    const coverage =
      policyId === undefined ? {} : await this.coverage(tenantId, incident, policyId);
    return this.save(tenantId, actor, incident, 'insurance_updated', { ...coverage, ...fields });
  }

  public async updateResolution(
    tenantId: string,
    actor: IncidentActor,
    id: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.editable(tenantId, actor, id);
    const { version, ...fields }: ResolutionChanges = parseResolution(input);
    this.guard(incident, RESOLUTION_STATES, version);
    // The approvals covered what the supervisor saw: a changed resolution needs them again.
    return this.save(tenantId, actor, incident, 'resolution_updated', fields, {
      assumptionApproval: null,
      closeApproval: null,
    });
  }

  private async save(
    tenantId: string,
    actor: IncidentActor,
    incident: Incident,
    command: 'insurance_updated' | 'resolution_updated',
    changes: Partial<Incident>,
    alsoWhenChanged: Partial<Incident> = {},
  ): Promise<Incident> {
    // Nothing really changes: the case stays as it is, with no new version, entry or event.
    if (changedFieldsOf(incident, changes).length === 0) return incident;
    const all = { ...changes, ...alsoWhenChanged };
    return this.commit({
      tenantId,
      actor,
      incident,
      next: { ...incident, ...all },
      command,
      changed: changedFieldsOf(incident, all),
      comment: null,
      event: (written) => ({
        type: INCIDENT_UPDATED_EVENT,
        payload: { incidentId: written.id, version: written.version },
      }),
    });
  }
}
