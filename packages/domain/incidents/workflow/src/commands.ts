import {
  INCIDENT_COMMANDS,
  INCIDENT_TYPE_RULES,
  type Incident,
  type IncidentCommand,
  type IncidentStatus,
} from '../../cases/src/index.js';

/** Who may run a command (SPECS §6.2, ADR-0014). The generic `view`, `create` and `edit` verbs grant nothing. */
export type CommandPermission =
  /** `incidents:edit`, or the author of a draft with `incidents:report` (D8). */
  'edit_or_author' | 'edit' | 'approve' | 'close' | 'reopen';

export interface CommandRule {
  readonly from: readonly IncidentStatus[];
  /** `null` keeps the status (the assignment and the D20 approvals). */
  readonly to: IncidentStatus | null;
  readonly permission: CommandPermission;
  /** Money-bearing commands cannot be retried without the `Idempotency-Key` header (G3 H2). */
  readonly idempotencyRequired: boolean;
}

const OPEN_AFTER_DRAFT: readonly IncidentStatus[] = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];

/**
 * The transition table of SPECS §6.2 and the only source of states a command accepts. There are no
 * other transitions and no override (D16). `closed` and `cancelled` are terminal: no row starts there
 * except `reopen`.
 */
export const TRANSITIONS: Readonly<Record<IncidentCommand, CommandRule>> = {
  report: {
    from: ['draft'],
    to: 'reported',
    permission: 'edit_or_author',
    idempotencyRequired: false,
  },
  assign: { from: OPEN_AFTER_DRAFT, to: null, permission: 'edit', idempotencyRequired: false },
  review: {
    from: ['reported', 'reopened'],
    to: 'under_review',
    permission: 'edit',
    idempotencyRequired: false,
  },
  insure: {
    from: ['under_review'],
    to: 'insurance_process',
    permission: 'edit',
    idempotencyRequired: false,
  },
  no_insurance: {
    from: ['under_review'],
    to: 'no_insurance',
    permission: 'edit',
    idempotencyRequired: false,
  },
  reject: {
    from: ['insurance_process'],
    to: 'insurance_rejected',
    permission: 'edit',
    idempotencyRequired: false,
  },
  appeal: {
    from: ['insurance_rejected'],
    to: 'insurance_process',
    permission: 'edit',
    idempotencyRequired: false,
  },
  approve_assumption: {
    from: ['insurance_rejected'],
    to: null,
    permission: 'approve',
    idempotencyRequired: true,
  },
  repair: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'reopened'],
    to: 'repair',
    permission: 'edit',
    idempotencyRequired: false,
  },
  resolve: {
    from: ['under_review', 'no_insurance', 'insurance_process', 'insurance_rejected', 'repair'],
    to: 'resolved',
    permission: 'edit',
    idempotencyRequired: false,
  },
  approve_close: {
    from: ['resolved'],
    to: null,
    permission: 'approve',
    idempotencyRequired: true,
  },
  close: { from: ['resolved'], to: 'closed', permission: 'close', idempotencyRequired: true },
  reopen: { from: ['closed'], to: 'reopened', permission: 'reopen', idempotencyRequired: true },
  cancel: {
    from: ['draft', ...OPEN_AFTER_DRAFT],
    to: 'cancelled',
    permission: 'edit_or_author',
    idempotencyRequired: false,
  },
};

/** Commands that need an `Idempotency-Key`; the rest accept one. */
export const IDEMPOTENCY_REQUIRED_COMMANDS: readonly IncidentCommand[] = INCIDENT_COMMANDS.filter(
  (command) => TRANSITIONS[command].idempotencyRequired,
);

/**
 * The route of the type (SPECS §6.2): a case reaches `repair` or `resolved` straight from review
 * only when the type allows going on without the insurer, and `repair` only when the type allows
 * repairing at all. A closed route is a state conflict (409), never a missing requirement.
 */
export function routeAllows(
  command: IncidentCommand,
  status: IncidentStatus,
  type: Incident['type'],
): boolean {
  const rules = INCIDENT_TYPE_RULES[type];
  if (command === 'repair' && !rules.repairAllowed) return false;
  if ((command === 'repair' || command === 'resolve') && status === 'under_review')
    return rules.directRoute;
  return true;
}

/** Whether the table and the route of the type let the command run on the case now. */
export function transitionAllowed(incident: Incident, command: IncidentCommand): boolean {
  return (
    TRANSITIONS[command].from.includes(incident.status) &&
    routeAllows(command, incident.status, incident.type)
  );
}
