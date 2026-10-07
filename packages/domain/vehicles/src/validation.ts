import { VehicleError } from './errors.js';
import {
  MAX_ODOMETER_KM,
  MAX_REASON_LENGTH,
  MIN_MODEL_YEAR,
  type NewVehicleData,
  type VehicleCore,
} from './types.js';

export const invalid = (): never => {
  throw new VehicleError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const ECONOMIC_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;

const PLATE = /^[A-Z0-9](?:[A-Z0-9 -]{0,14}[A-Z0-9])?$/;

/** ISO 3779 alphabet: 17 characters, letters I, O and Q never occur. The check digit is not verified. */
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/u;

const CONTROL = /[\u0000-\u001f\u007f]/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Display form of an economic number (internal fleet number): trimmed, original case. */
export function normalizeEconomicNumber(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return ECONOMIC_NUMBER.test(text) ? text : invalid();
}

/** Uniqueness key of an economic number: case-insensitive. */
export const economicNumberKey = (economicNumber: string): string => economicNumber.toLowerCase();

/** Display form of a plate: upper case, single spaces. */
export function normalizePlate(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, ' ') : '';
  return PLATE.test(text) ? text : invalid();
}

/** Uniqueness key of a plate: `AB-123 C`, `ab 123c` and `AB123C` are the same plate. */
export const plateKey = (plate: string): string => plate.replace(/[ -]/g, '');

export function normalizeVin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return VIN.test(text) ? text : invalid();
}

function normalizeLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return LABEL.test(text) ? text : invalid();
}

function normalizeYear(value: unknown, now: Date): number {
  return isInteger(value, MIN_MODEL_YEAR, now.getUTCFullYear() + 1) ? value : invalid();
}

export function normalizeOdometer(value: unknown): number {
  return isInteger(value, 0, MAX_ODOMETER_KM) ? value : invalid();
}

export const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

function normalizeRegisteredOn(value: unknown, now: Date): string {
  if (value === undefined) return dateOf(now);
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOf(parsed) !== value || value > dateOf(now))
    return invalid();
  return value;
}

/** A status-change reason (BR-004): required, one line, at most 200 characters. */
export function normalizeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 1 && text.length <= MAX_REASON_LENGTH && !CONTROL.test(text)
    ? text
    : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown, allowed: readonly string[]): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !allowed.includes(key)) ? invalid() : record;
}

export const CREATE_FIELDS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
  'odometerKm',
  'registeredOn',
] as const;

export const UPDATE_FIELDS = [
  'economicNumber',
  'plate',
  'vin',
  'make',
  'model',
  'year',
  'areaId',
] as const;

/** Validates and normalizes the data of a new vehicle. Unknown properties are rejected. */
export function parseNewVehicle(input: unknown, now: Date): NewVehicleData {
  const fields = asFields(input, CREATE_FIELDS);
  const required = ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'];
  if (required.some((key) => !Object.hasOwn(fields, key))) return invalid();
  return {
    economicNumber: normalizeEconomicNumber(fields['economicNumber']),
    plate: normalizePlate(fields['plate']),
    vin: normalizeVin(fields['vin']),
    make: normalizeLabel(fields['make']),
    model: normalizeLabel(fields['model']),
    year: normalizeYear(fields['year'], now),
    areaId: requireOpaqueId(fields['areaId']),
    odometerKm: normalizeOdometer(fields['odometerKm']),
    registeredOn: normalizeRegisteredOn(fields['registeredOn'], now),
  };
}

/** Validates a partial update; only the fields that are present are returned. */
export function parseVehiclePatch(input: unknown, now: Date): Partial<VehicleCore> {
  const fields = asFields(input, UPDATE_FIELDS);
  if (Object.keys(fields).length === 0) return invalid();
  const patch: { -readonly [K in keyof VehicleCore]?: VehicleCore[K] } = {};
  if (Object.hasOwn(fields, 'economicNumber'))
    patch.economicNumber = normalizeEconomicNumber(fields['economicNumber']);
  if (Object.hasOwn(fields, 'plate')) patch.plate = normalizePlate(fields['plate']);
  if (Object.hasOwn(fields, 'vin')) patch.vin = normalizeVin(fields['vin']);
  if (Object.hasOwn(fields, 'make')) patch.make = normalizeLabel(fields['make']);
  if (Object.hasOwn(fields, 'model')) patch.model = normalizeLabel(fields['model']);
  if (Object.hasOwn(fields, 'year')) patch.year = normalizeYear(fields['year'], now);
  if (Object.hasOwn(fields, 'areaId')) patch.areaId = requireOpaqueId(fields['areaId']);
  return patch;
}

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();
