import { createHash } from 'node:crypto';

/** pending_upload and pending_scan are private; only clean records are released (SPECS §5/§7). */
export type FileStatus = 'pending_upload' | 'pending_scan' | 'clean' | 'rejected';
export type FileKind = 'original' | 'derivative';
export type Sensitivity = 'standard' | 'pii';
export type RejectionReason = 'malware' | 'integrity';

export type FileErrorCode =
  | 'invalid_input'
  | 'unsupported_type'
  | 'type_mismatch'
  | 'too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_available'
  | 'conflict'
  | 'integrity_failed'
  | 'storage_unavailable';

export class FileError extends Error {
  public constructor(public readonly code: FileErrorCode) {
    super(`File request rejected: ${code}`);
    this.name = 'FileError';
  }
}

const MB = 1024 * 1024;
export const MAX_DERIVATIVE_EDGE_PX = 2000;
export const FILE_TYPES = {
  'image/jpeg': { extension: 'jpg', maxBytes: 15 * MB, family: 'jpeg' },
  'image/png': { extension: 'png', maxBytes: 15 * MB, family: 'png' },
  'image/webp': { extension: 'webp', maxBytes: 15 * MB, family: 'webp' },
  'application/pdf': { extension: 'pdf', maxBytes: 25 * MB, family: 'pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extension: 'docx',
    maxBytes: 25 * MB,
    family: 'docx',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extension: 'xlsx',
    maxBytes: 25 * MB,
    family: 'xlsx',
  },
} as const;
export type AllowedContentType = keyof typeof FILE_TYPES;
type Family = (typeof FILE_TYPES)[AllowedContentType]['family'];

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Identifiers that become storage key segments cannot contain separators, dots or colons. */
export function requireOpaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw new FileError('invalid_input');
  return value;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const containsText = (bytes: Uint8Array, text: string): boolean =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(text, 0, 'latin1');

/**
 * Detects the type from content, never from the name or declared type. ZIP-based Office files
 * are matched by the ZIP signature plus part names; deeper OOXML validation belongs to the scanner.
 */
export function detectFamily(bytes: Uint8Array): Family | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && containsText(bytes, '[Content_Types].xml')) {
    if (containsText(bytes, 'word/')) return 'docx';
    if (containsText(bytes, 'xl/')) return 'xlsx';
  }
  return null;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export interface ValidatedUpload {
  readonly contentType: AllowedContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly displayName: string;
}

const isAllowedType = (value: string): value is AllowedContentType =>
  Object.prototype.hasOwnProperty.call(FILE_TYPES, value);

/** Validates type by content, size by category and sanitizes the display name. */
export function validateUpload(input: {
  readonly name: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
}): ValidatedUpload {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0)
    throw new FileError('invalid_input');
  if (typeof input.declaredType !== 'string' || !isAllowedType(input.declaredType))
    throw new FileError('unsupported_type');
  const rule = FILE_TYPES[input.declaredType];
  if (input.bytes.length > rule.maxBytes) throw new FileError('too_large');
  if (detectFamily(input.bytes) !== rule.family) throw new FileError('type_mismatch');
  return {
    contentType: input.declaredType,
    sizeBytes: input.bytes.length,
    sha256: sha256Hex(input.bytes),
    displayName: sanitizeFilename(input.name, input.declaredType),
  };
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Removes paths, control characters, quotes and leading dots; forces the extension of the verified type. */
export function sanitizeFilename(name: unknown, contentType: AllowedContentType): string {
  const extension = FILE_TYPES[contentType].extension;
  const raw = typeof name === 'string' ? name : '';
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f"';<>|:*?%&=+,`^{}[\]()!$#@~]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._]+|[\s._]+$/g, '')
    .slice(0, 80);
  const safeStem = WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem;
  return `${safeStem || 'file'}.${extension}`;
}

/** Originals are never rendered inline: always an attachment with an ASCII fallback and RFC 5987 name. */
export function contentDispositionFor(displayName: string): string {
  const ascii = displayName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(displayName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface FileRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: FileKind;
  readonly originalId?: string;
  readonly status: FileStatus;
  readonly sensitivity: Sensitivity;
  readonly contentType: AllowedContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly displayName: string;
  readonly width?: number;
  readonly height?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly scannedAt?: string;
  readonly rejectionReason?: RejectionReason;
}

export function newPendingRecord(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: FileKind;
  readonly originalId?: string;
  readonly sensitivity: Sensitivity;
  readonly upload: ValidatedUpload;
  readonly width?: number;
  readonly height?: number;
  readonly createdBy: string;
  readonly now: Date;
}): FileRecord {
  requireOpaqueId(input.id);
  requireOpaqueId(input.tenantId);
  if ((input.kind === 'derivative') !== (input.originalId !== undefined))
    throw new FileError('invalid_input');
  if (input.originalId !== undefined) requireOpaqueId(input.originalId);
  if (input.kind === 'derivative') {
    const { width, height } = input;
    const valid = (n: number | undefined): n is number =>
      n !== undefined && Number.isInteger(n) && n > 0 && n <= MAX_DERIVATIVE_EDGE_PX;
    if (!valid(width) || !valid(height)) throw new FileError('invalid_input');
  }
  return {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.kind,
    ...(input.originalId === undefined ? {} : { originalId: input.originalId }),
    status: 'pending_scan',
    sensitivity: input.sensitivity,
    contentType: input.upload.contentType,
    sizeBytes: input.upload.sizeBytes,
    sha256: input.upload.sha256,
    displayName: input.upload.displayName,
    ...(input.kind === 'derivative' && input.width !== undefined && input.height !== undefined
      ? { width: input.width, height: input.height }
      : {}),
    createdBy: input.createdBy,
    createdAt: input.now.toISOString(),
  };
}

/** A durable quarantine upload intent. It remains unavailable until the quarantine write is verified. */
export function newUploadIntentRecord(input: Parameters<typeof newPendingRecord>[0]): FileRecord {
  return { ...newPendingRecord(input), status: 'pending_upload' };
}

export type ScanOutcome =
  | { readonly result: 'clean' }
  | { readonly result: 'rejected'; readonly reason: RejectionReason };

/** The only status transition: pending_scan to clean or rejected. Terminal states never change. */
export function applyScanOutcome(record: FileRecord, outcome: ScanOutcome, now: Date): FileRecord {
  if (record.status !== 'pending_scan') throw new FileError('conflict');
  const base = { ...record, scannedAt: now.toISOString() };
  if (outcome.result === 'clean') return { ...base, status: 'clean' };
  return { ...base, status: 'rejected', rejectionReason: outcome.reason };
}

/**
 * Pure download rule. Order matters: other-tenant records look absent, then permissions,
 * then lifecycle. A derivative is served only while its original is also clean.
 */
export function assertDownloadable(input: {
  readonly record: FileRecord | null;
  readonly original: FileRecord | null;
  readonly tenantId: string;
  readonly granted: readonly string[];
}): FileRecord {
  const { record } = input;
  if (!record || record.tenantId !== input.tenantId) throw new FileError('not_found');
  if (!input.granted.includes('view')) throw new FileError('forbidden');
  if (record.sensitivity === 'pii' && !input.granted.includes('view_pii'))
    throw new FileError('forbidden');
  if (record.status !== 'clean') throw new FileError('not_available');
  if (record.kind === 'derivative') {
    const { original } = input;
    if (
      !original ||
      original.tenantId !== record.tenantId ||
      original.id !== record.originalId ||
      original.kind !== 'original' ||
      original.status !== 'clean'
    )
      throw new FileError('not_available');
  }
  return record;
}

export interface FileRecordStore {
  insert(record: FileRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<FileRecord | null>;
  /** Atomic compare-and-set on status; false when the record is no longer in the expected status. */
  replaceIfStatus(expected: FileStatus, next: FileRecord): Promise<boolean>;
}

const recordKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

export class InMemoryFileRecordStore implements FileRecordStore {
  private readonly records = new Map<string, FileRecord>();
  public async insert(record: FileRecord): Promise<void> {
    const key = recordKey(record.tenantId, record.id);
    if (this.records.has(key)) throw new FileError('conflict');
    this.records.set(key, structuredClone(record));
  }
  public async get(tenantId: string, id: string): Promise<FileRecord | null> {
    const found = this.records.get(recordKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }
  public async replaceIfStatus(expected: FileStatus, next: FileRecord): Promise<boolean> {
    const key = recordKey(next.tenantId, next.id);
    const current = this.records.get(key);
    if (current?.status !== expected) return false;
    this.records.set(key, structuredClone(next));
    return true;
  }
}
