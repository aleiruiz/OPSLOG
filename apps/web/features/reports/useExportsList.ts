import React from 'react';
import type { BffExportList } from '@opslog/contracts';
import type { ResourceState } from '../../app/resource';
import { useSession } from '../../auth/session';
import { isOpen } from './labels';

/**
 * The person's exports, refreshed without flicker: while one is queued or running the list is
 * read again every `pollMs`, and `refresh` reads it on demand. A 401 hands over to the session.
 */
export function useExportsList(offset: number, limit: number, pollMs: number) {
  const { ports, markExpired } = useSession();
  const [state, setState] = React.useState<ResourceState<BffExportList>>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const load = React.useRef<() => Promise<void>>(async () => undefined);
  const current = React.useRef(0);

  load.current = async () => {
    const mine = (current.current += 1);
    const result = await ports.reports.exports({ limit, offset });
    if (mine !== current.current) return;
    if (result.ok) setState({ status: 'ready', data: result.value });
    else if (result.error.status === 401) {
      markExpired();
      setState({ status: 'expired' });
    } else if (result.error.status === 403) setState({ status: 'forbidden' });
    else setState({ status: 'error', error: result.error });
  };

  React.useEffect(() => {
    void load.current();
    return () => {
      current.current += 1;
    };
  }, [ports, offset, limit, attempt]);

  const open = state.status === 'ready' && state.data.items.some(isOpen);
  React.useEffect(() => {
    if (!open || pollMs <= 0) return undefined;
    const timer = setInterval(() => void load.current(), pollMs);
    return () => clearInterval(timer);
  }, [open, pollMs]);

  return {
    state,
    refresh: () => setAttempt((count) => count + 1),
    retry: () => {
      setState({ status: 'loading' });
      setAttempt((count) => count + 1);
    },
  };
}
