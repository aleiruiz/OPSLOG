import { INCIDENT_TYPE_RULES, type Incident, type IncidentCommand } from '../../cases/src/index.js';
import type {
  CostPresence,
  EvidenceFact,
  LinkedRepairOrder,
  RepairsSnapshot,
  ReportPhotoMode,
} from './ports.js';

/**
 * Everything the requirements may ask about a case beyond its own columns. A fact that was not
 * loaded is absent, and a requirement that depends on an absent fact is missing (fail closed).
 */
export interface Facts {
  readonly photoMode?: ReportPhotoMode;
  readonly evidence: readonly EvidenceFact[];
  readonly repairs?: RepairsSnapshot;
  readonly costs?: CostPresence;
  /** D20 asks for an approval of the cost assumption now. */
  readonly assumptionApprovalRequired?: boolean;
}

/** Data a command receives in its body, as opposed to what the case already holds. */
export interface CommandInput {
  readonly reason: string | null;
  readonly responsibleId: string | null;
}

const filled = (value: string | null): boolean => value !== null && value.trim().length > 0;
const hasClean = (facts: Facts, category: EvidenceFact['category']): boolean =>
  facts.evidence.some((item) => item.clean && item.category === category);

/** The orders that count as repairs: a cancelled one is no repair. */
export const activeOrders = (repairs: RepairsSnapshot | undefined): readonly LinkedRepairOrder[] =>
  repairs?.available === true ? repairs.orders.filter((order) => order.status !== 'cancelled') : [];

/** ADR-0014: a corrective order linked to the case OR a clean budget, not both. Without INC-COSTS, never. */
export const repairOrderOrBudget = (facts: Facts): boolean =>
  facts.repairs?.available === true &&
  (activeOrders(facts.repairs).length > 0 || hasClean(facts, 'budget'));

type Checks = Readonly<Record<string, boolean>>;
const when = (condition: boolean, checks: Checks): Checks => (condition ? checks : {});

function report(incident: Incident, facts: Facts): Checks {
  const photo = hasClean(facts, 'photo');
  return {
    vehicle: incident.vehicleId.length > 0,
    type: true,
    occurred_at: incident.occurredAt !== null,
    location: incident.location !== null,
    description: filled(incident.description),
    severity: incident.severity !== null,
    driver_or_reason: incident.driverId !== null || filled(incident.noDriverReason),
    vehicle_operable: incident.vehicleOperable !== null,
    photo_or_justification:
      facts.photoMode === 'photo_required' ? photo : photo || filled(incident.noPhotoJustification),
  };
}

/** The insurer accepted, fully or in part (SPECS §6.2: result accepted or partial). */
const insurerDecided = (incident: Incident): boolean =>
  incident.insurerResult === 'accepted' || incident.insurerResult === 'partial';

/** The origin-specific part that `repair` and `resolve` share. */
function assumption(incident: Incident, facts: Facts): Checks {
  const { status } = incident;
  return {
    ...when(status === 'insurance_process', { insurer_result: insurerDecided(incident) }),
    ...when(status === 'no_insurance' || status === 'insurance_rejected', {
      cost_assumed: incident.costAssumed === true,
    }),
    // The approval can only be recorded after a rejection, so it is asked for there and only there.
    ...when(status === 'insurance_rejected', {
      assumption_approval:
        facts.assumptionApprovalRequired !== true || incident.assumptionApproval !== null,
    }),
  };
}

function repair(incident: Incident, facts: Facts): Checks {
  return {
    repair_order_or_budget: repairOrderOrBudget(facts),
    ...assumption(incident, facts),
    ...when(incident.status === 'reopened', { responsible: incident.responsibleId !== null }),
  };
}

function resolve(incident: Incident, facts: Facts): Checks {
  const orders = activeOrders(facts.repairs);
  const repairs = facts.repairs?.available === true;
  const costs = facts.costs;
  return {
    resolution_summary: filled(incident.resolutionSummary),
    vehicle_status_decision: incident.vehicleStatusDecision !== null,
    ...assumption(incident, facts),
    ...when(incident.status === 'repair', {
      repair_orders_finished:
        repairs &&
        orders.every((order) => order.status === 'completed' || order.status === 'closed'),
      repair_costs:
        repairs &&
        costs?.available === true &&
        (orders.length > 0 ? orders.every((order) => order.hasCosts) : costs.hasRepairLine),
      final_evidence: facts.evidence.some(
        (item) => item.clean && (item.stage === 'post_repair' || item.category === 'invoice'),
      ),
    }),
  };
}

function cancel(incident: Incident, facts: Facts): Checks {
  // A draft has no linked orders or costs by model, so it cancels without asking INC-COSTS.
  if (incident.status === 'draft') return { no_costs: true, no_repairs: true };
  return {
    no_costs: facts.costs?.available === true && !facts.costs.hasCosts,
    no_repairs: facts.repairs?.available === true && activeOrders(facts.repairs).length === 0,
  };
}

const CHECKS: Partial<Record<IncidentCommand, (incident: Incident, facts: Facts) => Checks>> = {
  report,
  review: (incident) => ({ responsible: incident.responsibleId !== null }),
  insure: (incident, facts) => ({
    policy_at_event: incident.policySnapshot !== null,
    insurer: filled(incident.insurerName),
    claim_number: filled(incident.claimNumber),
    insurer_reported_on: incident.insurerReportedOn !== null,
    required_documents:
      !INCIDENT_TYPE_RULES[incident.type].reportRequiredForInsurer ||
      hasClean(facts, 'police_report'),
  }),
  no_insurance: (incident) => ({ no_insurance_reason: filled(incident.noInsuranceReason) }),
  reject: (incident, facts) => ({
    rejection_reason: filled(incident.rejectionReason),
    rejection_letter: hasClean(facts, 'rejection_letter'),
  }),
  appeal: (incident) => ({ appeal_note: filled(incident.appealNote) }),
  repair,
  resolve,
  cancel,
};

/**
 * Stable ids of every requirement the case does not meet for the command, in the order of SPECS §6.2.
 * `input` is the body of the command being run; `next-steps` passes none and lists only what the case lacks.
 */
export function missingRequirements(
  command: IncidentCommand,
  incident: Incident,
  facts: Facts,
  input?: CommandInput,
): readonly string[] {
  const own: Checks = input
    ? {
        ...when(command === 'assign', { responsible: input.responsibleId !== null }),
        ...when(command === 'cancel', { reason: filled(input.reason) }),
      }
    : {};
  const checks = { ...own, ...(CHECKS[command]?.(incident, facts) ?? {}) };
  return Object.entries(checks)
    .filter(([, met]) => !met)
    .map(([id]) => id);
}
