import { describe, expect, it } from 'vitest';
import { makeEmployeeDetail, noPii } from './fixtures';
import {
  changes,
  duplicateErrors,
  emptyValues,
  fieldOrder,
  toInput,
  valuesOf,
  validate,
  type EmployeeFormValues,
} from './formModel';

const now = new Date('2026-10-06T12:00:00.000Z');
const create = { mode: 'create', now, canEditPii: true } as const;
const valid: EmployeeFormValues = {
  ...emptyValues(),
  kind: 'dispatcher',
  firstName: 'Nora',
  lastName: 'Quiroga',
  areaId: 'area-sur',
};

describe('employee form validation (mirrors the backend rules)', () => {
  it('asks for kind, names and area on an empty form, and nothing else', () => {
    const errors = validate(emptyValues(), create);
    expect(Object.keys(errors).sort()).toEqual(['areaId', 'firstName', 'kind', 'lastName']);
    expect(errors.kind).toBe('Elige el tipo de empleado.');
    expect(errors.firstName).toBe('Escribe el nombre.');
    expect(errors.lastName).toBe('Escribe los apellidos.');
    expect(errors.areaId).toBe('Elige el área del empleado.');
  });

  it('accepts a minimal valid form and does not ask for the kind when editing', () => {
    expect(validate(valid, create)).toEqual({});
    expect(validate({ ...valid, kind: '' }, { ...create, mode: 'edit' })).toEqual({});
  });

  it('rejects malformed values with a message per field', () => {
    const errors = validate(
      {
        ...valid,
        kind: 'driver',
        firstName: '1Nora',
        lastName: 'x'.repeat(61),
        employeeNumber: '*bad',
        position: 'a\nb',
        hireDate: '2027-01-01',
        licenseType: 'c!',
        licenseExpiresOn: '2101-01-01',
        idType: 'INE!',
        nationalId: '12',
        phone: '5555',
        email: 'sin-arroba',
        licenseNumber: 'lic',
      },
      create,
    );
    expect(errors.firstName).toMatch(/letras/);
    expect(errors.lastName).toMatch(/60 caracteres/);
    expect(errors.employeeNumber).toMatch(/32 caracteres/);
    expect(errors.position).toMatch(/60 caracteres/);
    expect(errors.hireDate).toMatch(/entre .* y hoy/);
    expect(errors.licenseType).toMatch(/16 caracteres/);
    expect(errors.licenseExpiresOn).toMatch(/entre/);
    expect(errors.idType).toMatch(/no es válido/);
    expect(errors.nationalId).toMatch(/4 a 32/);
    expect(errors.phone).toMatch(/formato internacional/i);
    expect(errors.email).toMatch(/correo válido/);
    expect(errors.licenseNumber).toMatch(/4 a 32/);
  });

  it('treats the identification type and number as a pair', () => {
    expect(validate({ ...valid, nationalId: 'EJEM 1234' }, create).idType).toBe(
      'Elige el tipo de identificación.',
    );
    expect(validate({ ...valid, idType: 'ine' }, create).nationalId).toBe(
      'Escribe el número de identificación.',
    );
    expect(validate({ ...valid, idType: 'ine', nationalId: 'ejem 1234' }, create)).toEqual({});
  });

  it('accepts what the server normalizes: phone with separators, e-mail in capitals, hire date today', () => {
    expect(
      validate(
        {
          ...valid,
          phone: '+52 (55) 5555-0100',
          email: ' Nora@Ejemplo.TEST ',
          hireDate: '2026-10-06',
        },
        create,
      ),
    ).toEqual({});
    expect(validate({ ...valid, email: `${'a'.repeat(250)}@b.cc` }, create).email).toBeDefined();
  });

  it('ignores license fields for anyone who is not a driver, and personal data without the permission', () => {
    const noise = {
      licenseType: 'c!',
      licenseExpiresOn: 'mañana',
      licenseNumber: '!',
      nationalId: '1',
      phone: 'x',
      email: 'x',
    };
    expect(validate({ ...valid, ...noise }, { ...create, canEditPii: false })).toEqual({});
    const driver = validate(
      { ...valid, kind: 'driver', ...noise },
      { ...create, canEditPii: false },
    );
    expect(Object.keys(driver).sort()).toEqual(['licenseExpiresOn', 'licenseType']);
    // A non-driver with personal data permission still checks the personal data that exists for them.
    const dispatcher = validate({ ...valid, ...noise }, create);
    expect(dispatcher.licenseNumber).toBeUndefined();
    expect(dispatcher.phone).toBeDefined();
  });

  it('keeps the first-error order of the screen', () => {
    expect(fieldOrder[0]).toBe('kind');
    expect(fieldOrder.indexOf('areaId')).toBeLessThan(fieldOrder.indexOf('idType'));
    expect([...fieldOrder].sort()).toEqual(Object.keys(emptyValues()).sort());
  });
});

describe('employee form model', () => {
  it('builds the creation body with normalized values and leaves empty optionals out', () => {
    expect(toInput(valid, true)).toEqual({
      kind: 'dispatcher',
      firstName: 'Nora',
      lastName: 'Quiroga',
      areaId: 'area-sur',
    });
    expect(
      toInput(
        {
          ...valid,
          kind: 'driver',
          firstName: '  Nora   María ',
          employeeNumber: ' E-9 ',
          position: ' Chofer ',
          hireDate: '2026-01-15',
          licenseType: 'c',
          licenseExpiresOn: '2029-01-01',
          idType: 'ine',
          nationalId: ' ejem 9000 ',
          phone: '+52 55 5555 0199',
          email: ' Nora@Ejemplo.TEST ',
          licenseNumber: 'lic-9',
        },
        true,
      ),
    ).toEqual({
      kind: 'driver',
      firstName: 'Nora María',
      lastName: 'Quiroga',
      areaId: 'area-sur',
      employeeNumber: 'E-9',
      position: 'Chofer',
      hireDate: '2026-01-15',
      licenseType: 'C',
      licenseExpiresOn: '2029-01-01',
      idType: 'ine',
      nationalId: 'EJEM 9000',
      phone: '+525555550199',
      email: 'nora@ejemplo.test',
      licenseNumber: 'LIC-9',
    });
  });

  it('never sends personal data without the permission, nor license data of a non-driver', () => {
    const body = toInput(
      {
        ...valid,
        licenseType: 'C',
        idType: 'ine',
        nationalId: 'EJEM 1234',
        phone: '+525555550100',
        email: 'a@b.cc',
        licenseNumber: 'LIC-1',
      },
      false,
    );
    expect(body).toEqual({
      kind: 'dispatcher',
      firstName: 'Nora',
      lastName: 'Quiroga',
      areaId: 'area-sur',
    });
    const withPii = toInput({ ...valid, licenseNumber: 'LIC-1', phone: '+525555550100' }, true);
    expect(withPii).toEqual({ ...body, phone: '+525555550100' });
  });

  it('opens an edit form with the loaded values, personal data empty when it is masked', () => {
    const detail = makeEmployeeDetail();
    expect(valuesOf(detail)).toMatchObject({
      kind: 'driver',
      firstName: 'Ana',
      areaId: 'area-norte',
      licenseType: 'C',
      licenseExpiresOn: '2028-03-31',
      idType: 'curp',
      nationalId: 'EJEM800101HDFXXX01',
      phone: '+525555550100',
    });
    const masked = valuesOf(makeEmployeeDetail({}, null));
    expect(masked).toMatchObject({ nationalId: '', phone: '', email: '', licenseNumber: '' });
    const bare = valuesOf(
      makeEmployeeDetail(
        {
          employeeNumber: null,
          position: null,
          hireDate: null,
          licenseType: null,
          licenseExpiresOn: null,
          idType: null,
        },
        noPii,
      ),
    );
    expect(bare).toMatchObject({ employeeNumber: '', position: '', hireDate: '', idType: '' });
  });

  describe('changes', () => {
    const detail = makeEmployeeDetail();
    const same = valuesOf(detail);

    it('is null when nothing changed, ignoring formatting the server would normalize', () => {
      expect(changes(detail, same, true)).toBeNull();
      expect(
        changes(
          detail,
          { ...same, firstName: ' Ana  ', phone: '+52 55 5555 0100', licenseType: ' c ' },
          true,
        ),
      ).toBeNull();
    });

    it('sends only what changed, and null for a field that was emptied', () => {
      expect(
        changes(
          detail,
          {
            ...same,
            position: '',
            lastName: 'Ruiz',
            areaId: 'area-sur',
            licenseExpiresOn: '2029-01-01',
          },
          true,
        ),
      ).toEqual({
        position: null,
        lastName: 'Ruiz',
        areaId: 'area-sur',
        licenseExpiresOn: '2029-01-01',
      });
    });

    it('moves the identification as a pair: a new type or number sends both, clearing sends both null', () => {
      expect(changes(detail, { ...same, idType: 'ine' }, true)).toEqual({
        idType: 'ine',
        nationalId: 'EJEM800101HDFXXX01',
      });
      expect(changes(detail, { ...same, nationalId: 'ejem 77' }, true)).toEqual({
        idType: 'curp',
        nationalId: 'EJEM 77',
      });
      expect(changes(detail, { ...same, idType: '', nationalId: '' }, true)).toEqual({
        idType: null,
        nationalId: null,
      });
    });

    it('compares personal data only with the permission, so a masked form can never clear it', () => {
      const masked = makeEmployeeDetail({}, null);
      expect(changes(masked, { ...valuesOf(masked), position: 'Otro' }, false)).toEqual({
        position: 'Otro',
      });
      expect(
        changes(masked, { ...valuesOf(masked), phone: '+525555550100', nationalId: 'X' }, false),
      ).toBeNull();
    });

    it('does not touch license data of a non-driver', () => {
      const dispatcher = makeEmployeeDetail({
        kind: 'dispatcher',
        licenseType: null,
        licenseExpiresOn: null,
      });
      expect(
        changes(
          dispatcher,
          { ...valuesOf(dispatcher), licenseType: 'C', licenseNumber: 'LIC-1' },
          true,
        ),
      ).toBeNull();
    });
  });

  it('maps a duplicate to the field the server names, and ignores unknown names', () => {
    const error = (field: string) => ({
      code: 'duplicate',
      status: 409 as const,
      message: 'x',
      correlationId: 'c',
      fieldErrors: [{ field, code: 'duplicate', message: 'x' }],
    });
    expect(duplicateErrors(error('employee_number'))).toEqual({
      employeeNumber: 'Ya existe un empleado con este número de empleado.',
    });
    expect(duplicateErrors(error('national_id')).nationalId).toMatch(/identificación/);
    expect(duplicateErrors(error('email')).email).toMatch(/correo/);
    expect(duplicateErrors(error('otro'))).toEqual({});
    expect(
      duplicateErrors({ code: 'duplicate', status: 409, message: 'x', correlationId: 'c' }),
    ).toEqual({});
  });
});
