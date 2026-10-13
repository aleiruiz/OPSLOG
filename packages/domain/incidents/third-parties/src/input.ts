import {
  Issues,
  enumField,
  idField,
  instantField,
  objectOf,
  present,
  textField,
  versionField,
} from '../../cases/src/validation.js';
import {
  CONTENT_TYPE_LIMIT,
  EVIDENCE_CATEGORIES,
  EVIDENCE_STAGES,
  FILE_NAME_LIMIT,
  PROTECTED_FIELDS,
  THIRD_PARTY_KINDS,
  THIRD_PARTY_LIMITS,
  type EvidenceCategory,
  type EvidenceStage,
  type ProtectedField,
  type ThirdPartyKind,
} from './catalog.js';

type Plain = { -readonly [K in ProtectedField]?: string | null };
/** The fields a request sets; absent means unchanged, `null` clears a nullable field. */
export interface ThirdPartyChanges extends Plain {
  kind?: ThirdPartyKind;
  insurerName?: string | null;
  damageDescription?: string | null;
  injuries?: boolean;
}

const TEXT_FIELDS = [...PROTECTED_FIELDS, 'insurerName', 'damageDescription'] as const;
const KEYS = ['version', 'kind', ...TEXT_FIELDS, 'injuries'] as const;

function fields(data: Record<string, unknown>, issues: Issues): ThirdPartyChanges {
  const out: Record<string, unknown> = {};
  if (present(data, 'kind')) {
    const kind = enumField(issues, 'kind', data['kind'], THIRD_PARTY_KINDS);
    if (kind !== undefined) out['kind'] = kind;
  }
  for (const field of TEXT_FIELDS) {
    if (!present(data, field)) continue;
    const text = textField(issues, field, data[field], THIRD_PARTY_LIMITS[field]);
    if (text !== undefined) out[field] = text;
  }
  if (present(data, 'injuries')) {
    if (typeof data['injuries'] === 'boolean') out['injuries'] = data['injuries'];
    else issues.add('injuries', 'invalid');
  }
  return out as ThirdPartyChanges;
}

export function parseThirdPartyCreate(input: unknown): {
  version: number;
  changes: ThirdPartyChanges;
} {
  const issues = new Issues();
  const data = objectOf(input, KEYS, issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  if (!present(data, 'kind')) issues.add('kind', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const changes = fields(data, issues);
  issues.throwIfAny();
  return { version: version as number, changes };
}

export function parseThirdPartyPatch(input: unknown): {
  version: number;
  changes: ThirdPartyChanges;
} {
  const issues = new Issues();
  const data = objectOf(input, KEYS, issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const changes = fields(data, issues);
  if (Object.keys(changes).length === 0 && !issues.any) issues.add('body', 'required');
  issues.throwIfAny();
  return { version: version as number, changes };
}

/** Commands that only carry the version they were read at (remove, detach). */
export function parseVersionOnly(input: unknown): number {
  const issues = new Issues();
  const data = objectOf(input, ['version'], issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  issues.throwIfAny();
  return version as number;
}

export interface EvidenceMeta {
  readonly category: EvidenceCategory;
  readonly stage: EvidenceStage;
  readonly capturedAt: string | null;
  readonly clientCompressed: boolean;
}
export interface EvidenceUploadInput extends EvidenceMeta {
  readonly version: number;
  readonly name: string;
  readonly contentType: string;
}
export interface EvidenceAttachInput extends EvidenceMeta {
  readonly version: number;
  readonly fileId: string;
}

function meta(data: Record<string, unknown>, issues: Issues): EvidenceMeta {
  if (!present(data, 'category')) issues.add('category', 'required');
  if (!present(data, 'stage')) issues.add('stage', 'required');
  const category = present(data, 'category')
    ? enumField(issues, 'category', data['category'], EVIDENCE_CATEGORIES)
    : undefined;
  const stage = present(data, 'stage')
    ? enumField(issues, 'stage', data['stage'], EVIDENCE_STAGES)
    : undefined;
  const capturedAt = present(data, 'capturedAt')
    ? instantField(issues, 'capturedAt', data['capturedAt'])
    : null;
  let clientCompressed = false;
  if (present(data, 'clientCompressed')) {
    if (typeof data['clientCompressed'] === 'boolean') clientCompressed = data['clientCompressed'];
    else issues.add('clientCompressed', 'invalid');
  }
  return {
    category: category as EvidenceCategory,
    stage: stage as EvidenceStage,
    capturedAt: capturedAt ?? null,
    clientCompressed,
  };
}

export function parseEvidenceUpload(input: unknown): EvidenceUploadInput {
  const issues = new Issues();
  const data = objectOf(
    input,
    ['version', 'category', 'stage', 'capturedAt', 'clientCompressed', 'name', 'contentType'],
    issues,
  );
  for (const key of ['version', 'name', 'contentType'] as const)
    if (!present(data, key)) issues.add(key, 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const name = present(data, 'name')
    ? textField(issues, 'name', data['name'], FILE_NAME_LIMIT, false)
    : undefined;
  const contentType = present(data, 'contentType')
    ? textField(issues, 'contentType', data['contentType'], CONTENT_TYPE_LIMIT, false)
    : undefined;
  const common = meta(data, issues);
  issues.throwIfAny();
  return {
    ...common,
    version: version as number,
    name: name as string,
    contentType: contentType as string,
  };
}

export function parseEvidenceAttach(input: unknown): EvidenceAttachInput {
  const issues = new Issues();
  const data = objectOf(
    input,
    ['version', 'fileId', 'category', 'stage', 'capturedAt', 'clientCompressed'],
    issues,
  );
  for (const key of ['version', 'fileId'] as const)
    if (!present(data, key)) issues.add(key, 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const fileId = present(data, 'fileId') ? idField(issues, 'fileId', data['fileId']) : undefined;
  const common = meta(data, issues);
  issues.throwIfAny();
  return { ...common, version: version as number, fileId: fileId as string };
}
