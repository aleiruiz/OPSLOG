import type { ResourceState } from '../app/resource';
import type { EmployeeHistoryEntry } from '../app/types';

/** The confirmation dialogs the detail can open: archive, or terminate (a status change that cannot be undone). */
export interface EmployeeDialogState {
  readonly kind: 'archive' | 'terminate' | null;
  readonly busy: boolean;
  /** `terminate` only: the reason typed in the status panel, shown back for confirmation. */
  readonly reason?: string | undefined;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const dialogClosed: EmployeeDialogState = { kind: null, busy: false };

/** The inline status-change panel. */
export interface StatusPanelState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const statusPanelClosed: StatusPanelState = { open: false, busy: false };

export interface HistoryPage {
  readonly items: readonly EmployeeHistoryEntry[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface HistoryProps {
  readonly state: ResourceState<HistoryPage>;
  readonly loadingMore?: boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}
