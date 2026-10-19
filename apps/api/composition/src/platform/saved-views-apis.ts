import {
  BFF_LIST_CATALOG,
  BFF_LIST_MODULES,
  isBffListModule,
  isValidFilterValue,
} from '../../../../../packages/contracts/src/index.js';
import {
  InMemorySavedViewStore,
  SavedViewService,
  type ViewCatalog,
  type ViewModuleCatalog,
} from '../../../../../packages/domain/saved-views/src/index.js';
import { SavedViewsApi } from '../../../saved-views/src/index.js';
import type { PlatformKernel } from './kernel.js';
import type { PlatformAdapters } from './types.js';

/** The lists of BRD §14.2 as the domain reads them, built once from the contract catalog. */
function moduleCatalog(name: (typeof BFF_LIST_MODULES)[number]): ViewModuleCatalog {
  const spec = BFF_LIST_CATALOG[name];
  return {
    access: spec.access,
    filters: new Map(
      Object.entries(spec.filters).map(([key, filter]) => [
        key,
        {
          label: filter.label,
          accepts: (value: string) => isValidFilterValue(filter.spec, value),
          ...('permission' in filter ? { permission: filter.permission } : {}),
        },
      ]),
    ),
    sorts: new Set<string>(spec.sorts),
    columns: new Map(
      spec.columns.map((column) => [
        column.key,
        {
          label: column.label,
          locked: 'locked' in column && column.locked === true,
          ...('permission' in column ? { permission: column.permission } : {}),
        },
      ]),
    ),
  };
}

export function viewCatalog(): ViewCatalog {
  const modules = new Map(BFF_LIST_MODULES.map((name) => [name, moduleCatalog(name)]));
  return { module: (name) => (isBffListModule(name) ? (modules.get(name) ?? null) : null) };
}

export interface SavedViewsModule {
  readonly api: SavedViewsApi;
  readonly service: SavedViewService;
}

/** Saved views and visible columns; memory unless a persistent store is injected. */
export function buildSavedViews(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
): SavedViewsModule {
  const service = new SavedViewService(
    adapters.savedViews ?? new InMemorySavedViewStore(),
    viewCatalog(),
    { now: kernel.now },
  );
  return {
    service,
    api: new SavedViewsApi({
      service,
      authorize: async (token, correlationId) => {
        const context = await kernel.authorize(token, correlationId, []);
        return {
          tenantId: context.tenantId,
          subject: context.actor.subject,
          permissions: await kernel.access.resolvePermissions(context),
        };
      },
    }),
  };
}
