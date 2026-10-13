import type { BffIncident, BffIncidentField, BffIncidentStatus } from '@opslog/contracts';
import type { IncidentCommand } from './types';

/**
 * A small copy of the transition table and the requirements of INC-WORKFLOW, enough for the stand-in
 * server of component tests and the shell mock. It is not a rule source: the real server decides.
 */
type CommandPermission = 'edit_or_author' | 'edit' | 'approve' | 'close' | 'reopen';
interface Rule {
  readonly from: readonly BffIncidentStatus[];
  readonly to: BffIncidentStatus | null;
  readonly permission: CommandPermission;
}
const OPEN: readonly BffIncidentStatus[] = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];
export const FAKE_TRANSITIONS: Readonly<Record<IncidentCommand, Rule>> = {
  report: { from: ['draft'], to: 'reported', permission: 'edit_or_author' },
  assign: { from: OPEN, to: null, permission: 'edit' },
  review: { from: ['reported', 'reopened'], to: 'under_review', permission: 'edit' },
  insure: { from: ['under_review'], to: 'insurance_process', permission: 'edit' },
  no_insurance: { from: ['under_review'], to: 'no_insurance', permission: 'edit' },
  reject: { from: ['insurance_process'], to: 'insurance_rejected', permission: 'edit' },
  appeal: { from: ['insurance_rejected'], to: 'insurance_process', permission: 'edit' },
  approve_assumption: { from: ['insurance_rejected'], to: null, permission: 'approve' },
  repair: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'reopened'],
    to: 'repair',
    permission: 'edit',
  },
  resolve: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'repair'],
    to: 'resolved',
    permission: 'edit',
  },
  approve_close: { from: ['resolved'], to: null, permission: 'approve' },
  close: { from: ['resolved'], to: 'closed', permission: 'close' },
  reopen: { from: ['closed'], to: 'reopened', permission: 'reopen' },
  cancel: { from: ['draft', ...OPEN], to: 'cancelled', permission: 'edit_or_author' },
};

const ALL_FIELDS: readonly BffIncidentField[] = [
  'vehicleId',
  'type',
  'severity',
  'driverId',
  'noDriverReason',
  'occurredAt',
  'location',
  'description',
  'vehicleOperable',
  'damage',
  'noPhotoJustification',
  'policyId',
];
export function fakeEditableFields(status: BffIncidentStatus): readonly BffIncidentField[] {
  if (status === 'closed' || status === 'cancelled') return [];
  if (status === 'draft') return ALL_FIELDS;
  if (status === 'reported' || status === 'under_review' || status === 'reopened')
    return ALL_FIELDS.filter((field) => field !== 'vehicleId');
  return ['severity', 'description', 'damage', 'location'];
}

export function fakeMayRun(
  permissions: readonly string[],
  incident: BffIncident,
  userId: string,
  command: IncidentCommand,
): boolean {
  if (!permissions.includes('incidents:view')) return false;
  const edit = permissions.includes('incidents:edit');
  switch (FAKE_TRANSITIONS[command].permission) {
    case 'edit_or_author':
      return (
        edit ||
        (permissions.includes('incidents:report') &&
          incident.status === 'draft' &&
          incident.createdBy.id === userId)
      );
    case 'edit':
      return edit;
    case 'approve':
      return permissions.includes('incidents:approve');
    case 'close':
      return (
        permissions.includes('incidents:close') && permissions.includes('incidents:view_costs')
      );
    case 'reopen':
      return permissions.includes('incidents:reopen');
  }
}

export interface FakeFacts {
  /** At least one order is linked to the case (INC-COSTS). */
  readonly repairLinked: boolean;
  readonly cleanPhoto: boolean;
  readonly cleanCategories: readonly string[];
  readonly pendingFiles: boolean;
  readonly thresholdConfigured: boolean;
  /** The company bears a cost above the threshold: D20 asks for an approval. */
  readonly approvalRequired: boolean;
}

const filled = (value: string | null): boolean => value !== null && value.trim().length > 0;

/** Stable requirement ids a command still lacks, in the order of SPECS §6.2. */
export function fakeMissing(
  command: IncidentCommand,
  incident: BffIncident,
  facts: FakeFacts,
): string[] {
  const checks: Record<string, boolean> = {};
  const { insurance, resolution } = incident;
  const clean = (category: string) => facts.cleanCategories.includes(category);
  const assumption = () => {
    if (incident.status === 'insurance_process')
      checks['insurer_result'] =
        insurance.insurerResult === 'accepted' || insurance.insurerResult === 'partial';
    if (incident.status === 'no_insurance' || incident.status === 'insurance_rejected')
      checks['cost_assumed'] = insurance.costAssumed === true;
    if (incident.status === 'insurance_rejected')
      checks['assumption_approval'] =
        !facts.approvalRequired || insurance.assumptionApproval !== null;
  };
  switch (command) {
    case 'report':
      checks['occurred_at'] = incident.occurredAt !== null;
      checks['location'] = incident.location !== null;
      checks['description'] = filled(incident.description);
      checks['severity'] = incident.severity !== null;
      checks['driver_or_reason'] = incident.driver !== null || filled(incident.noDriverReason);
      checks['vehicle_operable'] = incident.vehicleOperable !== null;
      checks['photo_or_justification'] = facts.cleanPhoto || filled(incident.noPhotoJustification);
      break;
    case 'review':
      checks['responsible'] = incident.responsible !== null;
      break;
    case 'insure':
      checks['policy_at_event'] = incident.coverage.policy !== null;
      checks['insurer'] = filled(insurance.insurerName);
      checks['claim_number'] = filled(insurance.claimNumber);
      checks['insurer_reported_on'] = insurance.insurerReportedOn !== null;
      break;
    case 'no_insurance':
      checks['no_insurance_reason'] = filled(insurance.noInsuranceReason);
      break;
    case 'reject':
      checks['rejection_reason'] = filled(insurance.rejectionReason);
      checks['rejection_letter'] = clean('rejection_letter');
      break;
    case 'appeal':
      checks['appeal_note'] = filled(insurance.appealNote);
      break;
    case 'approve_assumption':
    case 'approve_close':
      checks['d20_configured'] = facts.thresholdConfigured;
      break;
    case 'repair':
      checks['repair_order_or_budget'] = facts.repairLinked || clean('budget');
      assumption();
      break;
    case 'resolve':
      checks['resolution_summary'] = filled(resolution.resolutionSummary);
      checks['vehicle_status_decision'] = resolution.vehicleStatusDecision !== null;
      assumption();
      break;
    case 'close':
      checks['resolution_summary'] = filled(resolution.resolutionSummary);
      checks['vehicle_status_decision'] = resolution.vehicleStatusDecision !== null;
      checks['no_pending_evidence'] = !facts.pendingFiles;
      checks['close_approval'] = !facts.approvalRequired || resolution.closeApproval !== null;
      break;
    default:
      break;
  }
  return Object.entries(checks)
    .filter(([, met]) => !met)
    .map(([id]) => id);
}
