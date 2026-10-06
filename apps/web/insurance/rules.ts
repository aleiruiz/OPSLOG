import type { CoverageType, Deductible } from '../app/types';

/**
 * Field rules of an insurance policy, mirrored from the domain (`packages/domain/insurance`). The server stays the
 * authority; the forms check the same rules first and explain the problem next to the field. Dates, numbers and
 * text normalization are shared with documents (`../documents/rules`).
 */
export const INSURER = /^[^\u0000-\u001f\u007f]{2,80}$/u;
export const CURRENCY = /^[A-Z]{3}$/;
/** Largest deductible amount in minor units (keeps every value an exact integer). */
export const MAX_DEDUCTIBLE_MINOR = 1_000_000_000_000;
/** 100 % in basis points. */
export const MAX_BASIS_POINTS = 10_000;
export const DEFAULT_CURRENCY = 'MXN';

export const COVERAGE_TYPES: readonly CoverageType[] = [
  'mandatory_liability',
  'third_party',
  'comprehensive',
  'other',
];

/** Decimal places of a currency's minor unit (2 for MXN or USD, 0 for JPY); `null` for a code the platform does not know. */
export function currencyExponent(currency: string): number | null {
  if (!CURRENCY.test(currency)) return null;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    return null;
  }
}

/** `"1250.5"` in a currency with 2 decimals is 125050 minor units. Exact: never a float. */
export function parseAmountToMinor(text: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null) return null;
  const match = new RegExp(`^(\\d{1,13})(?:\\.(\\d{1,${Math.max(exponent, 1)}}))?$`).exec(
    text.trim(),
  );
  if (!match || (exponent === 0 && match[2] !== undefined)) return null;
  const minor = Number(`${match[1]}${(match[2] ?? '').padEnd(exponent, '0')}`);
  return minor >= 1 && minor <= MAX_DEDUCTIBLE_MINOR ? minor : null;
}

/** Inverse of `parseAmountToMinor`, for a form that opens with an existing amount. */
export function minorToText(minor: number, exponent: number): string {
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** `"12.5"` percent is 1250 basis points (0.01 % to 100 %). */
export function parsePercentToBasisPoints(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const basisPoints = Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
  return basisPoints >= 1 && basisPoints <= MAX_BASIS_POINTS ? basisPoints : null;
}

export function basisPointsToText(basisPoints: number): string {
  const text = minorToText(basisPoints, 2);
  return text.replace(/\.?0+$/, '');
}

/** A deductible as the form shows it. */
export interface DeductibleDraft {
  kind: 'none' | 'amount' | 'percent';
  amount: string;
  currency: string;
  percent: string;
}

export const noDeductible: DeductibleDraft = {
  kind: 'none',
  amount: '',
  currency: DEFAULT_CURRENCY,
  percent: '',
};

export function draftOf(deductible: Deductible | null): DeductibleDraft {
  if (deductible === null) return noDeductible;
  if (deductible.kind === 'percent')
    return { ...noDeductible, kind: 'percent', percent: basisPointsToText(deductible.basisPoints) };
  return {
    ...noDeductible,
    kind: 'amount',
    currency: deductible.currency,
    amount: minorToText(deductible.amountMinor, currencyExponent(deductible.currency) ?? 2),
  };
}
