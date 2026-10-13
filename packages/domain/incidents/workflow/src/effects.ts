import type { Incident, IncidentActor, IncidentCommand } from '../../cases/src/index.js';
import { TRANSITIONS } from './commands.js';

export interface EffectContext {
  readonly time: string;
  readonly actor: IncidentActor;
  /** `user-<subject>` of the responsible `assign` names. */
  readonly responsibleId: string | null;
  readonly reason: string | null;
}

/** The columns a command writes besides `version` and the audit stamp; the state comes from the table. */
export function effectOf(
  command: IncidentCommand,
  incident: Incident,
  context: EffectContext,
): Partial<Incident> {
  const status = TRANSITIONS[command].to ?? incident.status;
  switch (command) {
    case 'report':
      return { status, reportedAt: context.time, reportedBy: context.actor.id };
    case 'assign':
      return { responsibleId: context.responsibleId };
    case 'insure':
      return { status, insurerResult: incident.insurerResult ?? 'pending' };
    case 'reject':
      // A new rejection asks for a new appeal note.
      return { status, insurerResult: 'rejected', appealNote: null };
    case 'appeal':
      // An appeal reopens the question: the earlier assumption no longer stands (US-033).
      return { status, insurerResult: 'pending', assumptionApproval: null };
    case 'approve_assumption':
      return { assumptionApproval: { by: context.actor.id, at: context.time } };
    case 'approve_close':
      return { closeApproval: { by: context.actor.id, at: context.time } };
    case 'resolve':
      return { status, resolvedAt: context.time };
    case 'close':
      return { status, closedAt: context.time, closedBy: context.actor.id };
    case 'reopen':
      // A new cycle starts: both approvals covered what the supervisor saw before, and the
      // closing stamp belongs to the cycle that ended (its snapshot keeps it).
      return {
        status,
        cycle: incident.cycle + 1,
        reopenCount: incident.reopenCount + 1,
        assumptionApproval: null,
        closeApproval: null,
        closedAt: null,
        closedBy: null,
      };
    case 'cancel':
      return { status, cancelReason: context.reason };
    default:
      return { status };
  }
}

/** Names of the columns that really change, for the timeline (names only, never values). */
export function changedFieldsOf(incident: Incident, changes: Partial<Incident>): readonly string[] {
  return Object.entries(changes)
    .filter(
      ([name, value]) =>
        JSON.stringify((incident as unknown as Record<string, unknown>)[name]) !==
        JSON.stringify(value),
    )
    .map(([name]) => name)
    .sort();
}
