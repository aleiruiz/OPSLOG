import type { ApiError } from '@opslog/contracts';
import { demoAreas } from '../areas/fixtures';
import {
  CODE,
  MAX_AREA_DEPTH,
  MAX_RESPONSIBLES,
  NAME,
  OPAQUE_ID,
  normalizeCode,
  normalizeName,
} from '../areas/rules';
import type {
  Area,
  AreaDetail,
  AreaHistoryEntry,
  AreaHistoryQuery,
  AreaInput,
  AreaListQuery,
  AreaPatch,
  AreasPort,
  Page,
  Result,
} from './types';

/**
 * In-memory areas with the semantics of the real backend (`packages/domain/areas`): a tree of at most four
 * levels, optimistic versions (409 `stale_version`), read-only inactive areas (409 `immutable`), sibling-name and
 * company-wide code uniqueness (409 `duplicate` with the colliding field), 409 `area_in_use` when deactivating an
 * area with active sub-areas, vehicles or people, 422 `invalid_hierarchy` (cycle, depth, inactive or unknown
 * parent), 422 `invalid_responsible`, a history without names and a uniform 400/404. Permissions are enforced by the
 * caller (`mockApi`).
 */
export interface MockAreaStore {
  readonly port: AreasPort;
  /** Another actor renames the area on the server: its version moves on, so a form that loaded it is stale. */
  changeExternally(id: string, change: Partial<Pick<Area, 'name'>>): void;
  /** Another actor deactivates the area on the server (no rule checks: a test control). */
  deactivateExternally(id: string): void;
  /** Sets how many active people the (not yet built) personnel module would report for the area. */
  setPeople(id: string, people: number): void;
  snapshot(): readonly Area[];
}

export interface MockAreaEnvironment {
  /** Active vehicles of an area (the fleet decides). */
  readonly liveVehicles: (areaId: string) => number;
  /** Whether the user is an active member of the company. */
  readonly isMember: (userId: string) => boolean;
  /** The signed-in user, recorded in the history. */
  readonly actorId: () => string;
}

const NOW = '2026-10-06T12:00:00.000Z';
let correlation = 0;

function failure(
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
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const badRequest = () => failure(400, 'bad_request', 'Invalid request');
const notFound = () => failure(404, 'not_found', 'Resource not found');
const conflict = (code: 'stale_version' | 'immutable' | 'invalid_transition') =>
  failure(409, code, 'Conflict');
const hierarchy = () => failure(422, 'invalid_hierarchy', 'Unprocessable request');

const validVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_646;

type Fields = Partial<Pick<Area, 'name' | 'code' | 'parentId' | 'responsibleIds'>>;

/** Validates and normalizes the fields that are present; `null` when anything is invalid. */
function parseFields(input: Readonly<Record<string, unknown>>): Fields | null {
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

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The demo tree, with a long history on "Norte" so the history needs a second page. */
export const demoMockAreas = (): Area[] =>
  demoAreas().map((area) => (area.id === 'area-norte' ? { ...area, version: 28 } : area));

export function createMockAreaStore(
  env: MockAreaEnvironment,
  seed: readonly Area[] = demoMockAreas(),
  now: () => string = () => NOW,
): MockAreaStore {
  let rows: Area[] = seed.map((area) => ({ ...area }));
  const people = new Map<string, number>();
  let sequence = rows.length;
  let historySequence = 0;

  const entry = (
    area: Area,
    action: AreaHistoryEntry['action'],
    fields: AreaHistoryEntry['fields'],
    from: string | null,
    to: string | null,
    actorId: string,
  ): AreaHistoryEntry => {
    historySequence += 1;
    return {
      id: `hist-mock-${historySequence}`,
      action,
      fields,
      fromParentId: from,
      toParentId: to,
      actorId,
      version: area.version,
      at: now(),
    };
  };
  // Every area starts with a believable history: created, then edits, ending with its current state.
  const history = new Map<string, AreaHistoryEntry[]>();
  for (const area of rows) {
    const entries: AreaHistoryEntry[] = [];
    for (let version = 1; version <= area.version; version += 1) {
      const last = version === area.version;
      historySequence += 1;
      entries.push({
        id: `hist-mock-${historySequence}`,
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

  const find = (id: string) => rows.find((area) => area.id === id);
  const replace = (next: Area) => {
    rows = rows.map((area) => (area.id === next.id ? next : area));
    return next;
  };
  const childrenOf = (id: string) => rows.filter((area) => area.parentId === id);
  const subtree = (id: string): Area[] =>
    childrenOf(id).flatMap((child) => [child, ...subtree(child.id)]);
  const record = (area: Area, item: AreaHistoryEntry) =>
    history.set(area.id, [...(history.get(area.id) ?? []), item]);
  const duplicate = (field: string) => failure(409, 'duplicate', 'Conflict', field);

  /** Name among siblings (case-insensitive) or code (company-wide) already taken by another area. */
  const collision = (candidate: Fields, parentId: string | null, exceptId: string | null) => {
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
  const strangers = (ids: readonly string[], known: readonly string[] = []) =>
    ids.some((id) => !known.includes(id) && !env.isMember(id));

  const detail = (area: Area): AreaDetail => ({
    ...area,
    resourceCounts: { vehicles: env.liveVehicles(area.id), people: people.get(area.id) ?? 0 },
  });
  const page = <T>(items: readonly T[], limit: number, offset: number, field: string): Page<T> => {
    const next = offset + limit;
    return {
      items: items.slice(offset, next),
      nextCursor: next < items.length ? `mock:${next}` : null,
      total: items.length,
      sort: { field, direction: field === 'name' ? 'asc' : 'desc' },
    };
  };
  const window = (query: { limit?: number; cursor?: string }) => {
    const limit = query.limit ?? 25;
    const offset = query.cursor === undefined ? 0 : Number(/^mock:(\d+)$/.exec(query.cursor)?.[1]);
    return [25, 50, 100].includes(limit) && Number.isSafeInteger(offset) ? { limit, offset } : null;
  };

  const port: AreasPort = {
    list: async (query: AreaListQuery = {}) => {
      const slice = window(query);
      if (
        !slice ||
        (query.parentId !== undefined &&
          query.parentId !== 'root' &&
          !OPAQUE_ID.test(query.parentId)) ||
        (query.includeInactive !== undefined && !['true', 'false'].includes(query.includeInactive))
      )
        return badRequest();
      const matches = rows
        .filter(
          (area) =>
            (query.includeInactive === 'true' || area.active) &&
            (query.parentId === undefined ||
              area.parentId === (query.parentId === 'root' ? null : query.parentId)),
        )
        .sort(
          (a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
        )
        .map((area) => ({ ...area }));
      return ok(page(matches, slice.limit, slice.offset, 'name'));
    },
    get: async (id) => {
      const found = find(id);
      return found ? ok(detail(found)) : notFound();
    },
    create: async (input: AreaInput) => {
      const fields = input as unknown as Readonly<Record<string, unknown>>;
      const parsed = parseFields(fields);
      if (parsed === null || !Object.hasOwn(fields, 'name')) return badRequest();
      const parentId = parsed.parentId ?? null;
      const parent = parentId === null ? undefined : find(parentId);
      if (parentId !== null && (!parent || !parent.active || parent.depth >= MAX_AREA_DEPTH))
        return hierarchy();
      const responsibleIds = parsed.responsibleIds ?? [];
      if (strangers(responsibleIds))
        return failure(422, 'invalid_responsible', 'Unprocessable request');
      const clash = collision(parsed, parentId, null);
      if (clash) return duplicate(clash);
      sequence += 1;
      const area: Area = {
        id: `area-nueva-${sequence}`,
        name: parsed.name as string,
        code: parsed.code ?? null,
        parentId,
        depth: (parent?.depth ?? 0) + 1,
        active: true,
        responsibleIds,
        version: 1,
        createdAt: now(),
        updatedAt: now(),
        deactivatedAt: null,
      };
      rows = [...rows, area];
      history.set(area.id, [entry(area, 'created', [], null, parentId, env.actorId())]);
      return ok({ ...area });
    },
    update: async (id, patch: AreaPatch) => {
      const { version, ...rest } = patch as unknown as Record<string, unknown>;
      const parsed = parseFields(rest);
      if (!validVersion(version) || parsed === null || Object.keys(rest).length === 0)
        return badRequest();
      const current = find(id);
      if (!current) return notFound();
      if (!current.active) return conflict('immutable');
      if (current.version !== version) return conflict('stale_version');
      const fields: AreaHistoryEntry['fields'][number][] = [];
      if (parsed.name !== undefined && parsed.name !== current.name) fields.push('name');
      if (parsed.code !== undefined && parsed.code !== current.code) fields.push('code');
      if (parsed.parentId !== undefined && parsed.parentId !== current.parentId)
        fields.push('parent');
      if (
        parsed.responsibleIds !== undefined &&
        !sameIds(parsed.responsibleIds, current.responsibleIds)
      )
        fields.push('responsibles');
      if (fields.length === 0) return ok({ ...current });

      let depth = current.depth;
      const below = subtree(current.id);
      const parentId = fields.includes('parent') ? (parsed.parentId ?? null) : current.parentId;
      if (fields.includes('parent')) {
        const parent = parentId === null ? undefined : find(parentId);
        if (parentId !== null && !parent) return hierarchy();
        if (parentId === current.id || below.some((node) => node.id === parentId))
          return hierarchy();
        if (parent && !parent.active) return hierarchy();
        const height = below.reduce(
          (deepest, node) => Math.max(deepest, node.depth),
          current.depth,
        );
        depth = (parent?.depth ?? 0) + 1;
        if (height - current.depth + depth > MAX_AREA_DEPTH) return hierarchy();
      }
      if (
        fields.includes('responsibles') &&
        strangers(parsed.responsibleIds as string[], current.responsibleIds)
      )
        return failure(422, 'invalid_responsible', 'Unprocessable request');
      const clash = collision(
        {
          ...(fields.includes('name') || fields.includes('parent')
            ? { name: parsed.name ?? current.name }
            : {}),
          ...(fields.includes('code') && parsed.code ? { code: parsed.code } : {}),
        },
        parentId,
        current.id,
      );
      if (clash) return duplicate(clash);

      const next: Area = {
        ...current,
        ...(fields.includes('name') ? { name: parsed.name as string } : {}),
        ...(fields.includes('code') ? { code: parsed.code ?? null } : {}),
        ...(fields.includes('responsibles')
          ? { responsibleIds: parsed.responsibleIds as string[] }
          : {}),
        parentId,
        depth,
        version: current.version + 1,
        updatedAt: now(),
      };
      replace(next);
      const shift = depth - current.depth;
      if (shift !== 0) for (const node of below) replace({ ...node, depth: node.depth + shift });
      record(next, entry(next, 'updated', fields, current.parentId, parentId, env.actorId()));
      return ok({ ...next });
    },
    deactivate: async (id, version) => {
      const current = find(id);
      if (!current) return notFound();
      if (!validVersion(version)) return badRequest();
      if (current.version !== version) return conflict('stale_version');
      if (!current.active) return conflict('invalid_transition');
      if (childrenOf(id).some((child) => child.active))
        return failure(409, 'area_in_use', 'Conflict', 'sub_areas');
      if (env.liveVehicles(id) > 0) return failure(409, 'area_in_use', 'Conflict', 'vehicles');
      if ((people.get(id) ?? 0) > 0) return failure(409, 'area_in_use', 'Conflict', 'people');
      const next = replace({
        ...current,
        active: false,
        deactivatedAt: now(),
        version: current.version + 1,
        updatedAt: now(),
      });
      record(next, entry(next, 'deactivated', [], next.parentId, next.parentId, env.actorId()));
      return ok({ ...next });
    },
    activate: async (id, version) => {
      const current = find(id);
      if (!current) return notFound();
      if (!validVersion(version)) return badRequest();
      if (current.version !== version) return conflict('stale_version');
      if (current.active) return conflict('invalid_transition');
      const parent = current.parentId === null ? undefined : find(current.parentId);
      if (current.parentId !== null && !parent?.active) return hierarchy();
      const next = replace({
        ...current,
        active: true,
        deactivatedAt: null,
        version: current.version + 1,
        updatedAt: now(),
      });
      record(next, entry(next, 'activated', [], next.parentId, next.parentId, env.actorId()));
      return ok({ ...next });
    },
    history: async (id, query: AreaHistoryQuery = {}) => {
      const slice = window(query);
      if (!slice) return badRequest();
      if (!find(id)) return notFound();
      const entries = [...(history.get(id) ?? [])].sort((a, b) => b.version - a.version);
      return ok(page(entries, slice.limit, slice.offset, 'version'));
    },
  };

  return {
    port,
    changeExternally: (id, change) => {
      const current = find(id);
      if (current)
        record(
          replace({ ...current, ...change, version: current.version + 1, updatedAt: now() }),
          entry(
            { ...current, version: current.version + 1 },
            'updated',
            ['name'],
            current.parentId,
            current.parentId,
            'user-dispatch',
          ),
        );
    },
    deactivateExternally: (id) => {
      const current = find(id);
      if (current)
        replace({
          ...current,
          active: false,
          deactivatedAt: now(),
          version: current.version + 1,
          updatedAt: now(),
        });
    },
    setPeople: (id, count) => {
      people.set(id, count);
    },
    snapshot: () => rows.map((area) => ({ ...area })),
  };
}
