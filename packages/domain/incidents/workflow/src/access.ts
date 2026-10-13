import {
  can,
  canEdit,
  canView,
  type Incident,
  type IncidentActor,
  type IncidentCommand,
} from '../../cases/src/index.js';
import { TRANSITIONS, transitionAllowed, IMPLEMENTED_COMMANDS } from './commands.js';

/**
 * Permission of a command on a case the caller already sees. Only the permissions of incidents count
 * (ADR-0014): a fleet editor with the generic `view`, `create` and `edit` runs nothing here.
 */
export function mayRun(
  actor: IncidentActor,
  incident: Incident,
  command: IncidentCommand,
): boolean {
  if (!canView(actor)) return false;
  switch (TRANSITIONS[command].permission) {
    case 'edit_or_author':
      return canEdit(actor, incident);
    case 'edit':
      return can(actor, 'incidents:edit');
    case 'approve':
      return can(actor, 'incidents:approve');
    // The one who closes validates the costs, so closing also needs to see them.
    case 'close':
      return can(actor, 'incidents:close') && can(actor, 'incidents:view_costs');
    case 'reopen':
      return can(actor, 'incidents:reopen');
  }
}

/** State commands the caller may run now: the permission and the state, not the requirements (that is `next-steps`). */
export function allowedCommands(
  incident: Incident,
  actor: IncidentActor,
): readonly IncidentCommand[] {
  return IMPLEMENTED_COMMANDS.filter(
    (command) => transitionAllowed(incident, command) && mayRun(actor, incident, command),
  );
}
