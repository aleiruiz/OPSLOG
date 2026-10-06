import React from 'react';
import type {
  AcceptInvitationInput,
  ApiError,
  ApiPorts,
  LoginInput,
  Permission,
  Result,
  SessionInfo,
} from '../app/types';

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
}

interface SessionContextValue {
  readonly state: SessionState;
  readonly held: HeldDrafts;
  readonly ports: ApiPorts;
  can(permission: Permission): boolean;
  login(input: LoginInput): Promise<Result<SessionInfo>>;
  acceptInvitation(token: string, input: AcceptInvitationInput): Promise<Result<SessionInfo>>;
  logout(): Promise<void>;
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
  const held = React.useRef<HeldDrafts>({ values: new Map(), discards: new Set() });
  const lastUser = React.useRef<string | null>(null);
  // Held drafts belong to one person: a different identity must never inherit them.
  const remember = (session: SessionInfo) => {
    if (lastUser.current !== null && lastUser.current !== session.user.id) {
      held.current.values.clear();
      held.current.discards.clear();
    }
    lastUser.current = session.user.id;
  };

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void ports.auth.getSession().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        remember(result.value);
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
        remember(result.value);
        setState({ status: 'authenticated', session: result.value });
      }
      return result;
    };
    return {
      state,
      held: held.current,
      ports,
      can: (permission) =>
        (state.status === 'authenticated' || state.status === 'expired') &&
        state.session.permissions.includes(permission),
      login: async (input) => established(await ports.auth.login(input)),
      acceptInvitation: async (token, input) =>
        established(await ports.auth.acceptInvitation(token, input)),
      logout: async () => {
        // Local state is cleared even if the server call fails: the user asked to leave.
        await ports.auth.logout();
        held.current.values.clear();
        held.current.discards.clear();
        lastUser.current = null;
        setState({ status: 'anonymous' });
      },
      markExpired: () =>
        setState((current) =>
          current.status === 'authenticated'
            ? { status: 'expired', session: current.session }
            : current,
        ),
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

/** Fields the server reported as invalid, keyed by field name. */
export function fieldErrorMap(error: ApiError): Record<string, string> {
  return Object.fromEntries((error.fieldErrors ?? []).map((item) => [item.field, item.message]));
}
