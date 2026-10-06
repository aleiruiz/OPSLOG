import { describe, expect, it } from 'vitest';
import { makePolicy } from './fixtures';
import {
  coverageLabel,
  formatDeductible,
  isEditable,
  notStarted,
  statusPresentation,
} from './labels';
import {
  basisPointsToText,
  currencyExponent,
  draftOf,
  minorToText,
  noDeductible,
  parseAmountToMinor,
  parsePercentToBasisPoints,
} from './rules';

describe('currency arithmetic', () => {
  it('knows the decimals of a currency and rejects what is not a currency code', () => {
    expect(currencyExponent('MXN')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('mxn')).toBeNull();
    expect(currencyExponent('ZZZ')).toBe(2);
  });

  it('turns a decimal text into exact minor units and back', () => {
    expect(parseAmountToMinor('12500', 'MXN')).toBe(1_250_000);
    expect(parseAmountToMinor(' 0.1 ', 'MXN')).toBe(10);
    expect(parseAmountToMinor('1500', 'JPY')).toBe(1500);
    expect(parseAmountToMinor('1.250', 'KWD')).toBe(1250);
    expect(parseAmountToMinor('10000000000.00', 'MXN')).toBe(1_000_000_000_000);
    expect(parseAmountToMinor('10000000000.01', 'MXN')).toBeNull();
    for (const text of ['', '0', '0.00', '-5', '1,5', '1.234', '1e3', 'abc', '1.5'])
      expect(parseAmountToMinor(text, text === '1.5' ? 'JPY' : 'MXN')).toBeNull();
    expect(parseAmountToMinor('10', 'xx')).toBeNull();
    expect(minorToText(1_250_050, 2)).toBe('12500.50');
    expect(minorToText(7, 2)).toBe('0.07');
    expect(minorToText(1500, 0)).toBe('1500');
    expect(minorToText(1250, 3)).toBe('1.250');
  });

  it('turns a percentage into basis points and back', () => {
    expect(parsePercentToBasisPoints('15')).toBe(1500);
    expect(parsePercentToBasisPoints('0.01')).toBe(1);
    expect(parsePercentToBasisPoints('100')).toBe(10_000);
    for (const text of ['', '0', '0.00', '100.01', '1.234', '-1', 'x', '1000'])
      expect(parsePercentToBasisPoints(text)).toBeNull();
    expect(basisPointsToText(1500)).toBe('15');
    expect(basisPointsToText(1250)).toBe('12.5');
    expect(basisPointsToText(1)).toBe('0.01');
    expect(basisPointsToText(10_000)).toBe('100');
  });

  it('builds the form draft of a deductible', () => {
    expect(draftOf(null)).toEqual(noDeductible);
    expect(draftOf({ kind: 'percent', basisPoints: 250 })).toMatchObject({
      kind: 'percent',
      percent: '2.5',
    });
    expect(draftOf({ kind: 'amount', amountMinor: 99, currency: 'USD' })).toMatchObject({
      kind: 'amount',
      amount: '0.99',
      currency: 'USD',
    });
    expect(draftOf({ kind: 'amount', amountMinor: 99, currency: 'xx' })).toMatchObject({
      amount: '0.99',
    });
  });
});

describe('policy labels', () => {
  it('names statuses and coverages without technical ids', () => {
    expect(Object.values(statusPresentation).map((item) => item.label)).toEqual([
      'Vigente',
      'Por vencer',
      'Vencida',
      'Reemplazada',
    ]);
    expect(coverageLabel('mandatory_liability')).toBe('Responsabilidad civil obligatoria');
    expect(coverageLabel('comprehensive')).toBe('Todo riesgo');
    expect(coverageLabel('nueva')).toBe('Otra cobertura');
  });

  it('formats a deductible exactly: grouped amounts with their currency, and percentages', () => {
    expect(formatDeductible({ kind: 'amount', amountMinor: 1_250_050, currency: 'MXN' })).toBe(
      '12,500.50 MXN',
    );
    expect(formatDeductible({ kind: 'amount', amountMinor: 1500, currency: 'JPY' })).toBe(
      '1,500 JPY',
    );
    expect(formatDeductible({ kind: 'amount', amountMinor: 5, currency: 'xx' })).toBe('0.05 xx');
    expect(formatDeductible({ kind: 'percent', basisPoints: 1500 })).toBe('15 %');
    expect(formatDeductible({ kind: 'percent', basisPoints: 1250 })).toBe('12.5 %');
    expect(formatDeductible({ kind: 'percent', basisPoints: 1 })).toBe('0.01 %');
    expect(formatDeductible({ kind: 'percent', basisPoints: 10_000 })).toBe('100 %');
  });

  it('flags a policy that has not started and is editable until archived', () => {
    expect(notStarted(makePolicy({ status: 'valid', covering: false }))).toBe(true);
    expect(notStarted(makePolicy({ status: 'valid', covering: true }))).toBe(false);
    expect(notStarted(makePolicy({ status: 'expired', covering: false }))).toBe(false);
    expect(isEditable(makePolicy())).toBe(true);
    expect(isEditable(makePolicy({ archivedAt: '2026-09-30T00:00:00.000Z' }))).toBe(false);
  });
});
