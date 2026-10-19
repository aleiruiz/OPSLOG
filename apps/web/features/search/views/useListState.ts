import type { BffListModule } from '@opslog/contracts';
import type { ViewsPorts } from './ports';
import { useListColumns, type ListColumnsControl } from './useListColumns';
import { useListUrl, type ListUrlControl } from './useListUrl';
import type { CanUse } from './urlState';

export interface ListState extends ListUrlControl {
  readonly module: BffListModule;
  readonly views: ViewsPorts | undefined;
  readonly columns: ListColumnsControl;
  readonly can: CanUse;
  readonly onExpired: () => void;
}

/** Everything a §14.2 list shares: URL filters, order, size, persistent columns and the saved-views ports. */
export function useListState(
  module: BffListModule,
  options: { views?: ViewsPorts | undefined; can: CanUse; onExpired: () => void },
): ListState {
  const url = useListUrl(module, options.can);
  const columns = useListColumns(module, options.views, options.can, options.onExpired);
  return {
    ...url,
    module,
    views: options.views,
    columns,
    can: options.can,
    onExpired: options.onExpired,
  };
}
