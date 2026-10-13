import { TERMINAL_STATUSES, type IncidentStatus } from './catalog.js';
import { IncidentError, RULES } from './errors.js';
import { dayInZone } from './folio.js';
import { WRITABLE_KEYS, type WritableKey } from './input.js';
import type { Incident } from './types.js';

const LIMITED: readonly WritableKey[] = ['severity', 'description', 'damage', 'location'];
const NOT_VEHICLE = WRITABLE_KEYS.filter((key) => key !== 'vehicleId');

/** Fields a status lets a caller write (SPECS §6.2): the edit matrix of the package. */
export function editableFields(status: IncidentStatus): readonly WritableKey[] {
  if (TERMINAL_STATUSES.includes(status)) return [];
  if (status === 'draft') return WRITABLE_KEYS;
  if (status === 'reported' || status === 'under_review' || status === 'reopened')
    return NOT_VEHICLE;
  return LIMITED;
}

/** Closed and cancelled cases accept no write of any package (SPECS §6.2): the shared state guard (409). */
export function assertNotTerminal(status: IncidentStatus): void {
  if (TERMINAL_STATUSES.includes(status)) throw new IncidentError('invalid_transition');
}

/** A write outside the matrix is a state conflict (409), not a bad input. */
export function assertEditable(status: IncidentStatus, keys: readonly string[]): void {
  assertNotTerminal(status);
  const allowed = editableFields(status);
  if (keys.some((key) => !(allowed as readonly string[]).includes(key)))
    throw new IncidentError('invalid_transition');
}

/** BR-I4 / BR-018: no future event, none before the vehicle was registered (tenant calendar day). */
export function assertEventTime(
  occurredAt: string,
  registeredOn: string,
  now: Date,
  timeZone: string,
): string {
  const instant = new Date(occurredAt);
  if (instant.getTime() > now.getTime())
    throw new IncidentError('rule_violation', [], RULES.occurredAtInFuture);
  const day = dayInZone(instant, timeZone);
  if (day < registeredOn)
    throw new IncidentError('rule_violation', [], RULES.occurredBeforeRegistration);
  return day;
}

/** Shown while the vehicle cannot operate; the incident never changes the vehicle by itself (D11). */
export interface VehicleProposal {
  readonly suggestedStatus: 'out_of_service';
  readonly reason: string;
}
export function vehicleProposal(incident: Incident): VehicleProposal | null {
  return incident.vehicleOperable === false && !TERMINAL_STATUSES.includes(incident.status)
    ? { suggestedStatus: 'out_of_service', reason: `Siniestro ${incident.folio}` }
    : null;
}
