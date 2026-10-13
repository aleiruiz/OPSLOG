import { IncidentError } from './errors.js';
import { resolveCoverage } from './coverage.js';
import type { EventChanges } from './input.js';
import type { IncidentReferences } from './ports.js';
import { assertEventTime } from './rules.js';
import type { Incident } from './types.js';

export async function requireDriver(
  refs: IncidentReferences,
  tenantId: string,
  driverId: unknown,
): Promise<void> {
  if (typeof driverId === 'string' && !(await refs.driver(tenantId, driverId)))
    throw new IncidentError('not_found');
}

/** Applies the changes to the case: references (404), event rules (422) and coverage. */
export async function mergeChanges(
  refs: IncidentReferences,
  now: Date,
  tenantId: string,
  incident: Incident,
  changes: EventChanges,
  changed: readonly string[],
): Promise<{ incident: Incident; changed: readonly string[] }> {
  const touches = (...fields: string[]) => fields.some((field) => changed.includes(field));
  const fields = Object.fromEntries(
    Object.entries(changes).filter(([name]) => name !== 'policyId'),
  );
  const draft: Incident = { ...incident, ...(fields as Partial<Incident>) };
  // A driver and the reason for having none exclude each other: the one set last wins.
  const merged: Incident =
    typeof changes.driverId === 'string'
      ? { ...draft, noDriverReason: changes.noDriverReason ?? null }
      : typeof changes.noDriverReason === 'string'
        ? { ...draft, driverId: changes.driverId ?? null }
        : draft;
  if (touches('driverId')) await requireDriver(refs, tenantId, changes.driverId);
  const fieldsChanged = new Set(changed);
  if (merged.driverId !== incident.driverId) fieldsChanged.add('driverId');
  if (merged.noDriverReason !== incident.noDriverReason) fieldsChanged.add('noDriverReason');
  if (!touches('vehicleId', 'occurredAt', 'policyId'))
    return { incident: merged, changed: [...fieldsChanged] };
  // An unchanged vehicle may have been archived since the case was opened; a new one must be live.
  const vehicle = await refs.vehicle(tenantId, merged.vehicleId, {
    includeArchived: merged.vehicleId === incident.vehicleId,
  });
  if (!vehicle) throw new IncidentError('not_found');
  const zone = await refs.timeZone(tenantId);
  const occurredOn = merged.occurredAt
    ? assertEventTime(merged.occurredAt, vehicle.registeredOn, now, zone)
    : null;
  const coverage = resolveCoverage({
    day: occurredOn,
    revisions: await refs.policyRevisions(tenantId, vehicle.id),
    chosenPolicyId: changes.policyId,
    previous: incident.policySnapshot,
  });
  if (
    coverage.status !== incident.coverageStatus ||
    JSON.stringify(coverage.snapshot) !== JSON.stringify(incident.policySnapshot)
  )
    fieldsChanged.add('coverage');
  return {
    incident: {
      ...merged,
      areaId: touches('vehicleId') ? vehicle.areaId : merged.areaId,
      occurredOn,
      coverageStatus: coverage.status,
      policySnapshot: coverage.snapshot,
    },
    changed: [...fieldsChanged],
  };
}
