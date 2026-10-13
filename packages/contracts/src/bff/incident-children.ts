import type { ISODateTime } from '../index.js';
import type { BffIncidentPerson } from './incidents.js';
import type { BffRouteDefinition } from './shared.js';

/** Kinds of third party involved in a case (BRD §17.2). */
export const BFF_THIRD_PARTY_KINDS = ['person', 'vehicle', 'property'] as const;
export type BffThirdPartyKind = (typeof BFF_THIRD_PARTY_KINDS)[number];
export const BFF_EVIDENCE_CATEGORIES = [
  'photo',
  'police_report',
  'driver_statement',
  'sketch',
  'budget',
  'invoice',
  'rejection_letter',
  'other',
] as const;
export type BffEvidenceCategory = (typeof BFF_EVIDENCE_CATEGORIES)[number];
export const BFF_EVIDENCE_STAGES = ['on_site', 'workshop', 'post_repair', 'other'] as const;
export type BffEvidenceStage = (typeof BFF_EVIDENCE_STAGES)[number];

/**
 * A third party. `name`, `contact`, `plates` and `policyNumber` are personal data (D23): they are
 * present, possibly `null`, only when `identityRestricted` is `false` (the caller holds `view_pii`);
 * otherwise they are absent.
 */
export interface BffThirdParty {
  readonly id: string;
  readonly kind: BffThirdPartyKind;
  readonly insurerName: string | null;
  readonly damageDescription: string | null;
  readonly injuries: boolean;
  readonly identityRestricted: boolean;
  readonly name?: string | null;
  readonly contact?: string | null;
  readonly plates?: string | null;
  readonly policyNumber?: string | null;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}
export interface BffThirdPartyList {
  readonly items: readonly BffThirdParty[];
  /** True when the caller lacks `view_pii`: the protected fields are absent from every item. */
  readonly identityRestricted: boolean;
}
/** `version` is the case version the caller read; the response carries the new one. */
export interface BffThirdPartyInput {
  readonly version: number;
  readonly kind: BffThirdPartyKind;
  readonly name?: string | null;
  readonly contact?: string | null;
  readonly plates?: string | null;
  readonly policyNumber?: string | null;
  readonly insurerName?: string | null;
  readonly damageDescription?: string | null;
  readonly injuries?: boolean;
}
/** At least one field besides `version`; `null` clears a text field. */
export interface BffThirdPartyPatch extends Partial<Omit<BffThirdPartyInput, 'version'>> {
  readonly version: number;
}
export interface BffIncidentVersion {
  /** The version of the case after the command: what the next command sends. */
  readonly version: number;
}
export interface BffThirdPartyChange extends BffIncidentVersion {
  readonly item: BffThirdParty;
}

/** `missing` when the files module no longer knows the file. */
export type BffEvidenceFileStatus =
  | 'pending_upload'
  | 'pending_scan'
  | 'clean'
  | 'rejected'
  | 'missing';
/** A file linked to a case. It never exposes the file id, the hash or the storage key. */
export interface BffIncidentEvidence {
  readonly id: string;
  readonly category: BffEvidenceCategory;
  readonly stage: BffEvidenceStage;
  readonly capturedAt: ISODateTime | null;
  /** Declared by the web when it compressed the photo before sending; informative, not proof. */
  readonly clientCompressed: boolean;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileStatus: BffEvidenceFileStatus;
  /** Only a `clean` file counts as saved evidence; one in quarantine or rejected never does. */
  readonly counts: boolean;
  readonly attachedBy: BffIncidentPerson;
  readonly attachedAt: ISODateTime;
}
export interface BffIncidentEvidenceChange extends BffIncidentVersion {
  readonly item: BffIncidentEvidence;
}
/**
 * Largest file the evidence routes decode. The files module then applies its limit by type
 * (SPECS §7): 15 MB for images, 25 MB for PDF, DOCX and XLSX. The JSON body carries it as base64.
 */
export const BFF_EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;
export const BFF_EVIDENCE_MAX_BODY_BYTES = Math.ceil((BFF_EVIDENCE_MAX_BYTES * 4) / 3) + 4096;
export interface BffIncidentEvidenceUpload {
  readonly version: number;
  readonly category: BffEvidenceCategory;
  readonly stage: BffEvidenceStage;
  readonly capturedAt?: ISODateTime | null;
  /** True when the web compressed the photo (about 2 MB) before upload; the file received is stored as is. */
  readonly clientCompressed?: boolean;
  readonly name: string;
  /** The declared type; the server verifies it against the content. */
  readonly contentType: string;
  readonly contentBase64: string;
}
export interface BffIncidentEvidenceContent {
  readonly displayName: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

/** Request and response types of the third party and evidence routes. */
export interface IncidentChildRouteTypes {
  'incidents.thirdParties.list': {
    params: { incidentId: string };
    response: BffThirdPartyList;
  };
  'incidents.thirdParties.create': {
    params: { incidentId: string };
    body: BffThirdPartyInput;
    /** Sent as the `Idempotency-Key` header. The same key and body replay the first result. */
    idempotencyKey?: string;
    response: BffThirdPartyChange;
  };
  'incidents.thirdParties.update': {
    params: { incidentId: string; partyId: string };
    body: BffThirdPartyPatch;
    response: BffThirdPartyChange;
  };
  'incidents.thirdParties.remove': {
    params: { incidentId: string; partyId: string };
    body: { readonly version: number };
    response: BffIncidentVersion;
  };
  'incidents.evidence.list': {
    params: { incidentId: string };
    response: { items: readonly BffIncidentEvidence[] };
  };
  'incidents.evidence.upload': {
    params: { incidentId: string };
    body: BffIncidentEvidenceUpload;
    /** Sent as the `Idempotency-Key` header. The same key and body replay the first result. */
    idempotencyKey?: string;
    response: BffIncidentEvidenceChange;
  };
  'incidents.evidence.detach': {
    params: { incidentId: string; evidenceId: string };
    body: { readonly version: number };
    response: BffIncidentVersion;
  };
  'incidents.evidence.content': {
    params: { incidentId: string; evidenceId: string };
    response: BffIncidentEvidenceContent;
  };
}

const incident = ['api', 'v1', 'incidents', ':incidentId'] as const;
export const INCIDENT_CHILD_ROUTES = {
  'incidents.thirdParties.list': {
    method: 'GET',
    path: [...incident, 'third-parties'],
    kind: 'session',
    status: 200,
  },
  'incidents.thirdParties.create': {
    method: 'POST',
    path: [...incident, 'third-parties'],
    kind: 'session-csrf',
    status: 201,
    idempotency: { requiredFor: [] },
  },
  'incidents.thirdParties.update': {
    method: 'PATCH',
    path: [...incident, 'third-parties', ':partyId'],
    kind: 'session-csrf',
    status: 200,
  },
  'incidents.thirdParties.remove': {
    method: 'POST',
    path: [...incident, 'third-parties', ':partyId', 'remove'],
    kind: 'session-csrf',
    status: 200,
  },
  'incidents.evidence.list': {
    method: 'GET',
    path: [...incident, 'evidence'],
    kind: 'session',
    status: 200,
  },
  'incidents.evidence.upload': {
    method: 'POST',
    path: [...incident, 'evidence'],
    kind: 'session-csrf',
    status: 201,
    maxBodyBytes: BFF_EVIDENCE_MAX_BODY_BYTES,
    idempotency: { requiredFor: [] },
  },
  'incidents.evidence.detach': {
    method: 'POST',
    path: [...incident, 'evidence', ':evidenceId', 'detach'],
    kind: 'session-csrf',
    status: 200,
  },
  'incidents.evidence.content': {
    method: 'GET',
    path: [...incident, 'evidence', ':evidenceId', 'content'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof IncidentChildRouteTypes, BffRouteDefinition>;
