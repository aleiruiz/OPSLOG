/** Kinds of third party involved in a case (BRD §17.2). */
export const THIRD_PARTY_KINDS = ['person', 'vehicle', 'property'] as const;
export type ThirdPartyKind = (typeof THIRD_PARTY_KINDS)[number];

/** Categories and stages of the evidence of a case (BRD §17.2). */
export const EVIDENCE_CATEGORIES = [
  'photo',
  'police_report',
  'driver_statement',
  'sketch',
  'budget',
  'invoice',
  'rejection_letter',
  'other',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];
export const EVIDENCE_STAGES = ['on_site', 'workshop', 'post_repair', 'other'] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

/** Longest value of each text field. The protected ones also fit a `pii1.` envelope column. */
export const THIRD_PARTY_LIMITS = {
  name: 120,
  contact: 200,
  plates: 20,
  policyNumber: 60,
  insurerName: 200,
  damageDescription: 2000,
} as const;
export const FILE_NAME_LIMIT = 200;
export const CONTENT_TYPE_LIMIT = 100;

/** Most active third parties and linked files one case keeps. */
export const MAX_THIRD_PARTIES = 20;
export const MAX_EVIDENCE = 50;

/** Largest upload the routes decode; the files module then applies its own limit by type (SPECS §7). */
export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

export const CHILD_RULES = {
  thirdPartyLimit: 'third_party_limit_reached',
  evidenceLimit: 'evidence_limit_reached',
} as const;

/** Fields of a third party that identify a person or a vehicle: sealed at rest, shown with `view_pii`. */
export const PROTECTED_FIELDS = ['name', 'contact', 'plates', 'policyNumber'] as const;
export type ProtectedField = (typeof PROTECTED_FIELDS)[number];
