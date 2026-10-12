import { WorkOrderError } from './errors.js';
import type { CostCategory, Money } from './types.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Real calendar date `YYYY-MM-DD` (rejects 2026-02-31). */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AMOUNT = /^(0|[1-9]\d{0,14})$/;
const CURRENCY = /^[A-Z]{3}$/;
const QUANTITY = /^(0|[1-9]\d{0,6})(\.\d{1,3})?$/;
const COST_CATEGORIES: readonly CostCategory[] = ['labor', 'parts', 'external_service', 'other'];
/** Vehicle statuses a closure may choose (decommissioning is a vehicle command, not a closure). */
export const CLOSURE_VEHICLE_STATUSES = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
] as const;
export const MAX_TASKS = 50;
export const MAX_PARTS = 100;
export const MAX_COSTS = 50;

export const invalid = (): never => {
  throw new WorkOrderError('invalid_input');
};

export function record(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid();
  return value;
}
export function opaqueId(value: unknown): string {
  return typeof value === 'string' && ID.test(value) ? value : invalid();
}
export function optionalId(value: unknown): string | null {
  return value === undefined || value === null ? null : opaqueId(value);
}
export function version(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
    ? (value as number)
    : invalid();
}
export function dateOnly(value: unknown): string {
  return isValidDateOnly(value) ? value : invalid();
}
export function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return invalid();
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : invalid();
}
export function optionalText(value: unknown, max: number): string | null {
  return value === undefined || value === null ? null : text(value, max);
}
export function money(value: unknown): Money {
  const data = record(value, ['amountMinor', 'currency']);
  const amountMinor = data['amountMinor'];
  const currency = data['currency'];
  if (typeof amountMinor !== 'string' || !AMOUNT.test(amountMinor)) return invalid();
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return invalid();
  return { amountMinor, currency };
}
export function quantity(value: unknown): string {
  if (typeof value !== 'string' || !QUANTITY.test(value) || Number(value) <= 0) return invalid();
  return value;
}
export function costCategory(value: unknown): CostCategory {
  return COST_CATEGORIES.includes(value as CostCategory) ? (value as CostCategory) : invalid();
}
export function list(value: unknown, max: number): readonly unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
export function kilometers(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 9_999_999
    ? (value as number)
    : invalid();
}
export function closureVehicleStatus(value: unknown): string {
  return (CLOSURE_VEHICLE_STATUSES as readonly unknown[]).includes(value)
    ? (value as string)
    : invalid();
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Calendar day `YYYY-MM-DD` of an instant in an IANA zone (the tenant's); UTC when no zone is given. */
export function calendarDay(instant: Date, timeZone = 'UTC'): string {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}
