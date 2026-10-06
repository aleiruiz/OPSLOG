import Typography from '@mui/material/Typography';
import React from 'react';
import type { DraftValues } from '../app/types';
import { useSession } from './session';

export type DraftStatus =
  | 'loading'
  | 'idle'
  | 'restored'
  | 'saving'
  | 'saved'
  | 'waiting-session'
  | 'error';

export const draftSaveDelayMs = 600;

const messages: Record<DraftStatus, string> = {
  loading: '',
  idle: '',
  restored: 'Recuperamos tu borrador guardado.',
  saving: 'Guardando borrador…',
  saved: 'Borrador guardado.',
  'waiting-session':
    'Tu sesión expiró. Mantenemos estos cambios en esta pantalla y los guardaremos en el servidor cuando vuelvas a iniciar sesión.',
  error: 'No pudimos guardar el borrador. Lo intentaremos de nuevo al seguir editando.',
};

/**
 * Server-side form drafts through `DraftsPort`. Nothing is written to Web Storage or IndexedDB: a draft
 * that cannot be saved because the session expired stays only in this page's memory until the user signs
 * in again, and is then sent to the server.
 */
export function useServerDraft<T extends DraftValues>(scope: string, initial: T) {
  const { ports, state, markExpired } = useSession();
  const authenticated = state.status === 'authenticated';
  const initialRef = React.useRef(initial);
  const [values, setValues] = React.useState<T>(initial);
  const [status, setStatus] = React.useState<DraftStatus>('loading');
  const latest = React.useRef<T>(initial);
  const dirty = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = React.useRef(true);
  const sessionRef = React.useRef({ markExpired, authenticated });
  sessionRef.current = { markExpired, authenticated };

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const save = React.useCallback(async () => {
    clearTimer();
    if (!dirty.current) return;
    const snapshot = latest.current;
    if (!sessionRef.current.authenticated) {
      setStatus('waiting-session');
      return;
    }
    setStatus('saving');
    const result = await ports.drafts.save(scope, snapshot);
    if (!alive.current) return;
    if (result.ok) {
      if (latest.current === snapshot) {
        dirty.current = false;
        setStatus('saved');
      }
    } else if (result.error.status === 401) {
      sessionRef.current.markExpired();
      setStatus('waiting-session');
    } else setStatus('error');
  }, [ports, scope]);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer();
      // Leaving the screen with unsent edits: hand them to the server instead of dropping them.
      if (dirty.current && sessionRef.current.authenticated)
        void ports.drafts.save(scope, latest.current);
    };
  }, [ports, scope]);

  React.useEffect(() => {
    if (!authenticated) return undefined;
    let cancelled = false;
    void ports.drafts.load(scope).then((result) => {
      if (cancelled) return;
      if (result.ok && result.value && !dirty.current) {
        const restored = { ...initialRef.current, ...result.value.values } as T;
        latest.current = restored;
        setValues(restored);
        setStatus('restored');
      } else if (!result.ok && result.error.status === 401) {
        sessionRef.current.markExpired();
      } else setStatus((current) => (current === 'loading' ? 'idle' : current));
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated, ports, scope]);

  // Back online after re-authentication: send what could not be saved while the session was expired.
  React.useEffect(() => {
    if (authenticated && dirty.current) void save();
  }, [authenticated, save]);

  const setField = (name: keyof T & string, value: string) => {
    const next = { ...latest.current, [name]: value } as T;
    latest.current = next;
    dirty.current = true;
    setValues(next);
    clearTimer();
    if (!sessionRef.current.authenticated) setStatus('waiting-session');
    else timer.current = setTimeout(() => void save(), draftSaveDelayMs);
  };

  /** Drops the server draft. `baseline` becomes the new pristine form (e.g. the values just saved). */
  const discard = async (baseline?: T) => {
    clearTimer();
    dirty.current = false;
    if (baseline) initialRef.current = baseline;
    latest.current = initialRef.current;
    setValues(initialRef.current);
    setStatus('idle');
    const result = await ports.drafts.discard(scope);
    if (!result.ok && result.error.status === 401) sessionRef.current.markExpired();
  };

  return { values, setField, status, discard, saveNow: save };
}

export function DraftNotice({ status }: { status: DraftStatus }) {
  return (
    <Typography
      role="status"
      variant="body2"
      color="text.secondary"
      sx={{ minHeight: '1.5em' }}
      data-draft-status={status}
    >
      {messages[status]}
    </Typography>
  );
}
