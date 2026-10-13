import type { BffIncident, BffIncidentNextStep, BffIncidentStatus } from '@opslog/contracts';
import type { IncidentCommand } from './types';
import { APPROVAL_REQUIREMENTS, COMMAND_LABELS, requirementLabel } from './labels';

/** Own permissions of incidents (ADR-0014): the generic `view`, `create` and `edit` grant nothing here. */
export const mayViewIncidents = (permissions: readonly string[]): boolean =>
  permissions.includes('incidents:view');
export const mayStartIncident = (permissions: readonly string[]): boolean =>
  permissions.includes('incidents:create') || permissions.includes('incidents:report');
export const mayApprove = (permissions: readonly string[]): boolean =>
  permissions.includes('incidents:approve');

/** Amounts are for `incidents:view_costs` only (D10): without it nothing about costs is shown or requested. */
export const mayViewCosts = (permissions: readonly string[]): boolean =>
  permissions.includes('incidents:view_costs');

/** The server sends no editable fields when the caller may not write (or the case is closed or cancelled). */
export const canWrite = (incident: BffIncident): boolean => incident.editableFields.length > 0;

/** Where the insurer data and the resolution may change (SPECS §6.2); a refused write comes back as a 409. */
const INSURANCE_STATES: readonly BffIncidentStatus[] = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'reopened',
];
const RESOLUTION_STATES: readonly BffIncidentStatus[] = [
  'under_review',
  'no_insurance',
  'insurance_process',
  'insurance_rejected',
  'repair',
  'resolved',
];
export const canEditInsurance = (incident: BffIncident): boolean =>
  canWrite(incident) && INSURANCE_STATES.includes(incident.status);
export const canEditResolution = (incident: BffIncident): boolean =>
  canWrite(incident) && RESOLUTION_STATES.includes(incident.status);

/** Where an order may be linked or unlinked and the case's own costs may change (INC-COSTS): not a draft, not finished. */
const REPAIR_STATES: readonly BffIncidentStatus[] = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'reopened',
];
export const canLinkRepairs = (incident: BffIncident, permissions: readonly string[]): boolean =>
  permissions.includes('incidents:edit') && REPAIR_STATES.includes(incident.status);
export const canEditCosts = (incident: BffIncident, permissions: readonly string[]): boolean =>
  permissions.includes('incidents:edit') &&
  mayViewCosts(permissions) &&
  incident.status !== 'draft' &&
  canWrite(incident);

export const isFinished = (incident: BffIncident): boolean =>
  incident.status === 'closed' || incident.status === 'cancelled';

/** One command of `next-steps` as the panel shows it. */
export interface StepView {
  readonly command: IncidentCommand;
  readonly label: string;
  readonly missing: readonly string[];
  /** The server needs a supervisor's approval (D20) before this command can run. */
  readonly awaitsApproval: boolean;
}

export function stepViews(steps: readonly BffIncidentNextStep[]): readonly StepView[] {
  return steps.map((step) => ({
    command: step.command,
    label: COMMAND_LABELS[step.command],
    missing: step.missingRequirements,
    awaitsApproval: step.missingRequirements.some((id) => APPROVAL_REQUIREMENTS.includes(id)),
  }));
}

const isApproval = (command: IncidentCommand): boolean =>
  command === 'approve_close' || command === 'approve_assumption';

/** Lines for `NextStepPanel`: what each command still lacks, in Spanish (never raw ids). */
export function missingLines(views: readonly StepView[]): string[] {
  // An approval the caller cannot give yet is not a step to complete: it never reads as "Falta para continuar".
  return views
    .filter((view) => !isApproval(view.command))
    .flatMap((view) => view.missing.map((id) => `${view.label}: ${requirementLabel(id)}`));
}

export type ApprovalKind = 'assumption' | 'close';

/**
 * Which supervisor approval to offer (D20, ADR-0014). The server decided whether the cost needs one: the
 * approval is pending when a command lists `close_approval` or `assumption_approval` as missing. A caller
 * who sees none of the commands that would carry that requirement (an approver without `edit` or `close`)
 * is offered the approval whenever the server allows the command and none has been given yet. The screen
 * never compares amounts and never shows the threshold.
 */
export function approvalsToOffer(
  incident: BffIncident,
  views: readonly StepView[],
): readonly ApprovalKind[] {
  const offers: ApprovalKind[] = [];
  const has = (command: IncidentCommand) => views.some((view) => view.command === command);
  // An approval command that lists its own missing requirements is not available: never offer it.
  const ready = (command: IncidentCommand) =>
    views.some((view) => view.command === command && view.missing.length === 0);
  const lists = (id: string) => views.some((view) => view.missing.includes(id));
  if (ready('approve_close') && incident.resolution.closeApproval === null) {
    if (lists('close_approval') || !has('close')) offers.push('close');
  }
  if (ready('approve_assumption') && incident.insurance.assumptionApproval === null) {
    const carriers = views.some((view) => view.command === 'repair' || view.command === 'resolve');
    if (lists('assumption_approval') || !carriers) offers.push('assumption');
  }
  return offers;
}

/** Whether any approval is still pending for someone else to give (shown to callers without `incidents:approve`). */
export const approvalPending = (views: readonly StepView[]): boolean =>
  views.some((view) => view.awaitsApproval);

/** Commands that need the person to say something first (a responsible, a reason or a note). */
export const REASON_COMMANDS: readonly IncidentCommand[] = [
  'cancel',
  'reopen',
  'reject',
  'no_insurance',
  'appeal',
];
