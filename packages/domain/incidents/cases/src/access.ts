import type { Incident } from './types.js';

/** The caller as the domain sees it. Grants come from the session, never from the request. */
export interface IncidentActor {
  /** `user-<uuid>`: the id written to the timeline and the audit. */
  readonly id: string;
  readonly subject: string;
  readonly permissions: readonly string[];
  /** The member has (or had) a mechanic record: no access to incidents in M4 (D9, fail closed). */
  readonly mechanicLinked: boolean;
}

export const can = (actor: IncidentActor, permission: string): boolean =>
  actor.permissions.includes(permission);

/** Mechanic scope narrows to nothing; a member with `incidents:edit` is not scoped (they manage cases). */
export const isMechanicScoped = (actor: IncidentActor): boolean =>
  actor.mechanicLinked && !can(actor, 'incidents:edit');

/** Reading needs `incidents:view`; the generic `view` verb grants nothing here (ADR-0014). */
export const canView = (actor: IncidentActor): boolean =>
  can(actor, 'incidents:view') && !isMechanicScoped(actor);

export const canCreate = (actor: IncidentActor): boolean =>
  !isMechanicScoped(actor) && (can(actor, 'incidents:create') || can(actor, 'incidents:report'));

/** D8: `incidents:edit`, or the author with `incidents:report` while the case is a draft. */
export const canEdit = (actor: IncidentActor, incident: Incident): boolean =>
  can(actor, 'incidents:edit') ||
  (can(actor, 'incidents:report') &&
    incident.status === 'draft' &&
    incident.createdBy === actor.id);

/** Suggestions help to fill a case, so they need a right to write one. */
export const canSuggest = (actor: IncidentActor): boolean =>
  canView(actor) &&
  (can(actor, 'incidents:create') ||
    can(actor, 'incidents:edit') ||
    can(actor, 'incidents:report'));
