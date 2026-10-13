import type { ISODateTime, UUID } from './index.js';
import { H, i, keys, r, t, type ContractValidationError } from './validation-support.js';

export type AllowedFileType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type FileCategory =
  | 'identity'
  | 'vehicle'
  | 'insurance'
  | 'incident_evidence'
  | 'maintenance';
export interface FileMetadata {
  originalName: string;
  category: FileCategory;
  contentType: AllowedFileType;
  sizeBytes: number;
  sha256: string;
  issuedAt?: ISODateTime;
  expiresAt?: ISODateTime;
  version: number;
}
export interface UploadIntent {
  entityType: string;
  entityId: UUID;
  metadata: FileMetadata;
}
export interface SignedFileUrl {
  url: string;
  expiresAt: ISODateTime;
}
const fileMax: Record<FileCategory, number> = {
  identity: 10 * 1024 * 1024,
  vehicle: 15 * 1024 * 1024,
  insurance: 25 * 1024 * 1024,
  incident_evidence: 25 * 1024 * 1024,
  maintenance: 25 * 1024 * 1024,
};
const fileTypes: readonly AllowedFileType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const FILE_SIZE_LIMITS = { ...fileMax } as const;
export function validateFileMetadata(v: unknown): ContractValidationError[] {
  if (!r(v)) return [{ path: '', code: 'invalid_type', message: 'Expected object' }];
  const e: ContractValidationError[] = [];
  keys(
    v,
    [
      'originalName',
      'category',
      'contentType',
      'sizeBytes',
      'sha256',
      'issuedAt',
      'expiresAt',
      'version',
    ],
    e,
  );
  if (!t(v.originalName))
    e.push({ path: 'originalName', code: 'required', message: 'originalName required' });
  if (typeof v.category !== 'string' || !(v.category in fileMax))
    e.push({ path: 'category', code: 'invalid_category', message: 'category is not supported' });
  if (!fileTypes.includes(v.contentType as AllowedFileType))
    e.push({
      path: 'contentType',
      code: 'invalid_content_type',
      message: 'contentType is not allowed',
    });
  if (!Number.isInteger(v.sizeBytes) || (v.sizeBytes as number) <= 0)
    e.push({ path: 'sizeBytes', code: 'invalid_size', message: 'sizeBytes positive' });
  else if (
    typeof v.category === 'string' &&
    v.category in fileMax &&
    (v.sizeBytes as number) > fileMax[v.category as FileCategory]
  )
    e.push({ path: 'sizeBytes', code: 'limit_exceeded', message: 'size exceeds category limit' });
  if (!H.test(String(v.sha256 ?? '')))
    e.push({ path: 'sha256', code: 'invalid_sha256', message: 'sha256 must be 64 hex chars' });
  if (!Number.isInteger(v.version) || (v.version as number) < 1)
    e.push({ path: 'version', code: 'invalid_version', message: 'version positive' });
  for (const field of ['issuedAt', 'expiresAt'] as const)
    if (v[field] !== undefined && !i(v[field]))
      e.push({ path: field, code: 'invalid_datetime', message: `${field} must be UTC ISO-8601` });
  if (
    v.issuedAt &&
    v.expiresAt &&
    i(v.issuedAt) &&
    i(v.expiresAt) &&
    Date.parse(v.expiresAt) <= Date.parse(v.issuedAt)
  )
    e.push({
      path: 'expiresAt',
      code: 'invalid_range',
      message: 'expiresAt must be after issuedAt',
    });
  return e;
}
