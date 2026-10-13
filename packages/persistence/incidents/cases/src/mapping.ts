import type {
  DamageZone,
  IdempotencyClaim,
  IdempotencyRecord,
  Incident,
  IncidentTransition,
  NewIncidentTransition,
  PolicySnapshot,
  TimelineBefore,
} from '../../../../domain/incidents/cases/src/index.js';
import type {
  IncidentEntity,
  IncidentIdempotencyEntity,
  IncidentTransitionEntity,
} from './entities.js';

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const date = (value: string | null) => (value ? new Date(value) : null);
/** mysql2 parses JSON columns; the guard keeps a driver that returns text working. */
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
/** TINYINT(1) comes back as 0/1 on some drivers. */
const bool = (value: boolean | number | null) => (value === null ? null : Boolean(value));
const approval = (by: string | null, at: Date | null) =>
  by !== null && at !== null ? { by, at: at.toISOString() } : null;

export function incidentRow(incident: Incident): IncidentEntity {
  return {
    tenantId: incident.tenantId,
    id: incident.id,
    folio: incident.folio,
    status: incident.status,
    version: incident.version,
    cycle: incident.cycle,
    reopenCount: incident.reopenCount,
    type: incident.type,
    severity: incident.severity,
    vehicleId: incident.vehicleId,
    areaId: incident.areaId,
    driverId: incident.driverId,
    noDriverReason: incident.noDriverReason,
    occurredAt: date(incident.occurredAt),
    occurredOn: incident.occurredOn,
    locationText: incident.location?.text ?? null,
    locationLatitude: incident.location?.latitude?.toFixed(6) ?? null,
    locationLongitude: incident.location?.longitude?.toFixed(6) ?? null,
    description: incident.description,
    vehicleOperable: incident.vehicleOperable,
    damageDescription: incident.damage.description,
    damageZones: [...incident.damage.zones],
    noPhotoJustification: incident.noPhotoJustification,
    coverageStatus: incident.coverageStatus,
    policySnapshot: incident.policySnapshot ? { ...incident.policySnapshot } : null,
    reportedAt: date(incident.reportedAt),
    reportedBy: incident.reportedBy,
    responsibleId: incident.responsibleId,
    insurerName: incident.insurerName,
    claimNumber: incident.claimNumber,
    adjusterName: incident.adjusterName,
    adjusterContact: incident.adjusterContact,
    insurerReportedOn: incident.insurerReportedOn,
    insurerResult: incident.insurerResult,
    rejectionReason: incident.rejectionReason,
    appealNote: incident.appealNote,
    noInsuranceReason: incident.noInsuranceReason,
    costAssumed: incident.costAssumed,
    resolutionSummary: incident.resolutionSummary,
    totalLoss: incident.totalLoss,
    vehicleStatusDecision: incident.vehicleStatusDecision,
    resolvedAt: date(incident.resolvedAt),
    assumptionApprovedBy: incident.assumptionApproval?.by ?? null,
    assumptionApprovedAt: date(incident.assumptionApproval?.at ?? null),
    closeApprovedBy: incident.closeApproval?.by ?? null,
    closeApprovedAt: date(incident.closeApproval?.at ?? null),
    closedAt: date(incident.closedAt),
    closedBy: incident.closedBy,
    cancelReason: incident.cancelReason,
    createdAt: new Date(incident.createdAt),
    createdBy: incident.createdBy,
    updatedAt: new Date(incident.updatedAt),
    updatedBy: incident.updatedBy,
  };
}

export function incidentFrom(row: IncidentEntity): Incident {
  return {
    id: row.id,
    tenantId: row.tenantId,
    folio: row.folio,
    status: row.status as Incident['status'],
    version: row.version,
    cycle: row.cycle,
    reopenCount: row.reopenCount,
    type: row.type as Incident['type'],
    severity: row.severity as Incident['severity'],
    vehicleId: row.vehicleId,
    areaId: row.areaId,
    driverId: row.driverId,
    noDriverReason: row.noDriverReason,
    occurredAt: iso(row.occurredAt),
    occurredOn: row.occurredOn,
    location:
      row.locationText === null
        ? null
        : {
            text: row.locationText,
            latitude: row.locationLatitude === null ? null : Number(row.locationLatitude),
            longitude: row.locationLongitude === null ? null : Number(row.locationLongitude),
          },
    description: row.description,
    vehicleOperable: bool(row.vehicleOperable),
    damage: {
      description: row.damageDescription,
      zones: json<DamageZone[]>(row.damageZones),
    },
    noPhotoJustification: row.noPhotoJustification,
    coverageStatus: row.coverageStatus as Incident['coverageStatus'],
    policySnapshot: row.policySnapshot === null ? null : json<PolicySnapshot>(row.policySnapshot),
    reportedAt: iso(row.reportedAt),
    reportedBy: row.reportedBy,
    responsibleId: row.responsibleId,
    insurerName: row.insurerName,
    claimNumber: row.claimNumber,
    adjusterName: row.adjusterName,
    adjusterContact: row.adjusterContact,
    insurerReportedOn: row.insurerReportedOn,
    insurerResult: row.insurerResult as Incident['insurerResult'],
    rejectionReason: row.rejectionReason,
    appealNote: row.appealNote,
    noInsuranceReason: row.noInsuranceReason,
    costAssumed: bool(row.costAssumed),
    resolutionSummary: row.resolutionSummary,
    totalLoss: bool(row.totalLoss),
    vehicleStatusDecision: row.vehicleStatusDecision,
    resolvedAt: iso(row.resolvedAt),
    assumptionApproval: approval(row.assumptionApprovedBy, row.assumptionApprovedAt),
    closeApproval: approval(row.closeApprovedBy, row.closeApprovedAt),
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function transitionRow(
  tenantId: string,
  incidentId: string,
  sequence: number,
  entry: NewIncidentTransition,
): IncidentTransitionEntity {
  return {
    tenantId,
    incidentId,
    sequence,
    command: entry.command,
    fromStatus: entry.from,
    toStatus: entry.to,
    actorId: entry.actorId,
    comment: entry.comment,
    occurredAt: new Date(entry.occurredAt),
    changedFields: [...entry.changedFields],
    before: entry.before ? { ...entry.before } : null,
  };
}

export function transitionFrom(row: IncidentTransitionEntity): IncidentTransition {
  return {
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    sequence: row.sequence,
    command: row.command,
    from: row.fromStatus as IncidentTransition['from'],
    to: row.toStatus as IncidentTransition['to'],
    actorId: row.actorId,
    comment: row.comment,
    occurredAt: row.occurredAt.toISOString(),
    changedFields: json<string[]>(row.changedFields),
    before: row.before === null ? null : json<TimelineBefore>(row.before),
  };
}

export function idempotencyRow(
  tenantId: string,
  claim: IdempotencyClaim,
  response: Incident,
): IncidentIdempotencyEntity {
  return {
    tenantId,
    actorId: claim.actorId,
    command: claim.command,
    key: claim.key,
    incidentId: claim.incidentId,
    payloadHash: claim.payloadHash,
    status: 'completed',
    response,
    createdAt: new Date(claim.createdAt),
    expiresAt: new Date(claim.expiresAt),
  };
}

export function idempotencyFrom(row: IncidentIdempotencyEntity): IdempotencyRecord {
  return {
    tenantId: row.tenantId,
    actorId: row.actorId,
    command: row.command,
    key: row.key,
    incidentId: row.incidentId,
    payloadHash: row.payloadHash,
    status: 'completed',
    response: json<Incident>(row.response),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
