import type { EvidenceCategory, EvidenceStage, ProtectedField, ThirdPartyKind } from './catalog.js';
import type { EvidenceRecord, FileLifecycle } from './types.js';

/**
 * A third party as a caller sees it. Without `view_pii` the protected fields are absent (not
 * empty) and `identityRestricted` is true.
 */
export type ThirdPartyView = {
  readonly id: string;
  readonly kind: ThirdPartyKind;
  readonly insurerName: string | null;
  readonly damageDescription: string | null;
  readonly injuries: boolean;
  readonly identityRestricted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
} & Partial<Record<ProtectedField, string | null>>;

/** `missing` when the files module no longer knows the file. */
export type EvidenceFileStatus = FileLifecycle | 'missing';

export interface EvidenceView {
  readonly id: string;
  readonly category: EvidenceCategory;
  readonly stage: EvidenceStage;
  readonly capturedAt: string | null;
  readonly clientCompressed: boolean;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileStatus: EvidenceFileStatus;
  /** Only a `clean` file counts as saved evidence; a file in quarantine or a rejected one never does. */
  readonly counts: boolean;
  /** `user-<uuid>`. */
  readonly attachedBy: string;
  readonly attachedAt: string;
}

export const countsAsEvidence = (status: EvidenceFileStatus): boolean => status === 'clean';

export function evidenceView(record: EvidenceRecord, status: EvidenceFileStatus): EvidenceView {
  return {
    id: record.id,
    category: record.category,
    stage: record.stage,
    capturedAt: record.capturedAt,
    clientCompressed: record.clientCompressed,
    displayName: record.displayName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    fileStatus: status,
    counts: countsAsEvidence(status),
    attachedBy: record.attachedBy,
    attachedAt: record.attachedAt,
  };
}
