import { randomUUID } from 'node:crypto';

/**
 * Areas (BRD §7.2.3, FR-040..042, BR-009, BR-021): the organizational tree of a company, up to
 * four levels deep. This package holds the pure rules, the persistence port with an in-memory
 * double, and the use cases. Authentication, permissions and audit belong to the composition.
 */

/** Level of a root area is 1; the deepest allowed level is 4 (FR-040). */
export const MAX_AREA_DEPTH = 4;
export const MAX_RESPONSIBLES = 20;
export const MAX_NAME_LENGTH = 80;
export const MAX_CODE_LENGTH = 32;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 25;

export type AreaErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  /** Activating an active area or deactivating an inactive one. */
  | 'invalid_transition'
  /** An inactive area is read-only until it is activated again. */
  | 'immutable'
  /** Cycle, more than four levels, or a parent that is unknown (or of another tenant) or inactive. */
  | 'invalid_hierarchy'
  /** A responsible user that is not an active member of the tenant. */
  | 'invalid_responsible'
  /** BR-021: the area still holds active sub-areas, vehicles or people. */
  | 'area_in_use';

/** Which key collided (`duplicate`) or which kind of resource blocks (`area_in_use`). Never a value. */
export type AreaConflictField = 'name' | 'code' | 'sub_areas' | 'vehicles' | 'people';

export class AreaError extends Error {
  public constructor(
    public readonly code: AreaErrorCode,
    public readonly field?: AreaConflictField,
  ) {
    super(`Area request rejected: ${code}`);
    this.name = 'AreaError';
  }
}

export interface Area {
  readonly id: string;
  /** Company (tenant) that owns the row. Never taken from caller input. */
  readonly tenantId: string;
  readonly name: string;
  /** Optional short code, upper case; unique per company. */
  readonly code: string | null;
  readonly parentId: string | null;
  /** Level in the tree: 1 for a root, at most `MAX_AREA_DEPTH`. */
  readonly depth: number;
  /** BRD `activa`. Deactivation is the soft delete of BR-009: rows are never removed. */
  readonly active: boolean;
  /** Responsible users (FR-041): opaque user ids, sorted, no duplicates. */
  readonly responsibleIds: readonly string[];
  /** Optimistic concurrency token: starts at 1, +1 on every change. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt: string | null;
}

/** What the tree traversals need of a row. */
export type AreaNode = Pick<Area, 'id' | 'depth' | 'active'>;

export const AREA_ACTIONS = ['created', 'updated', 'activated', 'deactivated'] as const;
export type AreaAction = (typeof AREA_ACTIONS)[number];
export const AREA_FIELDS = ['name', 'code', 'parent', 'responsibles'] as const;
export type AreaField = (typeof AREA_FIELDS)[number];

export const isAreaAction = (value: unknown): value is AreaAction =>
  typeof value === 'string' && (AREA_ACTIONS as readonly string[]).includes(value);
export const isAreaField = (value: unknown): value is AreaField =>
  typeof value === 'string' && (AREA_FIELDS as readonly string[]).includes(value);

/**
 * One row of the area history (BRD §7.2.3: changes are recorded). Who, when and what changed, by
 * field name only: no names, codes or user ids, so the history holds no personal data. A parent
 * change also records the two parent ids (opaque area ids).
 */
export interface AreaHistoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly areaId: string;
  readonly action: AreaAction;
  readonly fields: readonly AreaField[];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  /** Version the area had right after this change: orders the history, unique per area. */
  readonly version: number;
  readonly at: string;
}

const invalid = (): never => {
  throw new AreaError('invalid_input');
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,80}$/u;

export const requireOpaqueId = (value: unknown): string =>
  typeof value === 'string' && OPAQUE_ID.test(value) ? value : invalid();

const isInteger = (value: unknown, min: number, max: number): value is number =>
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

const parentOf = (value: unknown): string | null =>
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

// ---- pure rules -------------------------------------------------------------------------------

/**
 * Checks a placement of a node (new or moved) under `parent` (null: a root) and returns its depth.
 * `height` is the number of levels below the node (0 for a leaf). The parent must be active; a
 * placement that would exceed `MAX_AREA_DEPTH` including the node's subtree is rejected.
 */
export function placementDepth(parent: AreaNode | null, height: number): number {
  if (parent !== null && !parent.active) throw new AreaError('invalid_hierarchy');
  const depth = (parent?.depth ?? 0) + 1;
  if (depth + height > MAX_AREA_DEPTH) throw new AreaError('invalid_hierarchy');
  return depth;
}

export function newArea(
  tenantId: string,
  id: string,
  data: NewAreaData,
  depth: number,
  now: Date,
): Area {
  return {
    id,
    tenantId,
    name: data.name,
    code: data.code,
    parentId: data.parentId,
    depth,
    active: true,
    responsibleIds: data.responsibleIds,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deactivatedAt: null,
  };
}

export function historyEntry(
  area: Area,
  action: AreaAction,
  fields: readonly AreaField[],
  parents: { readonly from: string | null; readonly to: string | null },
  id: string,
  actorId: string,
  now: Date,
): AreaHistoryEntry {
  return {
    id,
    tenantId: area.tenantId,
    areaId: area.id,
    action,
    fields,
    fromParentId: parents.from,
    toParentId: parents.to,
    actorId,
    version: area.version,
    at: now.toISOString(),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** The fields of `patch` whose value differs from the area, in a fixed order. */
export function changedFields(area: Area, patch: AreaPatch): readonly AreaField[] {
  const changed: AreaField[] = [];
  if (patch.name !== undefined && patch.name !== area.name) changed.push('name');
  if (patch.code !== undefined && patch.code !== area.code) changed.push('code');
  if (patch.parentId !== undefined && patch.parentId !== area.parentId) changed.push('parent');
  if (patch.responsibleIds !== undefined && !sameSet(patch.responsibleIds, area.responsibleIds))
    changed.push('responsibles');
  return changed;
}

const touched = (area: Area, now: Date): Pick<Area, 'version' | 'updatedAt'> => ({
  version: area.version + 1,
  updatedAt: now.toISOString(),
});

function assertVersion(area: Area, expectedVersion: number): void {
  if (area.version !== expectedVersion) throw new AreaError('stale_version');
}

/** Applies the changed fields; the new depth is computed by the caller from the placement. */
export function applyPatch(
  area: Area,
  patch: AreaPatch,
  depth: number,
  expectedVersion: number,
  now: Date,
): Area {
  if (!area.active) throw new AreaError('immutable');
  assertVersion(area, expectedVersion);
  return {
    ...area,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.code === undefined ? {} : { code: patch.code }),
    ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
    ...(patch.responsibleIds === undefined ? {} : { responsibleIds: patch.responsibleIds }),
    depth,
    ...touched(area, now),
  };
}

export function applyActive(area: Area, active: boolean, expectedVersion: number, now: Date): Area {
  assertVersion(area, expectedVersion);
  if (area.active === active) throw new AreaError('invalid_transition');
  return {
    ...area,
    active,
    deactivatedAt: active ? null : now.toISOString(),
    ...touched(area, now),
  };
}

// ---- ports -----------------------------------------------------------------------------------

export interface AreaFilter {
  /** `undefined`: every level; `null`: roots only; an id: the direct children of that area. */
  readonly parentId?: string | null;
  readonly includeInactive: boolean;
}
export interface AreaWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface AreaSlice {
  readonly items: readonly Area[];
  /** Number of areas matching the filter, not only the window. */
  readonly total: number;
}
export interface AreaHistorySlice {
  readonly items: readonly AreaHistoryEntry[];
  readonly total: number;
}

/**
 * Reads and writes inside one tenant-serialized transaction. Every method is tenant-scoped: an
 * area of another tenant is simply absent.
 */
export interface AreaTx {
  find(id: string): Promise<Area | null>;
  /** Direct children (any status) of an area, or the roots when `parentId` is null. */
  children(parentId: string | null): Promise<readonly AreaNode[]>;
  /**
   * Inserts the area (with its responsibles) and its history row. Throws
   * `AreaError('duplicate', 'name' | 'code')` when a sibling name or a code is already taken.
   */
  insert(area: Area, entry: AreaHistoryEntry): Promise<void>;
  /**
   * Conditional write: replaces the area (and its responsibles) and appends the history row only
   * while the stored version is `expectedVersion`; false otherwise. Duplicates throw as `insert`.
   */
  replace(next: Area, expectedVersion: number, entry: AreaHistoryEntry): Promise<boolean>;
  /** Rewrites the depth of a descendant after its subtree moved (no version change, no history). */
  setDepth(id: string, depth: number): Promise<void>;
}

/**
 * Persistence port. `transaction` serializes every hierarchy-changing use case of one tenant (a
 * cycle or a fifth level can be created by two concurrent writes that are each valid alone), so
 * the invariants are checked and written under one tenant lock. Reads outside a transaction see
 * committed state.
 */
export interface AreaStore {
  transaction<T>(tenantId: string, work: (tx: AreaTx) => Promise<T>): Promise<T>;
  find(tenantId: string, id: string): Promise<Area | null>;
  /** Ordered by name (case-insensitive), then id. */
  list(tenantId: string, filter: AreaFilter, window: AreaWindow): Promise<AreaSlice>;
  /** Newest change first (by version, descending). */
  history(tenantId: string, areaId: string, window: AreaWindow): Promise<AreaHistorySlice>;
}

/** BR-021 count port: how many active resources of one kind sit in an area. */
export interface AreaResourceCounter {
  countActive(tenantId: string, areaId: string): Promise<number>;
}
export type AreaResource = 'vehicles' | 'people';
export type AreaResourceCounters = Readonly<Record<AreaResource, AreaResourceCounter>>;
export const AREA_RESOURCES: readonly AreaResource[] = ['vehicles', 'people'];

/** Placeholder for people until the employees module exists: no person is ever assigned. */
export const NO_RESOURCES: AreaResourceCounter = { countActive: async () => 0 };

/**
 * Port to the tenant's membership directory (FR-041): responsible users must be active members.
 * Without it the service stores opaque ids unchecked.
 */
export interface AreaMemberDirectory {
  isActiveMember(tenantId: string, userId: string): Promise<boolean>;
}

// ---- in-memory store -------------------------------------------------------------------------

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const storeKey = (tenantId: string, id: string): string =>
  `${tenantId.length}:${tenantId}${id.length}:${id}`;

/**
 * In-memory double of the port. Transactions of one tenant run one after another and are rolled
 * back on failure, like the MySQL adapter; the other methods are synchronous inside.
 */
export class InMemoryAreaStore implements AreaStore {
  private areas = new Map<string, Area>();
  private entries: AreaHistoryEntry[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();

  private conflict(candidate: Area): AreaConflictField | null {
    for (const other of this.areas.values()) {
      if (other.tenantId !== candidate.tenantId || other.id === candidate.id) continue;
      if (other.parentId === candidate.parentId && nameKey(other.name) === nameKey(candidate.name))
        return 'name';
      if (candidate.code !== null && other.code === candidate.code) return 'code';
    }
    return null;
  }

  public async transaction<T>(tenantId: string, work: (tx: AreaTx) => Promise<T>): Promise<T> {
    const previous = this.tails.get(tenantId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const snapshot = { areas: new Map(this.areas), entries: [...this.entries] };
        try {
          return await work(this.tx(tenantId));
        } catch (error) {
          this.areas = snapshot.areas;
          this.entries = snapshot.entries;
          throw error;
        }
      });
    const tail = run.catch(() => undefined);
    this.tails.set(tenantId, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(tenantId) === tail) this.tails.delete(tenantId);
    }
  }

  private tx(tenantId: string): AreaTx {
    return {
      find: async (id) => this.find(tenantId, id),
      children: async (parentId) =>
        [...this.areas.values()]
          .filter((area) => area.tenantId === tenantId && area.parentId === parentId)
          .map(({ id, depth, active }) => ({ id, depth, active })),
      insert: async (area, entry) => {
        if (area.tenantId !== tenantId || this.areas.has(storeKey(tenantId, area.id)))
          throw new AreaError('duplicate');
        const field = this.conflict(area);
        if (field) throw new AreaError('duplicate', field);
        this.areas.set(storeKey(tenantId, area.id), structuredClone(area));
        this.entries.push(structuredClone(entry));
      },
      replace: async (next, expectedVersion, entry) => {
        const key = storeKey(tenantId, next.id);
        const current = this.areas.get(key);
        if (next.tenantId !== tenantId || current?.version !== expectedVersion) return false;
        const field = this.conflict(next);
        if (field) throw new AreaError('duplicate', field);
        this.areas.set(key, structuredClone(next));
        this.entries.push(structuredClone(entry));
        return true;
      },
      setDepth: async (id, depth) => {
        const key = storeKey(tenantId, id);
        const current = this.areas.get(key);
        if (current) this.areas.set(key, { ...current, depth });
      },
    };
  }

  public async find(tenantId: string, id: string): Promise<Area | null> {
    const found = this.areas.get(storeKey(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  public async list(tenantId: string, filter: AreaFilter, window: AreaWindow): Promise<AreaSlice> {
    const matching = [...this.areas.values()]
      .filter(
        (area) =>
          area.tenantId === tenantId &&
          (filter.includeInactive || area.active) &&
          (filter.parentId === undefined || area.parentId === filter.parentId),
      )
      .sort((a, b) => compareKeys(nameKey(a.name), nameKey(b.name)) || compareKeys(a.id, b.id));
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((a) => structuredClone(a)),
      total: matching.length,
    };
  }

  public async history(
    tenantId: string,
    areaId: string,
    window: AreaWindow,
  ): Promise<AreaHistorySlice> {
    const matching = this.entries
      .filter((entry) => entry.tenantId === tenantId && entry.areaId === areaId)
      .sort((a, b) => b.version - a.version);
    return {
      items: matching
        .slice(window.offset, window.offset + window.limit)
        .map((e) => structuredClone(e)),
      total: matching.length,
    };
  }
}

// ---- service ---------------------------------------------------------------------------------

export interface AreaListQuery {
  readonly parentId?: unknown;
  readonly includeInactive?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
export interface AreaHistoryQuery {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

/** Result of an edit: the stored area and the fields that really changed (empty: a no-op). */
export interface AreaUpdate {
  readonly area: Area;
  readonly fields: readonly AreaField[];
}

export interface AreaServiceOptions {
  /** Counters of the resources that block deactivation (BR-021). Required: nothing is assumed. */
  readonly resources: AreaResourceCounters;
  readonly members?: AreaMemberDirectory;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function window(query: AreaHistoryQuery): AreaWindow {
  const limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!isInteger(limit, 1, MAX_LIST_LIMIT) || !isInteger(offset, 0, 1_000_000)) return invalid();
  return { limit, offset };
}

/**
 * Area use cases over the store port. Authorization, authentication and audit belong to the caller
 * (the composition); this class enforces the domain rules. The tenant is always an argument taken
 * from the server-side session, never part of the input being validated.
 *
 * Hierarchy rules (checked under the tenant lock, so concurrent writes cannot jointly break them):
 * no cycles, at most four levels counting the moved subtree, parents must be active. Moving an
 * area moves its whole subtree: descendants keep their parent and only their depth changes.
 */
export class AreaService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly resources: AreaResourceCounters;
  private readonly members: AreaMemberDirectory | undefined;

  public constructor(
    private readonly store: AreaStore,
    options: AreaServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.resources = options.resources;
    this.members = options.members;
  }

  private async load(tx: AreaTx, id: string): Promise<Area> {
    const area = await tx.find(id);
    if (!area) throw new AreaError('not_found');
    return area;
  }

  /** The parent of a placement: absent, unknown and foreign parents are indistinguishable. */
  private async parentNode(tx: AreaTx, parentId: string | null): Promise<Area | null> {
    if (parentId === null) return null;
    const parent = await tx.find(parentId);
    if (!parent) throw new AreaError('invalid_hierarchy');
    return parent;
  }

  private async checkResponsibles(tenantId: string, added: readonly string[]): Promise<void> {
    if (!this.members) return;
    for (const userId of added)
      if (!(await this.members.isActiveMember(tenantId, userId)))
        throw new AreaError('invalid_responsible');
  }

  /** Every descendant of `rootId` with its depth, level by level (at most `MAX_AREA_DEPTH` levels). */
  private async descendants(tx: AreaTx, rootId: string): Promise<readonly AreaNode[]> {
    const found: AreaNode[] = [];
    let level: readonly string[] = [rootId];
    while (level.length > 0) {
      const next: AreaNode[] = [];
      for (const id of level) next.push(...(await tx.children(id)));
      found.push(...next);
      level = next.map((node) => node.id);
    }
    return found;
  }

  public async create(tenantId: string, actorId: string, input: unknown): Promise<Area> {
    requireOpaqueId(tenantId);
    requireOpaqueId(actorId);
    const data = parseNewArea(input);
    const now = this.now();
    return this.store.transaction(tenantId, async (tx) => {
      const parent = await this.parentNode(tx, data.parentId);
      const depth = placementDepth(parent, 0);
      await this.checkResponsibles(tenantId, data.responsibleIds);
      const area = newArea(tenantId, this.newId(), data, depth, now);
      await tx.insert(
        area,
        historyEntry(
          area,
          'created',
          [],
          { from: null, to: area.parentId },
          this.newId(),
          actorId,
          now,
        ),
      );
      return area;
    });
  }

  public async get(tenantId: string, id: unknown): Promise<Area> {
    const area = await this.store.find(requireOpaqueId(tenantId), requireOpaqueId(id));
    if (area?.tenantId !== tenantId) throw new AreaError('not_found');
    return area;
  }

  /** Active resources of the area, by kind, for display and for the deactivation rule. */
  public async usage(
    tenantId: string,
    id: unknown,
  ): Promise<Readonly<Record<AreaResource, number>>> {
    const area = await this.get(tenantId, id);
    return this.countResources(tenantId, area.id);
  }

  private async countResources(
    tenantId: string,
    areaId: string,
  ): Promise<Readonly<Record<AreaResource, number>>> {
    return {
      vehicles: await this.resources.vehicles.countActive(tenantId, areaId),
      people: await this.resources.people.countActive(tenantId, areaId),
    };
  }

  public async list(tenantId: string, query: AreaListQuery = {}): Promise<AreaSlice> {
    requireOpaqueId(tenantId);
    if (query.includeInactive !== undefined && typeof query.includeInactive !== 'boolean')
      return invalid();
    const filter: AreaFilter = {
      includeInactive: query.includeInactive ?? false,
      ...(query.parentId === undefined ? {} : { parentId: parentOf(query.parentId) }),
    };
    return this.store.list(tenantId, filter, window(query));
  }

  /**
   * Edits name, code, parent (a move, with its whole subtree) and responsible users. When nothing
   * differs from the stored values the area is returned unchanged (no new version, no history).
   */
  public async update(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
    input: unknown,
  ): Promise<AreaUpdate> {
    requireOpaqueId(actorId);
    const patch = parseAreaPatch(input);
    const version = requireVersion(expectedVersion);
    const areaId = requireOpaqueId(id);
    requireOpaqueId(tenantId);
    const now = this.now();
    return this.store.transaction(tenantId, async (tx) => {
      const current = await this.load(tx, areaId);
      if (!current.active) throw new AreaError('immutable');
      if (current.version !== version) throw new AreaError('stale_version');
      const fields = changedFields(current, patch);
      if (fields.length === 0) return { area: current, fields };

      let depth = current.depth;
      let moved: readonly AreaNode[] = [];
      if (fields.includes('parent')) {
        const target = patch.parentId as string | null;
        const parent = await this.parentNode(tx, target);
        moved = await this.descendants(tx, current.id);
        if (target === current.id || moved.some((node) => node.id === target))
          throw new AreaError('invalid_hierarchy');
        const height = moved.reduce(
          (deepest, node) => Math.max(deepest, node.depth),
          current.depth,
        );
        depth = placementDepth(parent, height - current.depth);
      }
      if (fields.includes('responsibles'))
        await this.checkResponsibles(
          tenantId,
          (patch.responsibleIds as readonly string[]).filter(
            (u) => !current.responsibleIds.includes(u),
          ),
        );

      const next = applyPatch(current, patch, depth, version, now);
      const entry = historyEntry(
        next,
        'updated',
        fields,
        { from: current.parentId, to: next.parentId },
        this.newId(),
        actorId,
        now,
      );
      if (!(await tx.replace(next, version, entry))) throw new AreaError('stale_version');
      const shift = depth - current.depth;
      if (shift !== 0) for (const node of moved) await tx.setDepth(node.id, node.depth + shift);
      return { area: next, fields };
    });
  }

  /**
   * FR-042 / BR-021: an area with active sub-areas, active vehicles or active people cannot be
   * deactivated (`area_in_use`, naming the kind of resource, never a count). There is no cascade:
   * the resources must be reassigned or deactivated first.
   */
  public async deactivate(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
  ): Promise<Area> {
    requireOpaqueId(actorId);
    const version = requireVersion(expectedVersion);
    const areaId = requireOpaqueId(id);
    requireOpaqueId(tenantId);
    const now = this.now();
    return this.store.transaction(tenantId, async (tx) => {
      const current = await this.load(tx, areaId);
      const next = applyActive(current, false, version, now);
      if ((await tx.children(current.id)).some((child) => child.active))
        throw new AreaError('area_in_use', 'sub_areas');
      const counts = await this.countResources(tenantId, current.id);
      for (const resource of AREA_RESOURCES)
        if (counts[resource] > 0) throw new AreaError('area_in_use', resource);
      const entry = historyEntry(
        next,
        'deactivated',
        [],
        { from: current.parentId, to: current.parentId },
        this.newId(),
        actorId,
        now,
      );
      if (!(await tx.replace(next, version, entry))) throw new AreaError('stale_version');
      return next;
    });
  }

  /** Reactivates an area; its parent must be active so no active area hangs under an inactive one. */
  public async activate(
    tenantId: string,
    actorId: string,
    id: unknown,
    expectedVersion: unknown,
  ): Promise<Area> {
    requireOpaqueId(actorId);
    const version = requireVersion(expectedVersion);
    const areaId = requireOpaqueId(id);
    requireOpaqueId(tenantId);
    const now = this.now();
    return this.store.transaction(tenantId, async (tx) => {
      const current = await this.load(tx, areaId);
      const next = applyActive(current, true, version, now);
      placementDepth(await this.parentNode(tx, current.parentId), 0);
      const entry = historyEntry(
        next,
        'activated',
        [],
        { from: current.parentId, to: current.parentId },
        this.newId(),
        actorId,
        now,
      );
      if (!(await tx.replace(next, version, entry))) throw new AreaError('stale_version');
      return next;
    });
  }

  public async history(
    tenantId: string,
    id: unknown,
    query: AreaHistoryQuery = {},
  ): Promise<AreaHistorySlice> {
    const area = await this.get(tenantId, id);
    return this.store.history(tenantId, area.id, window(query));
  }
}
