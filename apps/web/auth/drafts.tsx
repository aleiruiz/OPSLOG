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
  const { ports, state, markExpired, held } = useSession();
  const authenticated = state.status === 'authenticated';
  const initialRef = React.useRef(initial);
  // Edits held from a previous visit to this screen (they could not reach the server) come back first.
  const [values, setValues] = React.useState<T>(
    () => ({ ...initial, ...(held.values.get(scope) ?? {}) }) as T,
  );
  const [status, setStatus] = React.useState<DraftStatus>(
    held.values.has(scope) ? 'waiting-session' : 'loading',
  );
  const latest = React.useRef<T>(values);
  const dirty = React.useRef(held.values.has(scope));
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = React.useRef(true);
  // Writes to the held store are only valid for the sign-in this screen was mounted under.
  const generation = React.useRef(held.generation);
  const live = () => held.generation === generation.current;
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
        if (live()) held.values.delete(scope);
        setStatus('saved');
      }
    } else if (result.error.status === 401) {
      sessionRef.current.markExpired();
      setStatus('waiting-session');
    } else setStatus('error');
  }, [ports, scope, held]);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer();
      // Leaving the screen with unsent edits: hand them to the server; if that is not possible they are
      // held in page memory (outside this screen) until the person is authenticated again.
      if (!dirty.current || !live()) return; // signed out meanwhile: the edits are not carried over
      const pending = latest.current;
      if (!sessionRef.current.authenticated) held.values.set(scope, pending);
      else
        void ports.drafts.save(scope, pending).then((result) => {
          if (!live()) return;
          if (result.ok) held.values.delete(scope);
          else held.values.set(scope, pending);
        });
    };
  }, [ports, scope, held]);

  React.useEffect(() => {
    if (!authenticated) return undefined;
    let cancelled = false;
    void (async () => {
      if (held.discards.has(scope)) {
        // A discard failed earlier: finish it first and never restore the draft it was meant to remove.
        const dropped = await ports.drafts.discard(scope);
        if (cancelled) return;
        if (dropped.ok) {
          if (live()) held.discards.delete(scope);
        } else if (dropped.error.status === 401) sessionRef.current.markExpired();
        setStatus((current) => (current === 'loading' ? 'idle' : current));
        return;
      }
      const result = await ports.drafts.load(scope);
      if (cancelled) return;
      if (result.ok && result.value && !dirty.current) {
        const restored = { ...initialRef.current, ...result.value.values } as T;
        latest.current = restored;
        setValues(restored);
        setStatus('restored');
      } else if (!result.ok && result.error.status === 401) {
        sessionRef.current.markExpired();
      } else setStatus((current) => (current === 'loading' ? 'idle' : current));
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, ports, scope, held]);

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
    if (live()) held.values.delete(scope);
    const result = await ports.drafts.discard(scope);
    if (!live()) return;
    if (result.ok) held.discards.delete(scope);
    else {
      held.discards.add(scope);
      if (result.error.status === 401) sessionRef.current.markExpired();
    }
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
