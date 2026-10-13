import { canEdit, type IncidentActor } from './access.js';
import { editableFields, vehicleProposal, type VehicleProposal } from './rules.js';
import type { WritableKey } from './input.js';
import type { Incident, IncidentTransition } from './types.js';

export type IncidentView = Omit<Incident, 'tenantId'> & {
  readonly vehicleProposal: VehicleProposal | null;
  /** Fields this caller may write now (empty when they cannot edit the case). */
  readonly editableFields: readonly WritableKey[];
};
export type IncidentTransitionView = Omit<IncidentTransition, 'tenantId' | 'incidentId'>;

const without = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !(keys as readonly string[]).includes(key)),
  ) as Omit<T, K>;

export function incidentView(incident: Incident, actor: IncidentActor): IncidentView {
  return {
    ...without(incident, ['tenantId']),
    vehicleProposal: vehicleProposal(incident),
    editableFields: canEdit(actor, incident) ? editableFields(incident.status) : [],
  };
}

export function transitionView(transition: IncidentTransition): IncidentTransitionView {
  return without(transition, ['tenantId', 'incidentId']);
}
