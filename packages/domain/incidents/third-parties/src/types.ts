import type { IncidentApplyResult, IncidentMutation } from '../../cases/src/index.js';
import type { EvidenceCategory, EvidenceStage, ProtectedField, ThirdPartyKind } from './catalog.js';

/** The protected fields of a third party as stored: `pii1.` envelopes, never plaintext. */
export type SealedIdentity = Readonly<Record<ProtectedField, string | null>>;

export interface ThirdPartyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly kind: ThirdPartyKind;
  readonly identity: SealedIdentity;
  readonly insurerName: string | null;
  readonly damageDescription: string | null;
  readonly injuries: boolean;
  /** Soft delete (the row stays for the record of the case). */
  readonly removedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** The link between a case and a file of the files module. No bytes, hash or storage key live here. */
export interface EvidenceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly fileId: string;
  readonly category: EvidenceCategory;
  readonly stage: EvidenceStage;
  readonly capturedAt: string | null;
  /** Declared by the web when it compressed the photo before sending it; informative, not proof. */
  readonly clientCompressed: boolean;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly attachedBy: string;
  readonly attachedAt: string;
}

/** The child write that goes with an incident mutation, in the same transaction. */
export type ChildChange =
  | { readonly kind: 'third_party_add'; readonly party: ThirdPartyRecord }
  /** Replaces the row of an active third party; setting `removedAt` is the soft delete. */
  | { readonly kind: 'third_party_update'; readonly party: ThirdPartyRecord }
  | { readonly kind: 'evidence_attach'; readonly evidence: EvidenceRecord }
  | {
      readonly kind: 'evidence_detach';
      readonly tenantId: string;
      readonly incidentId: string;
      readonly evidenceId: string;
    };

export interface IncidentChildStore {
  /** Active third parties, or all of them (removed ones included) when asked. */
  thirdParties(
    tenantId: string,
    incidentId: string,
    options?: { readonly includeRemoved?: boolean },
  ): Promise<readonly ThirdPartyRecord[]>;
  evidence(tenantId: string, incidentId: string): Promise<readonly EvidenceRecord[]>;
  /** The link of a file in the tenant, whichever case holds it; null when it is not linked. */
  evidenceOfFile(tenantId: string, fileId: string): Promise<EvidenceRecord | null>;
  /**
   * Writes the incident mutation (version CAS, timeline, audit, outbox) and the child change in one
   * transaction. `applied: false` on a stale version, a taken idempotency key or a file already
   * linked in the tenant; nothing is written then.
   */
  apply(mutation: IncidentMutation, change: ChildChange): Promise<IncidentApplyResult>;
}

export type FileLifecycle = 'pending_upload' | 'pending_scan' | 'clean' | 'rejected';
/** What this module needs to know of a file: only a `clean` one counts as saved evidence. */
export interface FileRecordRef {
  readonly id: string;
  readonly status: FileLifecycle;
  readonly kind: 'original' | 'derivative';
  readonly sensitivity: 'standard' | 'pii';
  readonly createdBy: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** The files module as the case uses it. */
export interface IncidentFiles {
  /** The record of a file of the tenant; null when unknown or foreign. */
  record(tenantId: string, fileId: string): Promise<FileRecordRef | null>;
  /**
   * Stores the received bytes untouched as an original (quarantine, scan and SHA-256 are the files
   * module's) and answers the new file. Throws `IncidentError('invalid_input')` for a rejected upload.
   */
  ingest(
    tenantId: string,
    actorId: string,
    correlationId: string,
    input: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array },
  ): Promise<{ readonly id: string }>;
}
