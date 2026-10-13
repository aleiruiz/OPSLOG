import type { BffDamageZone, BffIncident, BffIncidentInput } from '@opslog/contracts';
import { fromLocalInput, toLocalInput } from './time';

/**
 * What a person typed in the event form and has not sent yet, by field. A field that was never touched is
 * absent, so a save sends only what changed and a reload after a conflict keeps exactly these edits on top of
 * the fresh case.
 */
export interface EventEdits {
  type?: string;
  vehicleId?: string;
  /** Value of the `datetime-local` input, as wall time in the company's zone. */
  occurredAt?: string;
  location?: string;
  description?: string;
  severity?: string;
  /** `''` unknown, `yes` or `no`. */
  operable?: string;
  zones?: readonly BffDamageZone[];
  damageDescription?: string;
  driverId?: string;
  noDriverReason?: string;
  noPhotoJustification?: string;
  policyId?: string;
}
export type EventKey = keyof EventEdits;

/** The fields of a draft or of a change, without `version` (the caller adds it). */
export type EventFields = Partial<Omit<BffIncidentInput, 'vehicleId' | 'type'>> & {
  vehicleId?: string;
  type?: BffIncidentInput['type'];
};

const text = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

/** The value a field shows: the person's edit if there is one, else what the case holds. */
export function shown(
  edits: EventEdits,
  incident: BffIncident | null,
  zone: string,
): Required<Omit<EventEdits, 'zones'>> & { zones: readonly BffDamageZone[] } {
  return {
    type: edits.type ?? incident?.type ?? '',
    vehicleId: edits.vehicleId ?? incident?.vehicle.id ?? '',
    occurredAt: edits.occurredAt ?? toLocalInput(incident?.occurredAt ?? null, zone),
    location: edits.location ?? incident?.location?.text ?? '',
    description: edits.description ?? incident?.description ?? '',
    severity: edits.severity ?? incident?.severity ?? '',
    operable:
      edits.operable ??
      (incident?.vehicleOperable === true
        ? 'yes'
        : incident?.vehicleOperable === false
          ? 'no'
          : ''),
    zones: edits.zones ?? incident?.damage.zones ?? [],
    damageDescription: edits.damageDescription ?? incident?.damage.description ?? '',
    driverId: edits.driverId ?? incident?.driver?.employeeId ?? '',
    noDriverReason: edits.noDriverReason ?? incident?.noDriverReason ?? '',
    noPhotoJustification: edits.noPhotoJustification ?? incident?.noPhotoJustification ?? '',
    policyId: edits.policyId ?? incident?.coverage.policy?.policyId ?? '',
  };
}

export const hasEdits = (edits: EventEdits): boolean => Object.keys(edits).length > 0;

/**
 * The request body for the edits: only changed fields; a cleared text field becomes `null`. `damage` is the one
 * field the API replaces whole, so editing the zones or the damage text sends both together (the values shown).
 */
export function fieldsFromEdits(
  edits: EventEdits,
  incident: BffIncident | null,
  zone: string,
): EventFields {
  const view = shown(edits, incident, zone);
  const out: Record<string, unknown> = {};
  if (edits.type !== undefined) out['type'] = edits.type;
  if (edits.vehicleId !== undefined) out['vehicleId'] = edits.vehicleId;
  if (edits.occurredAt !== undefined) out['occurredAt'] = fromLocalInput(edits.occurredAt, zone);
  if (edits.location !== undefined) {
    const place = text(edits.location);
    out['location'] = place === null ? null : { text: place };
  }
  if (edits.description !== undefined) out['description'] = text(edits.description);
  if (edits.severity !== undefined) out['severity'] = edits.severity === '' ? null : edits.severity;
  if (edits.operable !== undefined)
    out['vehicleOperable'] = edits.operable === '' ? null : edits.operable === 'yes';
  if (edits.zones !== undefined || edits.damageDescription !== undefined)
    out['damage'] = { description: text(view.damageDescription), zones: view.zones };
  if (edits.driverId !== undefined) out['driverId'] = edits.driverId === '' ? null : edits.driverId;
  if (edits.noDriverReason !== undefined) out['noDriverReason'] = text(edits.noDriverReason);
  if (edits.noPhotoJustification !== undefined)
    out['noPhotoJustification'] = text(edits.noPhotoJustification);
  if (edits.policyId !== undefined) out['policyId'] = edits.policyId === '' ? null : edits.policyId;
  return out as EventFields;
}
