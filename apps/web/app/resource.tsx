import React from 'react';
import { UiState } from '@opslog/ui';
import { useSession } from '../auth/session';
import type { ApiError, Result } from './types';

export type ResourceState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly error: ApiError }
  | { readonly status: 'forbidden' }
  | { readonly status: 'expired' };

/**
 * Loads a port resource and maps the failure kinds the UI must always handle: 401 expires the session
 * (and the load repeats after re-authentication), 403 is "forbidden", anything else is a retryable error.
 */
export function useResource<T>(
  load: () => Promise<Result<T>>,
  deps: React.DependencyList,
): { state: ResourceState<T>; reload: () => void; setData: (data: T) => void } {
  const { state: sessionState, markExpired } = useSession();
  const authenticated = sessionState.status === 'authenticated';
  const [state, setState] = React.useState<ResourceState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const expireRef = React.useRef(markExpired);
  expireRef.current = markExpired;

  React.useEffect(() => {
    if (!authenticated) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    void loadRef.current().then((result) => {
      if (cancelled) return;
      if (result.ok) setState({ status: 'ready', data: result.value });
      else if (result.error.status === 401) {
        expireRef.current();
        setState({ status: 'expired' });
      } else if (result.error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'error', error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated, attempt, ...deps]);

  return {
    state,
    reload: () => setAttempt((count) => count + 1),
    setData: (data) => setState({ status: 'ready', data }),
  };
}

/** Renders the loading, error, forbidden and expired states every data view needs. */
export function ResourceView<T>({
  state,
  onRetry,
  children,
}: {
  state: ResourceState<T>;
  onRetry: () => void;
  children: (data: T) => React.ReactNode;
}) {
  switch (state.status) {
    case 'loading':
      return <UiState kind="loading" />;
    case 'forbidden':
      return <UiState kind="no-permission" />;
    case 'expired':
      return (
        <UiState
          kind="session-expired"
          title="Datos no disponibles"
          description="Se cargarán de nuevo cuando vuelvas a iniciar sesión."
        />
      );
    case 'error':
      return <UiState kind="error" actionLabel="Reintentar" onAction={onRetry} />;
    case 'ready':
      return <>{children(state.data)}</>;
  }
}

/** FilterBar renders a <form>; filters apply as you type, so Enter must not reload the page. */
export function NoSubmit({ children }: { children: React.ReactNode }) {
  return <div onSubmit={(event) => event.preventDefault()}>{children}</div>;
}
