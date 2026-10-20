import type { BffNotification, BffNotificationKind } from '@opslog/contracts';
import React from 'react';
import type { ApiError } from '../../app/types';
import { useSession } from '../../auth/session';

export const PAGE_SIZE = 25;

export interface NotificationFilters {
  readonly unreadOnly: boolean;
  readonly kind: BffNotificationKind | '';
}

export type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | {
      readonly status: 'ready';
      readonly items: readonly BffNotification[];
      readonly total: number;
      readonly unread: number;
    };

/** The person's notices, a page at a time, appended on "Ver más"; changing a filter starts over. */
export function useNotificationList(filters: NotificationFilters) {
  const { ports, markExpired } = useSession();
  const [state, setState] = React.useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const generation = React.useRef(0);

  const query = (offset: number) => ({
    limit: PAGE_SIZE,
    offset,
    ...(filters.unreadOnly ? { unread: 'true' as const } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
  });

  React.useEffect(() => {
    const mine = (generation.current += 1);
    setState({ status: 'loading' });
    void ports.notifications.list(query(0)).then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) setState({ status: 'ready', ...result.value });
      else if (result.error.status === 401) markExpired();
      else setState({ status: 'error', error: result.error });
    });
    return () => {
      generation.current += 1;
    };
  }, [ports, filters.unreadOnly, filters.kind, attempt]);

  const more = async () => {
    if (state.status !== 'ready') return;
    const mine = generation.current;
    setLoadingMore(true);
    const result = await ports.notifications.list(query(state.items.length));
    setLoadingMore(false);
    if (mine !== generation.current) return;
    if (result.ok)
      setState({
        status: 'ready',
        items: [...state.items, ...result.value.items],
        total: result.value.total,
        unread: result.value.unread,
      });
    else if (result.error.status === 401) markExpired();
    else setState({ status: 'error', error: result.error });
  };

  /** Applies a change made on the server to what is shown, without reading the page again. */
  const patch = (
    change: (items: readonly BffNotification[]) => readonly BffNotification[],
    unread: (current: number) => number,
  ) =>
    setState((current) =>
      current.status === 'ready'
        ? { ...current, items: change(current.items), unread: unread(current.unread) }
        : current,
    );

  return { state, loadingMore, more, patch, retry: () => setAttempt((n) => n + 1) };
}
