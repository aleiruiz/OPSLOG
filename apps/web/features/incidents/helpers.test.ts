import { describe, expect, it, vi } from 'vitest';
import { exifCaptureTime } from './exif';
import { describeError, isStale } from './errors';
import { fieldsFromEdits, hasEdits, shown } from './eventEdits';
import { baseIncident, completeEvent } from './fakePorts';
import { changedFieldsText, requirementLabel, timelineTitle } from './labels';
import {
  REASON_COMMANDS,
  approvalPending,
  approvalsToOffer,
  canEditInsurance,
  canEditResolution,
  canWrite,
  isFinished,
  mayApprove,
  mayStartIncident,
  mayViewIncidents,
  missingLines,
  stepViews,
} from './model';
import { asTab, draftPath, incidentPath } from './paths';
import {
  COMPRESS_TARGET_BYTES,
  captureTime,
  isPhoto,
  limitFor,
  prepareFile,
  toBase64,
} from './prepareFile';
import { SubmitKeys, sendKeyed } from './submit';
import { daysSince, formatDateTime, formatDay, fromLocalInput, toLocalInput } from './time';

const error = (status: number, code: string, extra = {}) => ({
  status: status as 400,
  code,
  message: 'x',
  correlationId: 'c',
  ...extra,
});

describe('time in the company zone', () => {
  it('formats, round-trips and survives unknown zones', () => {
    expect(formatDateTime('2026-10-12T15:30:00.000Z', 'America/Mexico_City')).toBe(
      '12/10/2026 09:30',
    );
    expect(formatDateTime('2026-10-12T15:30:00.000Z', 'No/Such')).toBe('12/10/2026 15:30');
    expect(formatDateTime(null, 'UTC')).toBe('Sin fecha');
    expect(formatDateTime('nope', 'UTC')).toBe('Sin fecha');
    expect(formatDay('2026-10-12')).toBe('12/10/2026');
    expect(formatDay(null)).toBe('Sin fecha');
    const local = toLocalInput('2026-10-12T15:30:00.000Z', 'America/Mexico_City');
    expect(local).toBe('2026-10-12T09:30');
    expect(fromLocalInput(local, 'America/Mexico_City')).toBe('2026-10-12T15:30:00.000Z');
    expect(toLocalInput(null, 'UTC')).toBe('');
    expect(fromLocalInput('', 'UTC')).toBeNull();
    expect(fromLocalInput('2026-13-45T99:99', 'UTC')).toBeNull();
    expect(daysSince('2026-10-10T00:00:00Z', Date.parse('2026-10-13T12:00:00Z'))).toBe(3);
    expect(daysSince('garbage')).toBe(0);
    expect(daysSince('2999-01-01T00:00:00Z')).toBe(0);
  });
});

describe('errors', () => {
  it('describes failures without echoing payloads', () => {
    expect(describeError(error(500, 'network_error'))).toMatch(/conexión/);
    expect(
      describeError(error(400, 'bad_request', { fieldErrors: [{ field: 'description' }] })),
    ).toMatch(/descripción/);
    expect(describeError(error(400, 'bad_request'))).toMatch(/Revisa los datos/);
    expect(describeError(error(403, 'forbidden'))).toMatch(/permiso/);
    expect(describeError(error(404, 'not_found'))).toMatch(/No encontramos/);
    expect(describeError(error(409, 'stale_version'))).toMatch(/Recarga/);
    expect(describeError(error(409, 'idempotency_conflict'))).toMatch(/otros datos/);
    expect(describeError(error(409, 'duplicate'))).toMatch(/ya existe/);
    expect(describeError(error(409, 'invalid_transition'))).toMatch(/estado actual/);
    expect(
      describeError(
        error(422, 'rule_violation', { fieldErrors: [{ field: 'occurred_at_in_future' }] }),
      ),
    ).toMatch(/futuras/);
    expect(describeError(error(422, 'invalid_responsible'))).toMatch(/responsable/);
    expect(describeError(error(422, 'missing_requirements'))).toMatch(/requisitos/);
    expect(describeError(error(422, 'rule_violation'))).toMatch(/regla/);
    expect(describeError(error(500, 'boom'), 'reportar')).toBe(
      'No pudimos reportar. Intenta nuevamente.',
    );
    expect(isStale(error(409, 'stale_version'))).toBe(true);
    expect(isStale(error(409, 'other'))).toBe(false);
  });
});

describe('labels', () => {
  it('names requirements, events and fields in Spanish and never as ids', () => {
    expect(requirementLabel('photo_or_justification')).toMatch(/foto/);
    expect(requirementLabel('unheard_of')).toBe('Falta un requisito del flujo.');
    const entry = (command: string, to: 'reported' | 'draft') => ({
      sequence: 1,
      command,
      from: null,
      to,
      actor: { id: 'u', displayName: 'Ana' },
      comment: null,
      occurredAt: '2026-10-12T15:30:00.000Z',
      changedFields: [],
      before: null,
    });
    expect(timelineTitle(entry('update', 'draft'))).toBe('Datos del caso actualizados');
    expect(timelineTitle(entry('report', 'reported'))).toBe('Reportar → Reportado');
    expect(timelineTitle(entry('mystery', 'reported'))).toBe('Reportado');
    expect(changedFieldsText(['description', 'zzz'])).toBe('Cambió: descripción.');
    expect(changedFieldsText(['zzz'])).toBeNull();
  });
});

describe('model', () => {
  it('reads permissions only from the incident grants', () => {
    expect(mayViewIncidents(['view', 'create', 'edit'])).toBe(false);
    expect(mayViewIncidents(['incidents:view'])).toBe(true);
    expect(mayStartIncident(['create'])).toBe(false);
    expect(mayStartIncident(['incidents:report'])).toBe(true);
    expect(mayStartIncident(['incidents:create'])).toBe(true);
    expect(mayApprove(['approve'])).toBe(false);
    expect(mayApprove(['incidents:approve'])).toBe(true);
  });

  it('knows where insurance and resolution are editable and what is finished', () => {
    const open = baseIncident({ status: 'under_review', editableFields: ['description'] });
    const readOnly = baseIncident({ status: 'under_review', editableFields: [] });
    expect(canWrite(open)).toBe(true);
    expect(canEditInsurance(open)).toBe(true);
    expect(canEditResolution(open)).toBe(true);
    expect(canEditInsurance(readOnly)).toBe(false);
    expect(
      canEditInsurance(baseIncident({ status: 'repair', editableFields: ['description'] })),
    ).toBe(false);
    expect(isFinished(baseIncident({ status: 'closed' }))).toBe(true);
    expect(isFinished(baseIncident({ status: 'cancelled' }))).toBe(true);
    expect(isFinished(open)).toBe(false);
    expect(REASON_COMMANDS).toContain('reopen');
  });

  it('turns next steps into plain lines and decides which approval to offer', () => {
    const views = stepViews([
      { command: 'close', missingRequirements: ['close_approval', 'resolution_summary'] },
      { command: 'approve_close', missingRequirements: [] },
    ]);
    expect(missingLines(views)).toEqual([
      'Cerrar caso: Falta la aprobación de cierre de una persona supervisora.',
      'Cerrar caso: Escribe el resumen de la resolución.',
    ]);
    expect(approvalPending(views)).toBe(true);
    const incident = baseIncident({ status: 'resolved' });
    expect(approvalsToOffer(incident, views)).toEqual(['close']);
    // An approver who cannot see `close` is offered the approval while none exists.
    expect(
      approvalsToOffer(
        incident,
        stepViews([{ command: 'approve_close', missingRequirements: [] }]),
      ),
    ).toEqual(['close']);
    const approved = baseIncident({
      status: 'resolved',
      resolution: {
        ...incident.resolution,
        closeApproval: {
          by: { id: 'u', displayName: 'A' },
          at: '2026-10-12T15:30:00.000Z',
        },
      },
    });
    expect(approvalsToOffer(approved, views)).toEqual([]);
    const assumption = stepViews([
      { command: 'repair', missingRequirements: ['assumption_approval'] },
      { command: 'approve_assumption', missingRequirements: [] },
    ]);
    expect(approvalsToOffer(baseIncident({ status: 'no_insurance' }), assumption)).toEqual([
      'assumption',
    ]);
    expect(
      approvalsToOffer(
        baseIncident({ status: 'no_insurance' }),
        stepViews([
          { command: 'repair', missingRequirements: [] },
          { command: 'approve_assumption', missingRequirements: [] },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('paths and draft edits', () => {
  it('builds addresses and falls back to the summary tab', () => {
    expect(incidentPath('a b', 'evidence')).toBe('/incidents/a%20b/evidence');
    expect(incidentPath('x')).toBe('/incidents/x');
    expect(draftPath('x', 2)).toBe('/incidents/new?borrador=x&paso=2');
    expect(asTab('timeline')).toBe('timeline');
    expect(asTab('rare')).toBe('summary');
    expect(asTab(undefined)).toBe('summary');
  });

  it('sends only what changed, whole damage, and nulls for cleared text', () => {
    const incident = completeEvent();
    expect(hasEdits({})).toBe(false);
    expect(shown({}, null, 'UTC').type).toBe('');
    expect(shown({}, incident, 'UTC').description).toBe('Golpe lateral al cambiar de carril.');
    expect(
      fieldsFromEdits(
        {
          type: 'rollover',
          vehicleId: 'veh-9',
          occurredAt: '2026-10-12T09:30',
          location: ' ',
          description: 'Nuevo',
          severity: '',
          operable: 'no',
          zones: ['front'],
          driverId: '',
          noDriverReason: 'Sin chofer',
          noPhotoJustification: '',
          policyId: 'pol-1',
        },
        incident,
        'America/Mexico_City',
      ),
    ).toEqual({
      type: 'rollover',
      vehicleId: 'veh-9',
      occurredAt: '2026-10-12T15:30:00.000Z',
      location: null,
      description: 'Nuevo',
      severity: null,
      vehicleOperable: false,
      damage: { description: null, zones: ['front'] },
      driverId: null,
      noDriverReason: 'Sin chofer',
      noPhotoJustification: null,
      policyId: 'pol-1',
    });
    expect(fieldsFromEdits({ operable: '' }, incident, 'UTC')).toEqual({ vehicleOperable: null });
    expect(
      fieldsFromEdits({ operable: 'yes', driverId: 'e-1', location: 'Av 1' }, null, 'UTC'),
    ).toEqual({ vehicleOperable: true, driverId: 'e-1', location: { text: 'Av 1' } });
    expect(fieldsFromEdits({}, incident, 'UTC')).toEqual({});
  });
});

describe('idempotent sending', () => {
  it('reuses the key after a network cut and settles on success', async () => {
    const keys = new SubmitKeys();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: error(500, 'network_error') })
      .mockResolvedValueOnce({ ok: true, value: 1 });
    const result = await sendKeyed(keys, { a: 1 }, send);
    expect(result).toEqual({ ok: true, value: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(send.mock.calls[1]?.[0]);
    const next = vi.fn().mockResolvedValue({ ok: true, value: 2 });
    await sendKeyed(keys, { a: 1 }, next);
    expect(next.mock.calls[0]?.[0]).not.toBe(send.mock.calls[0]?.[0]);
  });
});

function jpegWithExif(date: string, little = true): Uint8Array {
  const text = `${date}\0`;
  const enc = (n: number, size: 2 | 4) => {
    const out = new Uint8Array(size);
    new DataView(out.buffer)[size === 2 ? 'setUint16' : 'setUint32'](0, n, little);
    return out;
  };
  // TIFF: header(8) | IFD0: 1 entry -> ExifIFD pointer | Exif IFD: 1 entry DateTimeOriginal
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;
  const textAt = exifAt + 2 + 12 + 4;
  const parts: number[] = [];
  const push = (...chunks: Uint8Array[]) => chunks.forEach((c) => parts.push(...c));
  push(Uint8Array.from([little ? 0x49 : 0x4d, little ? 0x49 : 0x4d]), enc(42, 2), enc(ifd0At, 4));
  push(enc(1, 2), enc(0x8769, 2), enc(4, 2), enc(1, 4), enc(exifAt, 4), enc(0, 4));
  push(enc(1, 2), enc(0x9003, 2), enc(2, 2), enc(text.length, 4), enc(textAt, 4), enc(0, 4));
  push(Uint8Array.from([...text].map((c) => c.charCodeAt(0))));
  const tiff = Uint8Array.from(parts);
  const body = Uint8Array.from([...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), ...tiff]);
  const size = body.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    size >> 8,
    size & 255,
    ...body,
    0xff,
    0xd9,
    0,
    0,
    0,
    0,
  ]);
}

describe('exif', () => {
  it('reads the capture time of a JPEG in either byte order', () => {
    for (const little of [true, false]) {
      const iso = exifCaptureTime(jpegWithExif('2026:10:12 09:30:00', little));
      expect(iso).toBe(new Date(2026, 9, 12, 9, 30, 0).toISOString());
    }
  });
  it('returns null for anything else', () => {
    expect(exifCaptureTime(new Uint8Array(4))).toBeNull();
    expect(
      exifCaptureTime(Uint8Array.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    expect(
      exifCaptureTime(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    const noDate = jpegWithExif('2026:10:12 09:30:00');
    noDate[noDate.length - 30] = 0;
    expect(exifCaptureTime(noDate.subarray(0, 40))).toBeNull();
  });
});

describe('prepareFile', () => {
  const photo = (size: number, type = 'image/jpeg', name = 'golpe.jpeg') =>
    new File([new Uint8Array(size)], name, {
      type,
      lastModified: Date.parse('2026-10-12T10:00:00Z'),
    });

  it('compresses an 8 MB photo to about 2 MB and declares it', async () => {
    const compress = vi.fn(
      async (_file: Blob, target: number) => new Blob([new Uint8Array(target - 10)]),
    );
    const prepared = await prepareFile(photo(8 * 1024 * 1024), compress);
    expect(compress).toHaveBeenCalledWith(expect.anything(), COMPRESS_TARGET_BYTES);
    expect(prepared).toMatchObject({
      clientCompressed: true,
      contentType: 'image/jpeg',
      name: 'golpe.jpg',
      capturedAt: '2026-10-12T10:00:00.000Z',
    });
    expect(prepared.blob.size).toBeLessThanOrEqual(COMPRESS_TARGET_BYTES);
  });
  it('sends a PDF and a small photo unchanged', async () => {
    const compress = vi.fn();
    const pdf = new File([new Uint8Array(5_000_000)], 'carta.pdf', { type: 'application/pdf' });
    expect(await prepareFile(pdf, compress)).toMatchObject({
      blob: pdf,
      clientCompressed: false,
      contentType: 'application/pdf',
    });
    const small = photo(1000);
    expect((await prepareFile(small, compress)).blob).toBe(small);
    expect(compress).not.toHaveBeenCalled();
  });
  it('falls back to the original when compression fails or does not help', async () => {
    const big = photo(3 * 1024 * 1024, 'image/png', 'a.png');
    const failed = await prepareFile(big, () => Promise.reject(new Error('no canvas')));
    expect(failed).toMatchObject({ blob: big, clientCompressed: false, contentType: 'image/png' });
    const bigger = await prepareFile(big, async () => new Blob([new Uint8Array(4 * 1024 * 1024)]));
    expect(bigger.blob).toBe(big);
  });
  it('knows photos, limits and base64', async () => {
    expect(isPhoto('image/webp')).toBe(true);
    expect(isPhoto('application/pdf')).toBe(false);
    expect(limitFor('image/png')).toBe(15 * 1024 * 1024);
    expect(limitFor('application/pdf')).toBe(25 * 1024 * 1024);
    expect(await toBase64(new Blob(['hola']))).toBe('aG9sYQ==');
    expect(
      await captureTime(new File([], 'x.pdf', { type: 'application/pdf', lastModified: 0 })),
    ).toBeNull();
    const jpeg = new File([jpegWithExif('2026:10:12 09:30:00')], 'e.jpg', { type: 'image/jpeg' });
    expect(await captureTime(jpeg)).toBe(new Date(2026, 9, 12, 9, 30, 0).toISOString());
  });
});
