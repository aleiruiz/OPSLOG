import React from 'react';
import type { ApiError } from '@opslog/contracts';
import type { Result } from '../../app/types';

export interface Live<T> {
  /** The last data received; kept while a newer request is in flight so the screen does not flash or unmount. */
  readonly data: T | null;
  readonly error: ApiError | null;
  /** The first request has not answered yet. */
  readonly loading: boolean;
  readonly reload: () => void;
  /** Replaces the data with a newer answer the caller already holds (the response of a command). */
  readonly set: (value: T) => void;
}

/**
 * Like a one-shot loader, but it refreshes in place: when `deps` change (a new case version) or `reload`
 * is called, the previous data stays on screen until the new answer arrives, and an answer to an older
 * request never overwrites a newer one. A 401 is handed to the shared session handling.
 */
export function useLive<T>(
  load: () => Promise<Result<T>>,
  deps: React.DependencyList,
  onExpired: () => void,
  /** Whether an answer may replace what is shown (for example: not an older version of the same case). */
  accept: (next: T, shown: T | null) => boolean = () => true,
): Live<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [attempt, setAttempt] = React.useState(0);
  const shown = React.useRef<T | null>(null);
  shown.current = data;
  React.useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.ok) {
        if (accept(result.value, shown.current)) setData(result.value);
        setError(null);
      } else {
        if (result.error.status === 401) onExpired();
        setError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, [...deps, attempt]);
  return {
    data,
    error,
    loading,
    reload: () => setAttempt((value) => value + 1),
    set: (value) => {
      shown.current = value;
      setData(value);
      setError(null);
      setLoading(false);
    },
  };
}
