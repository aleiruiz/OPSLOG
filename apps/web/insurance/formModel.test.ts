import { describe, expect, it } from 'vitest';
import { makePolicy } from './fixtures';
import {
  changes,
  editValuesOf,
  emptyValues,
  renewalValuesOf,
  toInput,
  toRenewal,
  validate,
  vehicleErrors,
  type PolicyFormValues,
} from './formModel';

const valid: PolicyFormValues = {
  ...emptyValues,
  vehicleId: 'veh-001',
  insurer: 'Seguros Demo',
  policyNumber: 'pol-1',
  coverageType: 'comprehensive',
  startsOn: '2026-11-01',
  endsOn: '2027-10-31',
};
const create = (values: Partial<PolicyFormValues>, canViewCosts = true) =>
  validate({ ...valid, ...values }, { mode: 'create', canViewCosts });

describe('policy form model: create', () => {
  it('accepts valid values and builds a body without the deductible when there is none', () => {
    expect(create({})).toEqual({});
    expect(
      toInput({ ...valid, insurer: '  Seguros   Demo ', coverageNotes: ' notas ' }, true),
    ).toEqual({
      vehicleId: 'veh-001',
      insurer: 'Seguros Demo',
      coverageNotes: 'notas',
      policyNumber: 'POL-1',
      coverageType: 'comprehensive',
      startsOn: '2026-11-01',
      endsOn: '2027-10-31',
    });
  });

  it('explains every missing field', () => {
    expect(validate(emptyValues, { mode: 'create', canViewCosts: true })).toEqual({
      vehicleId: 'Elige el vehículo de la póliza.',
      insurer: 'Escribe el nombre de la aseguradora.',
      policyNumber: 'Escribe el número de póliza.',
      coverageType: 'Elige el tipo de cobertura.',
      startsOn: 'Elige el primer día de cobertura.',
      endsOn: 'Elige el último día de cobertura.',
    });
  });

  it('checks the vehicle, insurer, notes, number and coverage', () => {
    expect(create({ vehicleId: 'no válido' }).vehicleId).toMatch(/no es válido/);
    expect(create({ insurer: 'x' }).insurer).toMatch(/2 a 80/);
    expect(create({ coverageNotes: 'x'.repeat(501) }).coverageNotes).toMatch(/500/);
    expect(create({ policyNumber: '***' }).policyNumber).toMatch(/40 caracteres/);
    expect(create({ coverageType: 'nada' }).coverageType).toMatch(/no existe/);
  });

  it('checks the period: real days in range, end not before start, future start allowed', () => {
    expect(create({ startsOn: '1949-01-01' }).startsOn).toMatch(/entre 1950 y 2100/);
    expect(create({ endsOn: '2027-02-30' }).endsOn).toMatch(/entre 1950 y 2100/);
    expect(create({ startsOn: '2027-12-01', endsOn: '2027-11-30' }).endsOn).toMatch(
      /anterior al inicio/,
    );
    expect(create({ startsOn: '2030-01-01', endsOn: '2030-12-31' })).toEqual({});
    // A bad start does not also blame the end for the order.
    expect(create({ startsOn: '2027-02-30', endsOn: '2027-01-01' }).endsOn).toBeUndefined();
  });
});

describe('policy form model: deductible', () => {
  it('builds an exact amount in minor units and an exact percentage in basis points', () => {
    expect(
      toInput(
        {
          ...valid,
          deductibleKind: 'amount',
          deductibleAmount: '12500.5',
          deductibleCurrency: 'mxn',
        },
        true,
      ).deductible,
    ).toEqual({ kind: 'amount', amountMinor: 1_250_050, currency: 'MXN' });
    expect(
      toInput({ ...valid, deductibleKind: 'amount', deductibleAmount: '0.07' }, true).deductible,
    ).toEqual({ kind: 'amount', amountMinor: 7, currency: 'MXN' });
    expect(
      toInput({ ...valid, deductibleKind: 'percent', deductiblePercent: '12.5' }, true).deductible,
    ).toEqual({ kind: 'percent', basisPoints: 1250 });
  });

  it('validates the amount, the currency and the percentage with a message per field', () => {
    const amount = { deductibleKind: 'amount' as const };
    expect(create({ ...amount }).deductibleAmount).toBe('Escribe el monto del deducible.');
    expect(create({ ...amount, deductibleAmount: '12.345' }).deductibleAmount).toMatch(
      /hasta 2 decimales/,
    );
    expect(create({ ...amount, deductibleAmount: '0' }).deductibleAmount).toMatch(/mayor a cero/);
    expect(
      create({ ...amount, deductibleAmount: '10', deductibleCurrency: 'PESOS' }).deductibleCurrency,
    ).toMatch(/3 letras/);
    expect(create({ ...amount, deductibleAmount: '10', deductibleCurrency: 'ZZZ' })).toEqual({});
    expect(
      create({ ...amount, deductibleAmount: '10.5', deductibleCurrency: 'JPY' }).deductibleAmount,
    ).toMatch(/sin decimales/);
    expect(create({ deductibleKind: 'percent' }).deductiblePercent).toMatch(/entre 0.01 y 100/);
    expect(
      create({ deductibleKind: 'percent', deductiblePercent: '100.01' }).deductiblePercent,
    ).toMatch(/entre 0.01 y 100/);
    expect(create({ deductibleKind: 'percent', deductiblePercent: '100' })).toEqual({});
  });

  it('never validates or sends the deductible without view_costs', () => {
    const bad = { deductibleKind: 'percent' as const, deductiblePercent: 'mucho' };
    expect(create(bad, false)).toEqual({});
    const body = toInput({ ...valid, ...bad }, false);
    expect(Object.hasOwn(body, 'deductible')).toBe(false);
    expect(Object.hasOwn(toRenewal({ ...valid, ...bad }, false), 'deductible')).toBe(false);
  });
});

describe('policy form model: edit and renew', () => {
  const policy = makePolicy({
    coverageNotes: 'Notas',
    deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
    hasDeductible: true,
  });

  it('opens an edit with the insurer and notes only', () => {
    expect(editValuesOf(policy)).toMatchObject({ insurer: policy.insurer, coverageNotes: 'Notas' });
    expect(editValuesOf(makePolicy())).toMatchObject({ coverageNotes: '' });
    expect(validate(editValuesOf(policy), { mode: 'edit', canViewCosts: true })).toEqual({});
    expect(validate({ ...emptyValues, insurer: '' }, { mode: 'edit', canViewCosts: true })).toEqual(
      {
        insurer: 'Escribe el nombre de la aseguradora.',
      },
    );
  });

  it('computes the changes of an edit, trimming and turning empty notes into null', () => {
    const values = editValuesOf(policy);
    expect(changes(policy, values)).toBeNull();
    expect(changes(policy, { ...values, insurer: ' Otra   aseguradora ' })).toEqual({
      insurer: 'Otra aseguradora',
    });
    expect(changes(policy, { ...values, coverageNotes: ' ' })).toEqual({ coverageNotes: null });
    expect(changes(makePolicy(), { ...values, coverageNotes: 'Nuevas' })).toEqual({
      coverageNotes: 'Nuevas',
    });
  });

  it('opens a renewal with the year that follows, and the number, coverage and deductible carried over', () => {
    expect(renewalValuesOf(policy)).toMatchObject({
      policyNumber: 'POL-2026-0001',
      coverageType: 'comprehensive',
      startsOn: '2027-03-01',
      endsOn: '2028-02-29',
      deductibleKind: 'amount',
      deductibleAmount: '12500.00',
      deductibleCurrency: 'MXN',
    });
    expect(
      renewalValuesOf(
        makePolicy({ endsOn: '2026-12-31', deductible: { kind: 'percent', basisPoints: 1500 } }),
      ),
    ).toMatchObject({
      startsOn: '2027-01-01',
      endsOn: '2027-12-31',
      deductibleKind: 'percent',
      deductiblePercent: '15',
    });
    expect(renewalValuesOf(makePolicy())).toMatchObject({ deductibleKind: 'none' });
  });

  it('sends the deductible of a renewal explicitly with view_costs (null removes it) and never without', () => {
    const values = renewalValuesOf(policy);
    expect(validate(values, { mode: 'renew', canViewCosts: true })).toEqual({});
    expect(toRenewal(values, true)).toEqual({
      policyNumber: 'POL-2026-0001',
      coverageType: 'comprehensive',
      startsOn: '2027-03-01',
      endsOn: '2028-02-29',
      deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
    });
    expect(toRenewal({ ...values, deductibleKind: 'none' }, true).deductible).toBeNull();
    expect(Object.hasOwn(toRenewal(values, false), 'deductible')).toBe(false);
    expect(
      validate({ ...values, policyNumber: '' }, { mode: 'renew', canViewCosts: false }),
    ).toEqual({
      policyNumber: 'Escribe el número de póliza.',
    });
  });
});

describe('invalid vehicle message', () => {
  it('appears only for a 422 about vehicle_id', () => {
    const base = {
      code: 'invalid_vehicle',
      status: 422 as const,
      message: 'x',
      correlationId: 'c',
    };
    expect(
      vehicleErrors({ ...base, fieldErrors: [{ field: 'vehicle_id', code: 'x', message: 'x' }] }),
    ).toEqual({ vehicleId: expect.stringMatching(/no existe o está archivado/) });
    expect(vehicleErrors(base)).toEqual({});
  });
});
