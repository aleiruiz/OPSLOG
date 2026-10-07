import { MAX_AREA_DEPTH } from './types.js';
import type { Area, AreaAction, AreaField, AreaHistoryEntry, AreaNode } from './types.js';
import { AreaError } from './errors.js';
import type { AreaPatch, NewAreaData } from './validation.js';

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
