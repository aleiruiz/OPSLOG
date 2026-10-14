import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import type {
  EvidenceCategory,
  EvidenceFileStatus,
  EvidenceService,
  EvidenceStage,
  ThirdPartyService,
  ThirdPartyView,
} from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import type { PersonRef, SessionDeps } from '../../cases/src/index.js';

export type { PersonRef, ThirdPartyView };

export interface IncidentChildApiDeps extends SessionDeps {
  readonly thirdParties: ThirdPartyService;
  readonly evidence: EvidenceService;
  readonly labels: {
    /** `actorId` is `user-<subject>`. */
    member(tenantId: string, actorId: string): Promise<string>;
  };
  /** Reads a released file for the caller's session; failures arrive as `IncidentError`. */
  readonly files: {
    readonly read: (token: string, correlationId: string, fileId: string) => Promise<Uint8Array>;
  };
  /**
   * Records a download in the audit trail: the entity is the evidence link (`<incident id>.<evidence id>`,
   * ids only, no name or content). Not best effort: without the record, no bytes.
   */
  readonly audit: (
    context: TenantContext,
    action: string,
    entityId: string,
    correlationId: string,
    entityType?: string,
  ) => Promise<void>;
}

export interface ThirdPartyListView {
  readonly items: readonly ThirdPartyView[];
  /** True when the caller lacks `view_pii`: the protected fields are absent from every item. */
  readonly identityRestricted: boolean;
}
/** The result of a command: the new `version` of the case and what the command made. */
export interface ThirdPartyChangeView {
  readonly version: number;
  readonly item: ThirdPartyView;
}
export interface IncidentVersionView {
  readonly version: number;
}

/** A linked file as the browser knows it: never the file id, the storage key or the hash. */
export interface EvidenceItemView {
  readonly id: string;
  readonly category: EvidenceCategory;
  readonly stage: EvidenceStage;
  readonly capturedAt: string | null;
  readonly clientCompressed: boolean;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileStatus: EvidenceFileStatus;
  readonly counts: boolean;
  readonly attachedBy: PersonRef;
  readonly attachedAt: string;
}
export interface EvidenceChangeView {
  readonly version: number;
  readonly item: EvidenceItemView;
}
export interface EvidenceContentView {
  readonly displayName: string;
  readonly contentType: string;
  readonly contentBase64: string;
}
