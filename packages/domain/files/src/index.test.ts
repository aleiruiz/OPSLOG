import { describe, expect, it } from 'vitest';
import {
  FileError,
  InMemoryFileRecordStore,
  applyScanOutcome,
  assertDownloadable,
  contentDispositionFor,
  detectFamily,
  newUploadIntentRecord,
  newPendingRecord,
  requireOpaqueId,
  sanitizeFilename,
  validateUpload,
  type FileRecord,
} from './index.js';

const jpeg = (extra = 8): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(extra).fill(1)]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const webp = Uint8Array.from(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'));
const pdf = Uint8Array.from(Buffer.from('%PDF-1.7 synthetic', 'latin1'));
const zip = (parts: string): Uint8Array =>
  Uint8Array.from(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(parts)]));
const docx = zip('[Content_Types].xml word/document.xml');
const xlsx = zip('[Content_Types].xml xl/workbook.xml');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : 'other';
  }
  return undefined;
};

const pending = (over: Partial<Parameters<typeof newPendingRecord>[0]> = {}): FileRecord =>
  newPendingRecord({
    id: 'file-1',
    tenantId: 'tenant-a',
    kind: 'original',
    sensitivity: 'standard',
    upload: validateUpload({ name: 'a.jpg', declaredType: 'image/jpeg', bytes: jpeg() }),
    createdBy: 'user-x',
    now: new Date('2026-10-06T00:00:00Z'),
    ...over,
  });

describe('content-based type detection', () => {
  it('recognises each supported family from signatures', () => {
    expect([jpeg(), png, webp, pdf, docx, xlsx].map(detectFamily)).toEqual([
      'jpeg',
      'png',
      'webp',
      'pdf',
      'docx',
      'xlsx',
    ]);
  });
  it('returns null for unknown bytes, plain zip without office parts and short input', () => {
    expect(detectFamily(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(detectFamily(zip('readme.txt'))).toBeNull();
    expect(detectFamily(zip('[Content_Types].xml other/'))).toBeNull();
    expect(detectFamily(Uint8Array.from(Buffer.from('RIFF....WAVE')))).toBeNull();
  });
});

describe('upload validation', () => {
  it('accepts matching content and declared type and reports size and hash', () => {
    const result = validateUpload({
      name: 'Report.PDF',
      declaredType: 'application/pdf',
      bytes: pdf,
    });
    expect(result.contentType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(pdf.length);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.displayName).toBe('Report.pdf');
    expect(validateUpload({ name: 'x', declaredType: DOCX, bytes: docx }).displayName).toBe(
      'x.docx',
    );
    expect(validateUpload({ name: 'x', declaredType: XLSX, bytes: xlsx }).displayName).toBe(
      'x.xlsx',
    );
  });
  it('rejects content that does not match the declared type', () => {
    expect(
      code(() => validateUpload({ name: 'a.jpg', declaredType: 'image/jpeg', bytes: pdf })),
    ).toBe('type_mismatch');
    expect(code(() => validateUpload({ name: 'a.docx', declaredType: DOCX, bytes: xlsx }))).toBe(
      'type_mismatch',
    );
  });
  it('rejects unsupported declared types including zip, video and prototype keys', () => {
    for (const type of ['application/zip', 'video/mp4', 'image/heic', 'toString', '']) {
      expect(code(() => validateUpload({ name: 'a', declaredType: type, bytes: pdf }))).toBe(
        'unsupported_type',
      );
    }
    expect(code(() => validateUpload({ name: 'a', declaredType: 5 as never, bytes: pdf }))).toBe(
      'unsupported_type',
    );
  });
  it('rejects empty and non-byte input', () => {
    expect(
      code(() =>
        validateUpload({ name: 'a', declaredType: 'application/pdf', bytes: new Uint8Array() }),
      ),
    ).toBe('invalid_input');
    expect(
      code(() =>
        validateUpload({ name: 'a', declaredType: 'application/pdf', bytes: 'x' as never }),
      ),
    ).toBe('invalid_input');
  });
  it('enforces 15 MB for images and 25 MB for documents', () => {
    const bigImage = new Uint8Array(15 * 1024 * 1024 + 1);
    bigImage.set([0xff, 0xd8, 0xff]);
    expect(
      code(() => validateUpload({ name: 'a', declaredType: 'image/jpeg', bytes: bigImage })),
    ).toBe('too_large');
    const okDoc = new Uint8Array(20 * 1024 * 1024);
    okDoc.set(Buffer.from('%PDF-'));
    expect(
      validateUpload({ name: 'a', declaredType: 'application/pdf', bytes: okDoc }).sizeBytes,
    ).toBe(okDoc.length);
    const bigDoc = new Uint8Array(25 * 1024 * 1024 + 1);
    bigDoc.set(Buffer.from('%PDF-'));
    expect(
      code(() => validateUpload({ name: 'a', declaredType: 'application/pdf', bytes: bigDoc })),
    ).toBe('too_large');
  });
});

describe('file names and headers', () => {
  it('strips paths, control characters, quotes and forces the verified extension', () => {
    expect(sanitizeFilename('..\\..\\etc/passwd.exe', 'application/pdf')).toBe('passwd.pdf');
    expect(sanitizeFilename('a"b;c\r\nd.png', 'image/png')).toBe('a_b_c__d.png');
    expect(sanitizeFilename('   ', 'image/webp')).toBe('file.webp');
    expect(sanitizeFilename(undefined, 'image/jpeg')).toBe('file.jpg');
    expect(sanitizeFilename('.hidden', 'image/jpeg')).toBe('hidden.jpg');
    expect(sanitizeFilename('a\u202egpj.exe\u200b\u2066b\u2069', 'application/pdf')).toBe(
      'agpj.exeb.pdf',
    );
    for (const reserved of ['CON', 'nul.txt', 'com1', 'LPT9.tar'])
      expect(sanitizeFilename(reserved, 'application/pdf').startsWith('_')).toBe(true);
    expect(sanitizeFilename('console', 'application/pdf')).toBe('console.pdf');
    expect(sanitizeFilename('x'.repeat(300), 'image/jpeg')).toHaveLength(84);
  });
  it('builds an attachment disposition with ASCII fallback and encoded name', () => {
    const header = contentDispositionFor('Informe ñ"x.pdf');
    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header).toContain('filename="Informe __x.pdf"');
    expect(header).toContain("filename*=UTF-8''Informe%20%C3%B1%22x.pdf");
    expect(contentDispositionFor("a'(b)*.pdf")).toContain('a%27%28b%29%2A.pdf');
  });
});

describe('records and lifecycle', () => {
  it('starts every new file in pending_scan and rejects malformed identifiers', () => {
    expect(pending().status).toBe('pending_scan');
    expect(code(() => pending({ id: '../x' }))).toBe('invalid_input');
    expect(code(() => pending({ tenantId: 'a/b' }))).toBe('invalid_input');
    expect(code(() => requireOpaqueId(5))).toBe('invalid_input');
    expect(code(() => pending({ originalId: 'file-0' }))).toBe('invalid_input');
    expect(code(() => pending({ kind: 'derivative' }))).toBe('invalid_input');
    expect(
      code(() => pending({ kind: 'derivative', originalId: 'a.b', width: 5, height: 5 })),
    ).toBe('invalid_input');
  });
  it('keeps a durable upload intent unavailable until quarantine storage is verified', () => {
    const intent = newUploadIntentRecord({
      id: 'file-pending',
      tenantId: 'tenant-a',
      kind: 'original',
      sensitivity: 'standard',
      upload: validateUpload({ name: 'a.jpg', declaredType: 'image/jpeg', bytes: jpeg() }),
      createdBy: 'user-x',
      now: new Date('2026-10-06T00:00:00Z'),
    });
    expect(intent.status).toBe('pending_upload');
    expect(
      code(() =>
        assertDownloadable({
          record: intent,
          original: null,
          tenantId: 'tenant-a',
          granted: ['view'],
        }),
      ),
    ).toBe('not_available');
  });
  it('keeps derivative dimensions within 2000 px per side', () => {
    const base = { kind: 'derivative', originalId: 'file-0' } as const;
    const ok = pending({ ...base, width: 2000, height: 1500 });
    expect([ok.width, ok.height, ok.originalId]).toEqual([2000, 1500, 'file-0']);
    expect(code(() => pending({ ...base, width: 2001, height: 10 }))).toBe('invalid_input');
    expect(code(() => pending({ ...base, width: 10, height: 0 }))).toBe('invalid_input');
    expect(code(() => pending({ ...base, width: 10.5, height: 10 }))).toBe('invalid_input');
    expect(code(() => pending({ ...base, height: 10 }))).toBe('invalid_input');
  });
  it('moves pending_scan to clean or rejected exactly once', () => {
    const at = new Date('2026-10-06T01:00:00Z');
    const clean = applyScanOutcome(pending(), { result: 'clean' }, at);
    expect([clean.status, clean.scannedAt]).toEqual(['clean', at.toISOString()]);
    const rejected = applyScanOutcome(pending(), { result: 'rejected', reason: 'malware' }, at);
    expect([rejected.status, rejected.rejectionReason]).toEqual(['rejected', 'malware']);
    expect(code(() => applyScanOutcome(clean, { result: 'clean' }, at))).toBe('conflict');
    expect(code(() => applyScanOutcome(rejected, { result: 'clean' }, at))).toBe('conflict');
  });
});

describe('download rule', () => {
  const clean = applyScanOutcome(pending(), { result: 'clean' }, new Date());
  const view = ['view'] as const;
  it('serves only clean records of the caller tenant with view permission', () => {
    expect(
      assertDownloadable({ record: clean, original: null, tenantId: 'tenant-a', granted: view }),
    ).toBe(clean);
    const attempt = (over: Partial<Parameters<typeof assertDownloadable>[0]>) =>
      code(() =>
        assertDownloadable({
          record: clean,
          original: null,
          tenantId: 'tenant-a',
          granted: view,
          ...over,
        }),
      );
    expect(attempt({ record: null })).toBe('not_found');
    expect(attempt({ tenantId: 'tenant-b' })).toBe('not_found');
    expect(attempt({ granted: [] })).toBe('forbidden');
    expect(attempt({ record: pending() })).toBe('not_available');
    const rejected = applyScanOutcome(
      pending(),
      { result: 'rejected', reason: 'malware' },
      new Date(),
    );
    expect(attempt({ record: rejected })).toBe('not_available');
  });
  it('requires view_pii for pii files before revealing their status', () => {
    const pii = { ...clean, sensitivity: 'pii' } as FileRecord;
    const args = { original: null, tenantId: 'tenant-a' };
    expect(code(() => assertDownloadable({ ...args, record: pii, granted: view }))).toBe(
      'forbidden',
    );
    expect(
      code(() =>
        assertDownloadable({ ...args, record: { ...pii, status: 'pending_scan' }, granted: view }),
      ),
    ).toBe('forbidden');
    expect(assertDownloadable({ ...args, record: pii, granted: ['view', 'view_pii'] })).toBe(pii);
  });
  it('serves a derivative only while a clean original of the same tenant backs it', () => {
    const derivative = {
      ...clean,
      id: 'file-d',
      kind: 'derivative',
      originalId: 'file-1',
    } as FileRecord;
    const args = { record: derivative, tenantId: 'tenant-a', granted: view };
    expect(assertDownloadable({ ...args, original: clean })).toBe(derivative);
    const bad = (original: FileRecord | null) =>
      code(() => assertDownloadable({ ...args, original }));
    expect(bad(null)).toBe('not_available');
    expect(bad(pending())).toBe('not_available');
    expect(bad({ ...clean, tenantId: 'tenant-b' })).toBe('not_available');
    expect(bad({ ...clean, id: 'other' })).toBe('not_available');
    expect(bad({ ...clean, kind: 'derivative' })).toBe('not_available');
  });
});

describe('in-memory record store', () => {
  it('isolates tenants that reuse the same local file id', async () => {
    const store = new InMemoryFileRecordStore();
    await store.insert(pending({ tenantId: 'tenant-a' }));
    await store.insert(pending({ tenantId: 'tenant-b' }));
    expect((await store.get('tenant-a', 'file-1'))?.tenantId).toBe('tenant-a');
    expect((await store.get('tenant-b', 'file-1'))?.tenantId).toBe('tenant-b');
    expect(await store.get('tenant-c', 'file-1')).toBeNull();
    await expect(store.insert(pending({ tenantId: 'tenant-a' }))).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('applies compare-and-set on status and returns copies', async () => {
    const store = new InMemoryFileRecordStore();
    const record = pending();
    await store.insert(record);
    const next = applyScanOutcome(record, { result: 'clean' }, new Date());
    expect(await store.replaceIfStatus('clean', next)).toBe(false);
    expect(await store.replaceIfStatus('pending_scan', next)).toBe(true);
    expect(await store.replaceIfStatus('pending_scan', next)).toBe(false);
    expect(await store.replaceIfStatus('pending_scan', pending({ id: 'missing' }))).toBe(false);
    const copy = await store.get('tenant-a', 'file-1');
    expect(copy?.status).toBe('clean');
    (copy as { status: string }).status = 'pending_scan';
    expect((await store.get('tenant-a', 'file-1'))?.status).toBe('clean');
  });
});
