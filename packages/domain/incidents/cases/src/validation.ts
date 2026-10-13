import { IncidentError, type FieldIssue, type FieldIssueCode } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Collects field problems so one 400 names every bad field; values are never kept. */
export class Issues {
  private readonly found: FieldIssue[] = [];
  public add(field: string, code: FieldIssueCode): undefined {
    if (!this.found.some((issue) => issue.field === field && issue.code === code))
      this.found.push({ field, code });
    return undefined;
  }
  public get any(): boolean {
    return this.found.length > 0;
  }
  public throwIfAny(): void {
    if (this.found.length > 0) throw new IncidentError('invalid_input', [...this.found]);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object itself, with unknown keys reported by name (names that are not plain identifiers are masked). */
export function objectOf(
  input: unknown,
  allowed: readonly string[],
  issues: Issues,
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    issues.add('body', 'invalid');
    issues.throwIfAny();
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) issues.add(FIELD_NAME.test(key) ? key : 'body', 'unknown_property');
  return value;
}

export const present = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key) && value[key] !== undefined;

export function opaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

export function idField(
  issues: Issues,
  field: string,
  value: unknown,
  nullable = false,
): string | null | undefined {
  if (value === null && nullable) return null;
  return opaqueId(value) ?? issues.add(field, 'invalid');
}

export function textField(
  issues: Issues,
  field: string,
  value: unknown,
  max: number,
  nullable = true,
): string | null | undefined {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') return issues.add(field, 'invalid');
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed))
    return issues.add(field, 'invalid');
  return trimmed;
}

export function enumField<T extends string>(
  issues: Issues,
  field: string,
  value: unknown,
  allowed: readonly T[],
  nullable = false,
): T | null | undefined {
  if (value === null && nullable) return null;
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : issues.add(field, 'invalid');
}

export function booleanField(
  issues: Issues,
  field: string,
  value: unknown,
): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === 'boolean' ? value : issues.add(field, 'invalid');
}

export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A UTC instant `YYYY-MM-DDTHH:mm:ss(.sss)Z`, normalized to milliseconds. */
export function instantField(
  issues: Issues,
  field: string,
  value: unknown,
  nullable = true,
): string | null | undefined {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !INSTANT.test(value)) return issues.add(field, 'invalid');
  const parsed = new Date(value);
  // Date silently rolls 2026-02-30 over to March: the day must survive the round trip.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
    ? parsed.toISOString()
    : issues.add(field, 'invalid');
}

export function versionField(issues: Issues, value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
    ? (value as number)
    : issues.add('version', 'invalid');
}
