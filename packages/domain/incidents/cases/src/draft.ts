import type { IncidentActor } from './access.js';
import type { Coverage } from './coverage.js';
import type { EventChanges } from './input.js';
import type { VehicleRef } from './ports.js';
import type { Incident, TimelineBefore } from './types.js';

export interface NewIncidentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly actor: IncidentActor;
  readonly time: string;
  readonly vehicle: VehicleRef;
  readonly changes: EventChanges;
  readonly occurredAt: string | null;
  readonly occurredOn: string | null;
  readonly coverage: Coverage;
}

/** A new draft: the event groups come from the request, every later package's group starts empty. */
export function newIncident(input: NewIncidentInput): Incident {
  const { id, tenantId, actor, time, vehicle, changes, occurredAt, occurredOn, coverage } = input;
  return {
    id,
    tenantId,
    folio: '',
    status: 'draft',
    version: 1,
    cycle: 1,
    reopenCount: 0,
    type: changes.type as Incident['type'],
    severity: changes.severity ?? null,
    vehicleId: vehicle.id,
    areaId: vehicle.areaId,
    driverId: changes.driverId ?? null,
    noDriverReason: changes.noDriverReason ?? null,
    occurredAt,
    occurredOn,
    location: changes.location ?? null,
    description: changes.description ?? null,
    vehicleOperable: changes.vehicleOperable ?? null,
    damage: changes.damage ?? { description: null, zones: [] },
    noPhotoJustification: changes.noPhotoJustification ?? null,
    coverageStatus: coverage.status,
    policySnapshot: coverage.snapshot,
    reportedAt: null,
    reportedBy: null,
    responsibleId: null,
    insurerName: null,
    claimNumber: null,
    adjusterName: null,
    adjusterContact: null,
    insurerReportedOn: null,
    insurerResult: null,
    rejectionReason: null,
    appealNote: null,
    noInsuranceReason: null,
    costAssumed: null,
    resolutionSummary: null,
    totalLoss: null,
    vehicleStatusDecision: null,
    resolvedAt: null,
    assumptionApproval: null,
    closeApproval: null,
    closedAt: null,
    closedBy: null,
    cancelReason: null,
    createdAt: time,
    createdBy: actor.id,
    updatedAt: time,
    updatedBy: actor.id,
  };
}

/** Facts of the case before a change that are structured: ids, enums, instants. Never text or amounts. */
export function beforeOf(incident: Incident): TimelineBefore {
  return {
    type: incident.type,
    severity: incident.severity,
    vehicleId: incident.vehicleId,
    driverId: incident.driverId,
    occurredAt: incident.occurredAt,
    vehicleOperable: incident.vehicleOperable,
    coverageStatus: incident.coverageStatus,
    policyId: incident.policySnapshot?.policyId ?? null,
    policyRevision: incident.policySnapshot?.revision ?? null,
  };
}

export const currentValue = (incident: Incident, field: string): unknown =>
  field === 'policyId'
    ? (incident.policySnapshot?.policyId ?? null)
    : (incident as unknown as Record<string, unknown>)[field];
