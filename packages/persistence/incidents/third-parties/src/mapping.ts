import type {
  EvidenceRecord,
  ThirdPartyRecord,
} from '../../../../domain/incidents/third-parties/src/index.js';
import type { IncidentEvidenceEntity, IncidentThirdPartyEntity } from './entities.js';

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const date = (value: string | null) => (value ? new Date(value) : null);
/** TINYINT(1) comes back as 0/1 on some drivers. */
const bool = (value: boolean | number) => Boolean(value);

export function thirdPartyRow(party: ThirdPartyRecord): IncidentThirdPartyEntity {
  return {
    tenantId: party.tenantId,
    incidentId: party.incidentId,
    id: party.id,
    kind: party.kind,
    nameEnc: party.identity.name,
    contactEnc: party.identity.contact,
    platesEnc: party.identity.plates,
    policyNumberEnc: party.identity.policyNumber,
    insurerName: party.insurerName,
    damageDescription: party.damageDescription,
    injuries: party.injuries,
    removedAt: date(party.removedAt),
    createdAt: new Date(party.createdAt),
    createdBy: party.createdBy,
    updatedAt: new Date(party.updatedAt),
    updatedBy: party.updatedBy,
  };
}

export function thirdPartyFrom(row: IncidentThirdPartyEntity): ThirdPartyRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    kind: row.kind as ThirdPartyRecord['kind'],
    identity: {
      name: row.nameEnc,
      contact: row.contactEnc,
      plates: row.platesEnc,
      policyNumber: row.policyNumberEnc,
    },
    insurerName: row.insurerName,
    damageDescription: row.damageDescription,
    injuries: bool(row.injuries),
    removedAt: iso(row.removedAt),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function evidenceRow(evidence: EvidenceRecord): IncidentEvidenceEntity {
  return {
    tenantId: evidence.tenantId,
    incidentId: evidence.incidentId,
    id: evidence.id,
    fileId: evidence.fileId,
    category: evidence.category,
    stage: evidence.stage,
    capturedAt: date(evidence.capturedAt),
    clientCompressed: evidence.clientCompressed,
    displayName: evidence.displayName,
    contentType: evidence.contentType,
    sizeBytes: evidence.sizeBytes,
    attachedBy: evidence.attachedBy,
    attachedAt: new Date(evidence.attachedAt),
  };
}

export function evidenceFrom(row: IncidentEvidenceEntity): EvidenceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    incidentId: row.incidentId,
    fileId: row.fileId,
    category: row.category as EvidenceRecord['category'],
    stage: row.stage as EvidenceRecord['stage'],
    capturedAt: iso(row.capturedAt),
    clientCompressed: bool(row.clientCompressed),
    displayName: row.displayName,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    attachedBy: row.attachedBy,
    attachedAt: row.attachedAt.toISOString(),
  };
}
