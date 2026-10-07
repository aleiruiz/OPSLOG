import { MAX_RESPONSIBLES } from './types.js';
import { AreaError } from './errors.js';

export const invalid = (): never => {
  throw new AreaError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,80}$/u;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

export const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const requireVersion = (value: unknown): number =>
  isInteger(value, 1, 2_147_483_646) ? value : invalid();

/** Display form of a name: trimmed, inner whitespace collapsed, original case. */
export function normalizeName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return NAME.test(text) ? text : invalid();
}

/** Uniqueness key of a name among siblings: case-insensitive. */
export const nameKey = (name: string): string => name.toLowerCase();

/** Codes are stored upper case, so the code itself is its uniqueness key. `null` clears it. */
export function normalizeCode(value: unknown): string | null {
  if (value === null) return null;
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return CODE.test(text) ? text : invalid();
}

/** A set of user ids: sorted, deduplicated, at most `MAX_RESPONSIBLES`. */
export function normalizeResponsibles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return invalid();
  const ids = [...new Set(value.map((id: unknown) => requireOpaqueId(id)))].sort();
  return ids.length <= MAX_RESPONSIBLES ? ids : invalid();
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(input: unknown): Fields {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const record = input as Fields;
  return Object.keys(record).some((key) => !FIELDS.includes(key)) ? invalid() : record;
}

const FIELDS: readonly string[] = ['name', 'code', 'parentId', 'responsibleIds'];
export const AREA_INPUT_FIELDS = FIELDS;

export interface NewAreaData {
  readonly name: string;
  readonly code: string | null;
  readonly parentId: string | null;
  readonly responsibleIds: readonly string[];
}
export type AreaPatch = { -readonly [K in keyof NewAreaData]?: NewAreaData[K] };

export const parentOf = (value: unknown): string | null =>
  value === null ? null : requireOpaqueId(value);

/** Validates and normalizes the data of a new area. Unknown properties are rejected. */
export function parseNewArea(input: unknown): NewAreaData {
  const fields = asFields(input);
  if (!Object.hasOwn(fields, 'name')) return invalid();
  return {
    name: normalizeName(fields['name']),
    code: Object.hasOwn(fields, 'code') ? normalizeCode(fields['code']) : null,
    parentId: Object.hasOwn(fields, 'parentId') ? parentOf(fields['parentId']) : null,
    responsibleIds: Object.hasOwn(fields, 'responsibleIds')
      ? normalizeResponsibles(fields['responsibleIds'])
      : [],
  };
}

/** Validates a partial update; only the fields that are present are returned. */
export function parseAreaPatch(input: unknown): AreaPatch {
  const fields = asFields(input);
  if (Object.keys(fields).length === 0) return invalid();
  const patch: AreaPatch = {};
  if (Object.hasOwn(fields, 'name')) patch.name = normalizeName(fields['name']);
  if (Object.hasOwn(fields, 'code')) patch.code = normalizeCode(fields['code']);
  if (Object.hasOwn(fields, 'parentId')) patch.parentId = parentOf(fields['parentId']);
  if (Object.hasOwn(fields, 'responsibleIds'))
    patch.responsibleIds = normalizeResponsibles(fields['responsibleIds']);
  return patch;
}
