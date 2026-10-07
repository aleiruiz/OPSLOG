import { randomUUID } from 'node:crypto';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './types.js';
import type { Area, AreaField, AreaNode } from './types.js';
import { AreaError } from './errors.js';
import {
  invalid,
  isInteger,
  parentOf,
  parseAreaPatch,
  parseNewArea,
  requireOpaqueId,
  requireVersion,
} from './validation.js';
import {
  applyActive,
  applyPatch,
  changedFields,
  historyEntry,
  newArea,
  placementDepth,
} from './rules.js';
import { AREA_RESOURCES } from './ports.js';
import type {
  AreaFilter,
  AreaHistorySlice,
  AreaMemberDirectory,
  AreaResource,
  AreaResourceCounters,
  AreaSlice,
  AreaStore,
  AreaTx,
  AreaWindow,
} from './ports.js';

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

  /**
   * Runs `work` while `areaId` is an active area of the tenant, holding the tenant lock that
   * `deactivate` also takes: a deactivation (and its BR-021 resource count) cannot run between the
   * check and `work`, so a vehicle written inside `work` is always seen by the count. Unknown,
   * foreign and inactive areas give the same `{ active: false }` and `work` does not run.
   *
   * An error of `work` is carried out of the transaction and rethrown unchanged (the store would
   * otherwise sanitize it). `work` must not call back into this service or store for the same
   * tenant: it would wait for the lock it already holds.
   */
  public async withActiveArea<T>(
    tenantId: string,
    id: unknown,
    work: () => Promise<T>,
  ): Promise<{ readonly active: true; readonly value: T } | { readonly active: false }> {
    const areaId = requireOpaqueId(id);
    requireOpaqueId(tenantId);
    let failed: { readonly error: unknown } | undefined;
    const outcome = await this.store.transaction(tenantId, async (tx) => {
      if (!(await tx.find(areaId))?.active) return { active: false } as const;
      try {
        return { active: true, value: await work() } as const;
      } catch (error) {
        failed = { error };
        return { active: false } as const;
      }
    });
    if (failed) throw failed.error;
    return outcome;
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
