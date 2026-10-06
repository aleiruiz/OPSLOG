import { describe, expect, it } from 'vitest';
import type { ApiError } from '../app/types';
import { makeVehicle } from './fixtures';
import {
  changes,
  duplicateErrors,
  emptyValues,
  fieldOrder,
  toInput,
  validate,
  valuesOf,
  type VehicleFormValues,
} from './formModel';
import { isPastOrToday, normalizePlate, normalizeVin, todayOf } from './rules';

const now = new Date('2026-10-06T12:00:00.000Z');
const valid: VehicleFormValues = {
  economicNumber: 'ECO-100',
  plate: 'ab 123 c',
  vin: '',
  make: 'Nissan',
  model: 'NP300',
  year: '2022',
  areaId: 'area-norte',
  odometerKm: '1200',
  registeredOn: '2026-10-01',
};
const create = { mode: 'create', now } as const;

describe('vehicle form validation (mirrors the backend rules)', () => {
  it('accepts a complete form and starts empty with today as the registration date', () => {
    expect(validate(valid, create)).toEqual({});
    expect(emptyValues(todayOf(now))).toMatchObject({
      economicNumber: '',
      registeredOn: '2026-10-06',
    });
    expect(fieldOrder).toHaveLength(Object.keys(valid).length);
  });

  it('explains every required field that is empty', () => {
    const errors = validate(emptyValues('2026-10-06'), create);
    expect(Object.keys(errors).sort()).toEqual(
      ['areaId', 'economicNumber', 'make', 'model', 'odometerKm', 'plate', 'year'].sort(),
    );
    expect(errors.odometerKm).toBe('Escribe el odómetro actual.');
    expect(validate({ ...valid, odometerKm: '' }, { mode: 'edit', now }).odometerKm).toBe(
      'Escribe la lectura del odómetro.',
    );
  });

  it('rejects malformed values with a message per field', () => {
    const errors = validate(
      {
        economicNumber: '*bad',
        plate: 'AB*1',
        vin: '1HGBH41JXMN1O9186',
        make: 'x'.repeat(61),
        model: 'a\nb',
        year: '1899',
        areaId: 'área',
        odometerKm: '12.5',
        registeredOn: '2027-01-01',
      },
      create,
    );
    expect(errors.economicNumber).toMatch(/32 caracteres/);
    expect(errors.plate).toMatch(/16 caracteres/);
    expect(errors.vin).toMatch(/17 caracteres/);
    expect(errors.make).toMatch(/60 caracteres/);
    expect(errors.model).toMatch(/60 caracteres/);
    expect(errors.year).toBe('Escribe un año entre 1950 y 2027.');
    expect(errors.areaId).toMatch(/guion/);
    expect(errors.odometerKm).toMatch(/entero/);
    expect(errors.registeredOn).toMatch(/futura/);
  });

  it('bounds the year, the odometer and the registration date', () => {
    expect(validate({ ...valid, year: '2027' }, create).year).toBeUndefined();
    expect(validate({ ...valid, year: '2028' }, create).year).toBeDefined();
    expect(validate({ ...valid, year: '22' }, create).year).toBeDefined();
    expect(validate({ ...valid, odometerKm: '9999999' }, create).odometerKm).toBeUndefined();
    expect(validate({ ...valid, odometerKm: '10000000' }, create).odometerKm).toBeDefined();
    expect(validate({ ...valid, registeredOn: '2026-02-30' }, create).registeredOn).toBeDefined();
    expect(validate({ ...valid, registeredOn: '2026-10-06' }, create).registeredOn).toBeUndefined();
  });

  it('accepts an optional VIN in lower case and refuses I, O and Q', () => {
    expect(validate({ ...valid, vin: '3n6pd23w05zb10005' }, create).vin).toBeUndefined();
    expect(validate({ ...valid, vin: '3N6PD23W05ZB1000Q' }, create).vin).toBeDefined();
  });

  it('refuses an odometer below the loaded reading when editing, but allows an equal or higher one', () => {
    const edit = { mode: 'edit', now, currentOdometerKm: 48250 } as const;
    expect(validate({ ...valid, odometerKm: '48249' }, edit).odometerKm).toBe(
      'El odómetro no puede bajar: la lectura actual es 48,250 km.',
    );
    expect(validate({ ...valid, odometerKm: '48250' }, edit).odometerKm).toBeUndefined();
    expect(validate({ ...valid, odometerKm: '50000' }, edit).odometerKm).toBeUndefined();
    // The registration date is not editable: it is not validated when editing.
    expect(validate({ ...valid, registeredOn: '' }, edit).registeredOn).toBeUndefined();
  });
});

describe('request bodies', () => {
  it('normalizes a creation body and omits an empty VIN', () => {
    expect(toInput(valid)).toEqual({
      economicNumber: 'ECO-100',
      plate: 'AB 123 C',
      make: 'Nissan',
      model: 'NP300',
      year: 2022,
      areaId: 'area-norte',
      odometerKm: 1200,
      registeredOn: '2026-10-01',
    });
    expect(toInput({ ...valid, vin: ' 3n6pd23w05zb10005 ' }).vin).toBe('3N6PD23W05ZB10005');
  });

  it('reports only what changed against the loaded vehicle', () => {
    const vehicle = makeVehicle({ vin: '3N6PD23W05ZB10005' });
    const same = valuesOf(vehicle);
    expect(changes(vehicle, same)).toEqual({ patch: null, odometerKm: null });
    expect(
      changes(vehicle, { ...same, make: ' Toyota ', plate: 'abc-101', odometerKm: '50000' }),
    ).toEqual({ patch: { make: 'Toyota' }, odometerKm: 50000 });
    expect(changes(vehicle, { ...same, vin: '' }).patch).toEqual({ vin: null });
    expect(
      changes(makeVehicle(), { ...valuesOf(makeVehicle()), vin: '3n6pd23w05zb10005' }).patch,
    ).toEqual({
      vin: '3N6PD23W05ZB10005',
    });
    expect(
      changes(vehicle, {
        ...same,
        economicNumber: 'ECO-009',
        model: 'Frontier',
        year: '2023',
        areaId: 'area-sur',
      }).patch,
    ).toEqual({ economicNumber: 'ECO-009', model: 'Frontier', year: 2023, areaId: 'area-sur' });
  });

  it('turns the colliding field of a duplicate into a field message, never echoing a value', () => {
    const error = (field: string) => ({
      code: 'duplicate',
      status: 409 as const,
      message: 'Conflict',
      correlationId: 'c',
      fieldErrors: [{ field, code: 'duplicate', message: 'Conflict' }],
    });
    expect(duplicateErrors(error('economic_number'))).toEqual({
      economicNumber: 'Ya existe un vehículo con este número económico.',
    });
    expect(duplicateErrors(error('plate')).plate).toMatch(/placa/);
    expect(duplicateErrors(error('vin')).vin).toMatch(/VIN/);
    expect(duplicateErrors(error('desconocido'))).toEqual({});
    const withoutFields: ApiError = { ...error('plate') };
    delete (withoutFields as { fieldErrors?: unknown }).fieldErrors;
    expect(duplicateErrors(withoutFields)).toEqual({});
  });
});

describe('field rules', () => {
  it('normalizes plates and VINs like the backend', () => {
    expect(normalizePlate('  ab   123 ')).toBe('AB 123');
    expect(normalizeVin(' abc ')).toBe('ABC');
    expect(isPastOrToday('2026-10-06', '2026-10-06')).toBe(true);
    expect(isPastOrToday('2026-10-07', '2026-10-06')).toBe(false);
    expect(isPastOrToday('06/10/2026', '2026-10-06')).toBe(false);
    expect(isPastOrToday('2026-13-01', '2026-10-06')).toBe(false);
  });
});
