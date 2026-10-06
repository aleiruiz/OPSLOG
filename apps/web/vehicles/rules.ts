/**
 * Field rules of a vehicle, mirrored from the domain (`packages/domain/vehicles`). The server stays the
 * authority and answers a uniform 400 without saying which field failed, so the forms check the same
 * rules first and explain the problem next to the field.
 */
export const MAX_ODOMETER_KM = 9_999_999;
export const MIN_MODEL_YEAR = 1950;

export const ECONOMIC_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;
export const PLATE = /^[A-Z0-9](?:[A-Z0-9 -]{0,14}[A-Z0-9])?$/;
/** ISO 3779 alphabet: 17 characters, never I, O or Q. */
export const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
export const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/u;
export const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const normalizePlate = (value: string): string =>
  value.trim().toUpperCase().replace(/\s+/g, ' ');
export const normalizeVin = (value: string): string => value.trim().toUpperCase();

/** Newest model year the domain accepts: next calendar year. */
export const maxModelYear = (now: Date): number => now.getUTCFullYear() + 1;

export const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** A real calendar date `YYYY-MM-DD` that is not after `today`. */
export function isPastOrToday(value: string, today: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && todayOf(parsed) === value && value <= today;
}

export const isInteger = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;
