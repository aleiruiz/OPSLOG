import React from 'react';
import type { ApiError, BffDashboard, BffDashboardQuery } from '@opslog/contracts';
import { useSession } from '../../auth/session';

export type DashboardState =
  | { readonly status: 'loading'; readonly data: null }
  | { readonly status: 'ready'; readonly data: BffDashboard; readonly refreshing: boolean }
  | { readonly status: 'error'; readonly data: BffDashboard | null; readonly error: ApiError }
  | { readonly status: 'forbidden'; readonly data: null };

/**
 * The dashboard for a query. Changing the query starts a new request and drops the answer of the old one;
 * the last figures stay on screen (marked as refreshing) until the new ones arrive, so the page does not jump.
 */
export function useDashboard(query: BffDashboardQuery): {
  state: DashboardState;
  reload: () => void;
} {
  const { ports, state: session, markExpired } = useSession();
  const authenticated = session.status === 'authenticated';
  const key = JSON.stringify(query);
  const [state, setState] = React.useState<DashboardState>({ status: 'loading', data: null });
  const [attempt, setAttempt] = React.useState(0);
  const expireRef = React.useRef(markExpired);
  expireRef.current = markExpired;

  React.useEffect(() => {
    if (!authenticated) return undefined;
    let current = true;
    setState((previous) =>
      previous.data
        ? { status: 'ready', data: previous.data, refreshing: true }
        : { status: 'loading', data: null },
    );
    void ports.dashboard.get(JSON.parse(key) as BffDashboardQuery).then((result) => {
      if (!current) return;
      if (result.ok) setState({ status: 'ready', data: result.value, refreshing: false });
      else if (result.error.status === 401) expireRef.current();
      else if (result.error.status === 403) setState({ status: 'forbidden', data: null });
      else setState((previous) => ({ status: 'error', data: previous.data, error: result.error }));
    });
    return () => {
      current = false;
    };
  }, [ports, authenticated, key, attempt]);

  return { state, reload: () => setAttempt((count) => count + 1) };
}
