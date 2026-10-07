import type { ApiError } from '@opslog/contracts';
import { demoAreas } from '../areas/fixtures';
import {
  CODE,
  MAX_RESPONSIBLES,
  NAME,
  OPAQUE_ID,
  normalizeCode,
  normalizeName,
} from '../areas/rules';
import type { Area, AreaHistoryEntry, Page, Result } from './types';

let correlation = 0;

export function failure(
  status: ApiError['status'],
  code: string,
  message: string,
  field?: string,
): Result<never> {
  correlation += 1;
  return {
    ok: false,
    error: {
      code,
      status,
      message,
      correlationId: `corr-mock-area-${correlation}`,
      ...(field === undefined ? {} : { fieldErrors: [{ field, code, message }] }),
    },
  };
}
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const badRequest = () => failure(400, 'bad_request', 'Invalid request');
export const notFound = () => failure(404, 'not_found', 'Resource not found');
export const conflict = (code: 'stale_version' | 'immutable' | 'invalid_transition') =>
  failure(409, code, 'Conflict');
export const hierarchy = () => failure(422, 'invalid_hierarchy', 'Unprocessable request');

export const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

export type Fields = Partial<Pick<Area, 'name' | 'code' | 'parentId' | 'responsibleIds'>>;

/** Validates and normalizes the fields that are present; `null` when anything is invalid. */
export function parseFields(input: Readonly<Record<string, unknown>>): Fields | null {
  const out: { -readonly [K in keyof Fields]?: Fields[K] } = {};
  const has = (key: string) => Object.hasOwn(input, key);
  if (
    Object.keys(input).some((key) => !['name', 'code', 'parentId', 'responsibleIds'].includes(key))
  )
    return null;
  if (has('name')) {
    const value = input['name'];
    if (typeof value !== 'string' || !NAME.test(normalizeName(value))) return null;
    out.name = normalizeName(value);
  }
  if (has('code')) {
    const value = input['code'];
    if (value === null) out.code = null;
    else if (typeof value !== 'string' || !CODE.test(normalizeCode(value))) return null;
    else out.code = normalizeCode(value);
  }
  if (has('parentId')) {
    const value = input['parentId'];
    if (value === null) out.parentId = null;
    else if (typeof value !== 'string' || !OPAQUE_ID.test(value)) return null;
    else out.parentId = value;
  }
  if (has('responsibleIds')) {
    const value = input['responsibleIds'];
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && OPAQUE_ID.test(id)))
      return null;
    const ids = [...new Set(value as string[])].sort();
    if (ids.length > MAX_RESPONSIBLES) return null;
    out.responsibleIds = ids;
  }
  return out;
}

export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The demo tree, with a long history on "Norte" so the history needs a second page. */
export const demoMockAreas = (): Area[] =>
  demoAreas().map((area) => (area.id === 'area-norte' ? { ...area, version: 28 } : area));

export const page = <T>(
  items: readonly T[],
  limit: number,
  offset: number,
  field: string,
): Page<T> => {
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? `mock:${next}` : null,
    total: items.length,
    sort: { field, direction: field === 'name' ? 'asc' : 'desc' },
  };
};
export const pageWindow = (query: { limit?: number; cursor?: string }) => {
  const limit = query.limit ?? 25;
  const offset = query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
  return [25, 50, 100].includes(limit) && Number.isSafeInteger(offset) ? { limit, offset } : null;
};

export const duplicate = (field: string) => failure(409, 'duplicate', 'Conflict', field);

/** Name among siblings (case-insensitive) or code (company-wide) already taken by another area. */
export const findCollision = (
  rows: readonly Area[],
  candidate: Fields,
  parentId: string | null,
  exceptId: string | null,
) => {
  for (const other of rows) {
    if (other.id === exceptId) continue;
    if (
      candidate.name !== undefined &&
      other.parentId === parentId &&
      other.name.toLowerCase() === candidate.name.toLowerCase()
    )
      return 'name';
    if (candidate.code && other.code === candidate.code) return 'code';
  }
  return null;
};

/** Builds the history every seeded area starts with; `nextId` numbers the entries. */
export function seedHistory(
  rows: readonly Area[],
  nextId: () => string,
): Map<string, AreaHistoryEntry[]> {
  // Every area starts with a believable history: created, then edits, ending with its current state.
  const history = new Map<string, AreaHistoryEntry[]>();
  for (const area of rows) {
    const entries: AreaHistoryEntry[] = [];
    for (let version = 1; version <= area.version; version += 1) {
      const last = version === area.version;
      entries.push({
        id: nextId(),
        action: version === 1 ? 'created' : last && !area.active ? 'deactivated' : 'updated',
        fields: version === 1 || (last && !area.active) ? [] : ['name'],
        fromParentId: version === 1 ? null : area.parentId,
        toParentId: area.parentId,
        actorId: 'user-admin',
        version,
        at: version === area.version ? area.updatedAt : area.createdAt,
      });
    }
    history.set(area.id, entries);
  }
  return history;
}
