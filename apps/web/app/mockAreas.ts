import { MAX_AREA_DEPTH, OPAQUE_ID } from '../areas/rules';
import {
  conflict,
  demoMockAreas,
  duplicate,
  failure,
  findCollision,
  hierarchy,
  notFound,
  badRequest,
  ok,
  page,
  pageWindow,
  parseFields,
  sameIds,
  seedHistory,
  validVersion,
  type Fields,
} from './mockAreasSupport';
import type { MockAreaEnvironment, MockAreaStore } from './mockAreasTypes';
import type {
  Area,
  AreaDetail,
  AreaHistoryEntry,
  AreaHistoryQuery,
  AreaInput,
  AreaListQuery,
  AreaPatch,
  AreasPort,
} from './types';

export { demoMockAreas };
export type { MockAreaEnvironment, MockAreaStore };

const NOW = '2026-10-06T12:00:00.000Z';

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
  const history = seedHistory(rows, () => {
    historySequence += 1;
    return `hist-mock-${historySequence}`;
  });

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

  /** Name among siblings (case-insensitive) or code (company-wide) already taken by another area. */
  const collision = (candidate: Fields, parentId: string | null, exceptId: string | null) =>
    findCollision(rows, candidate, parentId, exceptId);
  const strangers = (ids: readonly string[], known: readonly string[] = []) =>
    ids.some((id) => !known.includes(id) && !env.isMember(id));

  const detail = (area: Area): AreaDetail => ({
    ...area,
    resourceCounts: {
      vehicles: env.liveVehicles(area.id),
      people: (people.get(area.id) ?? 0) + (env.livePeople?.(area.id) ?? 0),
    },
  });

  const port: AreasPort = {
    list: async (query: AreaListQuery = {}) => {
      const slice = pageWindow(query);
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
      if ((people.get(id) ?? 0) + (env.livePeople?.(id) ?? 0) > 0)
        return failure(409, 'area_in_use', 'Conflict', 'people');
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
      const slice = pageWindow(query);
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
