import { ALERT_KINDS, type AlertKind } from './catalog.js';
import type { AlertMembers } from './ports.js';
import type { SlaAlert } from './types.js';

/**
 * Who a notice is for (task package, ADR-0014). Every right is an incident right: the generic `view`
 * and `edit` verbs count for nothing.
 * - `assignee`: the responsible the notice was written for, while they still are.
 * - `responsible`: the current responsible, or the members who manage cases while there is none.
 * - `edit` and `approve`: the holders of `incidents:edit` and `incidents:approve`, in addition.
 */
export interface Audience {
  readonly assignee: boolean;
  readonly responsible: boolean;
  readonly edit: boolean;
  readonly approve: boolean;
}
const only = (over: Partial<Audience>): Audience => ({
  assignee: false,
  responsible: false,
  edit: false,
  approve: false,
  ...over,
});
export const AUDIENCE: Readonly<Record<AlertKind, Audience>> = {
  assigned: only({ assignee: true }),
  sla_warning: only({ responsible: true }),
  sla_breach: only({ responsible: true, approve: true }),
  unassigned: only({ edit: true }),
  unassigned_escalation: only({ edit: true, approve: true }),
  inactive: only({ responsible: true }),
  inactive_escalation: only({ responsible: true, approve: true }),
};
/** Kinds a member sees by right alone, and kinds that also depend on who is responsible. */
export const kindsWhere = (select: (audience: Audience) => boolean): readonly AlertKind[] =>
  ALERT_KINDS.filter((kind) => select(AUDIENCE[kind]));

/** The member asking for the list: who they are and what they may manage now. */
export interface Viewer {
  readonly id: string;
  readonly edit: boolean;
  readonly approve: boolean;
}

/** Whether a member sees a notice, given who is responsible for its case now. */
export function visibleTo(
  alert: Pick<SlaAlert, 'kind' | 'subjectId'>,
  responsibleId: string | null,
  viewer: Viewer,
): boolean {
  const audience = AUDIENCE[alert.kind];
  if (audience.assignee) return alert.subjectId === viewer.id && responsibleId === viewer.id;
  if (audience.responsible && (responsibleId === null ? viewer.edit : responsibleId === viewer.id))
    return true;
  return (audience.edit && viewer.edit) || (audience.approve && viewer.approve);
}

/** The members a notice is addressed to now, before each one is revalidated. */
export async function recipientsOf(
  alert: Pick<SlaAlert, 'kind' | 'subjectId' | 'tenantId'>,
  responsibleId: string | null,
  members: AlertMembers,
): Promise<readonly string[]> {
  const audience = AUDIENCE[alert.kind];
  const found = new Set<string>();
  if (audience.assignee && alert.subjectId !== null && alert.subjectId === responsibleId)
    found.add(alert.subjectId);
  if (audience.responsible && responsibleId !== null) found.add(responsibleId);
  if (audience.edit || (audience.responsible && responsibleId === null))
    for (const id of await members.holders(alert.tenantId, 'incidents:edit')) found.add(id);
  if (audience.approve)
    for (const id of await members.holders(alert.tenantId, 'incidents:approve')) found.add(id);
  return [...found].sort();
}
