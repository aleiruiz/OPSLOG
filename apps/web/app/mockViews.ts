import {
  BFF_VIEWS_PER_USER_AND_MODULE,
  isBffListModule,
  isValidFilterValue,
  listModuleSpec,
  type BffListColumns,
  type BffListModule,
  type BffSavedView,
  type BffViewDrop,
  type BffViewSort,
} from '@opslog/contracts';
import type { ViewsPorts } from '../features/search/views/ports';
import { apiError, ok } from './mockApiErrors';
import type { Guarded } from './mockApiTypes';
import type { Permission, Result } from './types';

interface Stored {
  id: string;
  ownerId: string;
  module: BffListModule;
  name: string;
  shared: boolean;
  filters: Record<string, string>;
  sort: BffViewSort | null;
  columns: readonly string[] | null;
  version: number;
  updatedAt: string;
}

/** Applies the allowlist and the reader's grants like the server: what cannot be used is dropped and named. */
function revalidate(
  module: BffListModule,
  content: Pick<Stored, 'filters' | 'sort' | 'columns'>,
  can: (permission: Permission) => boolean,
) {
  const spec = listModuleSpec(module);
  const dropped: BffViewDrop[] = [];
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(content.filters)) {
    const filter = spec.filters[key];
    if (!filter) dropped.push({ kind: 'filter', key, label: key, reason: 'invalid' });
    else if (filter.permission && !can(filter.permission as Permission))
      dropped.push({ kind: 'filter', key, label: filter.label, reason: 'permission' });
    else if (!isValidFilterValue(filter.spec, value))
      dropped.push({ kind: 'filter', key, label: filter.label, reason: 'invalid' });
    else filters[key] = value;
  }
  const sort = content.sort && spec.sorts.includes(content.sort.field) ? content.sort : null;
  let columns: readonly string[] | null = null;
  if (content.columns) {
    const kept: string[] = [];
    for (const key of content.columns) {
      const column = spec.columns.find((candidate) => candidate.key === key);
      if (!column) dropped.push({ kind: 'column', key, label: key, reason: 'invalid' });
      else if (column.permission && !can(column.permission as Permission))
        dropped.push({ kind: 'column', key, label: column.label, reason: 'permission' });
      else kept.push(key);
    }
    columns = kept;
  }
  return { filters, sort, columns, dropped };
}

/** Saved views and persistent columns of the demo: per user, shareable, revalidated on every read. */
export function createMockViewsPorts(
  guarded: Guarded,
  session: {
    readonly userId: () => string | null;
    readonly can: (permission: Permission) => boolean;
  },
): ViewsPorts {
  const views = new Map<string, Stored>();
  const columns = new Map<string, readonly string[] | null>();
  let next = 0;
  const me = () => session.userId() ?? '';
  const notFound = () => apiError(404, 'not_found', 'Resource not found');
  const project = (view: Stored): BffSavedView => {
    const content = revalidate(view.module, view, session.can);
    const mine = view.ownerId === me();
    return {
      id: view.id,
      module: view.module,
      name: view.name,
      shared: view.shared,
      mine,
      canEdit: mine || (view.shared && session.can('manage_config')),
      version: view.version,
      updatedAt: view.updatedAt,
      ...content,
    };
  };
  const access = (module: unknown): Result<BffListModule> => {
    if (!isBffListModule(module)) return apiError(400, 'bad_request', 'Invalid request');
    return session.can(listModuleSpec(module).access as Permission)
      ? ok(module)
      : apiError(403, 'forbidden', 'Permission denied');
  };
  const visible = (id: string): Stored | null => {
    const view = views.get(id);
    return view && (view.ownerId === me() || view.shared) ? view : null;
  };
  const key = (module: BffListModule) => `${me()}:${module}`;
  const columnsOf = (module: BffListModule): BffListColumns => {
    const saved = columns.get(key(module)) ?? null;
    const { columns: kept, dropped } = revalidate(
      module,
      { filters: {}, sort: null, columns: saved },
      session.can,
    );
    return { module, columns: kept, dropped };
  };

  return {
    list: (module) =>
      guarded('views', null, () => {
        const allowed = access(module);
        if (!allowed.ok) return allowed;
        const items = [...views.values()]
          .filter((view) => view.module === module && (view.ownerId === me() || view.shared))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'))
          .map(project);
        return ok({ items });
      }),
    create: (input) =>
      guarded('views', null, () => {
        const allowed = access(input.module);
        if (!allowed.ok) return allowed;
        const name = input.name.trim();
        if (name === '' || name.length > 80) return apiError(400, 'bad_request', 'Invalid request');
        const own = [...views.values()].filter(
          (view) => view.ownerId === me() && view.module === input.module,
        );
        if (own.some((view) => view.name.toLowerCase() === name.toLowerCase()))
          return apiError(409, 'duplicate', 'Duplicate');
        if (own.length >= BFF_VIEWS_PER_USER_AND_MODULE)
          return apiError(422, 'rule_violation', 'Rule violation');
        next += 1;
        const view: Stored = {
          id: `view-${next}`,
          ownerId: me(),
          module: input.module,
          name,
          shared: input.shared ?? false,
          filters: { ...input.filters },
          sort: input.sort ?? null,
          columns: input.columns ?? null,
          version: 1,
          updatedAt: '2026-10-19T12:00:00Z',
        };
        views.set(view.id, view);
        return ok(project(view));
      }),
    update: (id, patch) =>
      guarded('views', null, () => {
        const view = visible(id);
        if (!view || !access(view.module).ok) return notFound();
        if (view.ownerId !== me() && !session.can('manage_config'))
          return apiError(403, 'forbidden', 'Permission denied');
        if (patch.version !== view.version) return apiError(409, 'stale_version', 'Stale');
        const name = patch.name === undefined ? view.name : patch.name.trim();
        if (name === '' || name.length > 80) return apiError(400, 'bad_request', 'Invalid request');
        const clash = [...views.values()].some(
          (other) =>
            other.id !== view.id &&
            other.ownerId === view.ownerId &&
            other.module === view.module &&
            other.name.toLowerCase() === name.toLowerCase(),
        );
        if (clash) return apiError(409, 'duplicate', 'Duplicate');
        const updated: Stored = {
          ...view,
          name,
          shared: patch.shared ?? view.shared,
          filters: patch.filters ? { ...patch.filters } : view.filters,
          sort: patch.sort === undefined ? view.sort : patch.sort,
          columns: patch.columns === undefined ? view.columns : patch.columns,
          version: view.version + 1,
        };
        views.set(id, updated);
        return ok(project(updated));
      }),
    remove: (id) =>
      guarded('views', null, () => {
        const view = visible(id);
        if (!view) return notFound();
        if (view.ownerId !== me() && !session.can('manage_config'))
          return apiError(403, 'forbidden', 'Permission denied');
        views.delete(id);
        return ok(undefined);
      }),
    columns: (module) =>
      guarded('views', null, () => {
        const allowed = access(module);
        return allowed.ok ? ok(columnsOf(allowed.value)) : allowed;
      }),
    saveColumns: (module, selection) =>
      guarded('views', null, () => {
        const allowed = access(module);
        if (!allowed.ok) return allowed;
        columns.set(key(allowed.value), selection);
        return ok(columnsOf(allowed.value));
      }),
  };
}
