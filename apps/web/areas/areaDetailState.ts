import type { ResourceState } from '../app/resource';
import type { AreaHistoryEntry } from '../app/types';

/** The confirmation dialog the detail can open: deactivate (destructive) or activate (reversible). */
export interface AreaDialogState {
  readonly kind: 'deactivate' | 'activate' | null;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const dialogClosed: AreaDialogState = { kind: null, busy: false };

export interface HistoryPage {
  readonly items: readonly AreaHistoryEntry[];
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
