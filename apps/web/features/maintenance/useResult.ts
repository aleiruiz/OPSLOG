import React from 'react';
import type { ApiError } from '@opslog/contracts';
import type { Result } from './ports';

export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly error: ApiError };

/**
 * Loads a port result; a 401 is handed to the shared session handling (`onExpired`). `reload`
 * re-runs the request, and a response from an older request never overwrites a newer one.
 */
export function useResult<T>(
  load: () => Promise<Result<T>>,
  deps: React.DependencyList,
  onExpired: () => void,
): { state: Loadable<T>; reload: () => void } {
  const [state, setState] = React.useState<Loadable<T>>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    void load().then((result) => {
      if (!current) return;
      if (result.ok) setState({ status: 'ready', data: result.value });
      else {
        if (result.error.status === 401) onExpired();
        setState({ status: 'error', error: result.error });
      }
    });
    return () => {
      current = false;
    };
  }, [...deps, attempt]);
  return { state, reload: () => setAttempt((value) => value + 1) };
}

/** Neutral copy for a failed request; never echoes server payloads. */
export function errorKind(error: ApiError): 'session-expired' | 'no-permission' | 'error' {
  if (error.status === 401) return 'session-expired';
  if (error.status === 403) return 'no-permission';
  return 'error';
}
