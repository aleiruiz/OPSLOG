import React from 'react';
import type { ApiError, ApiPorts, Permission, Result, SessionInfo } from '../app/types';

/**
 * Session state mirrored from the BFF. The credential is an httpOnly cookie the browser sends by itself;
 * this module only ever sees `SessionInfo` (company, user, permissions) and keeps it in memory.
 */
export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly session: SessionInfo }
  | { readonly status: 'expired'; readonly session: SessionInfo }
  | { readonly status: 'error'; readonly error: ApiError };

/**
 * Draft bookkeeping that must outlive any single screen (page memory only, never browser storage):
 * edits that could not reach the server yet, and server drafts whose discard failed.
 */
export interface HeldDrafts {
  readonly values: Map<string, Readonly<Record<string, string>>>;
  readonly discards: Set<string>;
  /** Bumped whenever held drafts are wiped; a screen from an older generation must not write to them. */
  generation: number;
}

interface SessionContextValue {
  readonly state: SessionState;
  readonly held: HeldDrafts;
  readonly ports: ApiPorts;
  can(permission: Permission): boolean;
  /** Authorizes with the identity provider (`hint` selects the account of a fake provider), then signs in. */
  signIn(hint: string): Promise<Result<SessionInfo>>;
  acceptInvitation(token: string, hint: string): Promise<Result<SessionInfo>>;
  /** Only a confirmed sign-out clears the session; on failure the person stays signed in. */
  logout(): Promise<Result<null>>;
  /** Called by any screen that receives a 401 from the API. */
  markExpired(): void;
  retry(): void;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({
  ports,
  children,
}: {
  ports: ApiPorts;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState<SessionState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const held = React.useRef<HeldDrafts>({ values: new Map(), discards: new Set(), generation: 0 });
  const lastUser = React.useRef<string | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const wipe = () => {
    held.current.values.clear();
    held.current.discards.clear();
    held.current.generation += 1;
  };
  // Held drafts belong to one person in one session. Only signing in again from the expired state as the
  // same person keeps them; any other sign-in starts clean, and so does sign-out.
  const remember = (session: SessionInfo, resumed: boolean) => {
    if (!resumed || lastUser.current !== session.user.id) wipe();
    lastUser.current = session.user.id;
  };

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void ports.auth.getSession().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        lastUser.current = result.value.user.id;
        setState({ status: 'authenticated', session: result.value });
      } else if (result.error.status === 401) setState({ status: 'anonymous' });
      else setState({ status: 'error', error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [ports, attempt]);

  const value = React.useMemo<SessionContextValue>(() => {
    const established = (result: Result<SessionInfo>) => {
      if (result.ok) {
        remember(result.value, stateRef.current.status === 'expired');
        setState({ status: 'authenticated', session: result.value });
      }
      return result;
    };
    const markExpired = () =>
      setState((current) =>
        current.status === 'authenticated'
          ? { status: 'expired', session: current.session }
          : current,
      );
    return {
      state,
      held: held.current,
      ports,
      can: (permission) =>
        (state.status === 'authenticated' || state.status === 'expired') &&
        state.session.permissions.includes(permission),
      signIn: async (hint) => {
        const credentials = await ports.oidc.authorize(hint);
        return credentials.ok
          ? established(await ports.auth.login(credentials.value))
          : credentials;
      },
      acceptInvitation: async (token, hint) => {
        const credentials = await ports.oidc.authorize(hint);
        return credentials.ok
          ? established(await ports.auth.acceptInvitation(token, credentials.value))
          : credentials;
      },
      logout: async () => {
        const result = await ports.auth.logout();
        if (!result.ok) {
          // The server may still hold the session: do not pretend it ended.
          if (result.error.status === 401) markExpired();
          return result;
        }
        wipe();
        lastUser.current = null;
        setState({ status: 'anonymous' });
        return result;
      },
      markExpired,
      retry: () => setAttempt((count) => count + 1),
    };
  }, [state, ports]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error('useSession requires a SessionProvider');
  return value;
}
