import { describe, expect, it } from 'vitest';
import { makeDocument } from './fixtures';
import {
  changes,
  editValuesOf,
  emptyValues,
  ownerErrors,
  renewalValuesOf,
  toInput,
  toRenewal,
  validate,
  type DocumentFormValues,
} from './formModel';

const now = new Date('2026-10-06T12:00:00.000Z');
const valid: DocumentFormValues = {
  ownerId: 'veh-001',
  typeCode: 'registration_card',
  title: 'Tarjeta ECO-001',
  notes: '',
  issuedOn: '2026-01-10',
  expiresOn: '2027-01-10',
  documentNumber: 'tc-1',
};
const create = (values: Partial<DocumentFormValues>) =>
  validate({ ...valid, ...values }, { mode: 'create', now });

describe('document form model: create', () => {
  it('accepts valid values and builds the body without empty optional fields', () => {
    expect(create({})).toEqual({});
    expect(toInput({ ...valid, title: '  Tarjeta   ECO-001 ', notes: ' nota ' })).toEqual({
      ownerType: 'vehicle',
      ownerId: 'veh-001',
      typeCode: 'registration_card',
      title: 'Tarjeta ECO-001',
      notes: 'nota',
      issuedOn: '2026-01-10',
      expiresOn: '2027-01-10',
      documentNumber: 'TC-1',
    });
    expect(
      toInput({
        ...valid,
        issuedOn: '',
        documentNumber: '',
        typeCode: 'ownership_title',
        expiresOn: '',
      }),
    ).toEqual({
      ownerType: 'vehicle',
      ownerId: 'veh-001',
      typeCode: 'ownership_title',
      title: 'Tarjeta ECO-001',
    });
  });

  it('explains every missing field', () => {
    expect(validate(emptyValues, { mode: 'create', now })).toEqual({
      ownerId: 'Elige el vehículo del documento.',
      typeCode: 'Elige el tipo de documento.',
      title: 'Escribe el título del documento.',
    });
  });

  it('rejects an unknown vehicle id, an unknown type and a type of the other owner', () => {
    expect(create({ ownerId: 'no válido' }).ownerId).toMatch(/no es válido/);
    expect(create({ typeCode: 'nada' }).typeCode).toMatch(/no existe/);
    expect(create({ typeCode: 'medical_exam' }).typeCode).toMatch(/no existe/);
  });

  it('requires an expiry for the types that always expire and not for the others', () => {
    expect(create({ expiresOn: '' }).expiresOn).toMatch(/siempre vence/);
    expect(create({ typeCode: 'ownership_title', expiresOn: '', issuedOn: '' })).toEqual({});
  });

  it('checks dates: real days, no future issue, range and order', () => {
    expect(create({ issuedOn: '2026-10-07' }).issuedOn).toMatch(/no sea futura/);
    expect(create({ issuedOn: '2026-02-30' }).issuedOn).toMatch(/no sea futura/);
    expect(create({ expiresOn: '2101-01-01' }).expiresOn).toMatch(/entre 1950 y 2100/);
    expect(create({ expiresOn: '2025-12-31' }).expiresOn).toMatch(/anterior a la emisión/);
    // An invalid issue date does not also blame the expiry for the order.
    expect(create({ issuedOn: '2030-01-01', expiresOn: '2027-01-01' }).expiresOn).toBeUndefined();
    expect(create({ expiresOn: '2026-10-06', issuedOn: '2026-10-06' })).toEqual({});
  });

  it('checks the title, the notes and the document number', () => {
    expect(create({ title: 'x'.repeat(81) }).title).toMatch(/80 caracteres/);
    expect(create({ notes: 'x'.repeat(501) }).notes).toMatch(/500 caracteres/);
    expect(create({ documentNumber: '***' }).documentNumber).toMatch(/40 caracteres/);
  });
});

describe('document form model: edit and renew', () => {
  const document = makeDocument({ notes: 'Notas', documentNumber: 'TC-1' });

  it('opens an edit with the title and notes, and a renewal with the number only', () => {
    expect(editValuesOf(document)).toMatchObject({ title: document.title, notes: 'Notas' });
    expect(editValuesOf(makeDocument())).toMatchObject({ notes: '' });
    expect(renewalValuesOf(document)).toEqual({ ...emptyValues, documentNumber: 'TC-1' });
    expect(renewalValuesOf(makeDocument({ documentNumber: null })).documentNumber).toBe('');
  });

  it('validates only title and notes when editing', () => {
    const values = editValuesOf(document);
    expect(validate(values, { mode: 'edit', now, document })).toEqual({});
    expect(validate({ ...values, title: ' ' }, { mode: 'edit', now, document })).toEqual({
      title: 'Escribe el título del documento.',
    });
  });

  it('computes the changes of an edit, trimming and turning empty notes into null', () => {
    const values = editValuesOf(document);
    expect(changes(document, values)).toBeNull();
    expect(changes(document, { ...values, title: ' Otro   título ' })).toEqual({
      title: 'Otro título',
    });
    expect(changes(document, { ...values, notes: ' ' })).toEqual({ notes: null });
    expect(changes(makeDocument(), { ...values, notes: 'Nuevas' })).toEqual({ notes: 'Nuevas' });
  });

  it('validates the dates of a renewal against the rule of the document type', () => {
    const base = renewalValuesOf(document);
    expect(validate(base, { mode: 'renew', now, document })).toMatchObject({
      expiresOn: expect.stringMatching(/siempre vence/),
    });
    expect(
      validate({ ...base, expiresOn: '2028-01-01' }, { mode: 'renew', now, document }),
    ).toEqual({});
    const optional = makeDocument({ typeCode: 'other' });
    expect(validate(base, { mode: 'renew', now, document: optional })).toEqual({});
    // Without the document the rule is unknown, so no expiry is demanded.
    expect(validate(base, { mode: 'renew', now })).toEqual({});
    expect(toRenewal({ ...base, issuedOn: ' 2026-10-01 ', expiresOn: '2028-01-01' })).toEqual({
      issuedOn: '2026-10-01',
      expiresOn: '2028-01-01',
      documentNumber: 'TC-1',
    });
    expect(toRenewal({ ...emptyValues, expiresOn: '2028-01-01' })).toEqual({
      expiresOn: '2028-01-01',
    });
  });
});

describe('invalid owner message', () => {
  it('appears only for a 422 about owner_id', () => {
    const base = { code: 'invalid_owner', status: 422 as const, message: 'x', correlationId: 'c' };
    expect(
      ownerErrors({ ...base, fieldErrors: [{ field: 'owner_id', code: 'x', message: 'x' }] }),
    ).toEqual({
      ownerId: expect.stringMatching(/no existe o está archivado/),
    });
    expect(ownerErrors(base)).toEqual({});
    expect(
      ownerErrors({ ...base, fieldErrors: [{ field: 'otro', code: 'x', message: 'x' }] }),
    ).toEqual({});
  });
});
