import React from 'react';
import { UiState } from '@opslog/ui';
import { InvitationScreen } from '../auth/InvitationScreen';
import { LoginScreen } from '../auth/LoginScreen';
import { SessionExpiredPanel } from '../auth/SessionExpiredPanel';
import { SessionProvider, useSession } from '../auth/session';
import { RolesScreen } from '../settings/access/RolesScreen';
import { TenantAdminScreen } from '../settings/access/TenantAdminScreen';
import { UsersScreen } from '../settings/access/UsersScreen';
import { AppShell } from './AppShell';
import { HomeScreen } from './HomeScreen';
import { RouterProvider, useRouter } from './router';
import { isAllowed, loginPath, resolveRoute } from './routes';
import type { ApiPorts } from './types';

export function App({ ports, basename = '' }: { ports: ApiPorts; basename?: string }) {
  return (
    <RouterProvider basename={basename}>
      <SessionProvider ports={ports}>
        <Routes />
      </SessionProvider>
    </RouterProvider>
  );
}

function Redirect({ to }: { to: string }) {
  const router = useRouter();
  React.useEffect(() => router.navigate(to, { replace: true }), [router, to]);
  return <UiState kind="loading" />;
}

function Routes() {
  const router = useRouter();
  const { state, can, logout, retry } = useSession();
  const match = resolveRoute(router.path);
  const mainTitle = match?.route.title ?? 'Página no encontrada';

  React.useEffect(() => {
    const company =
      state.status === 'authenticated' || state.status === 'expired'
        ? ` · ${state.session.company.name}`
        : '';
    document.title = `${mainTitle}${company} · OPSLOG`;
  }, [mainTitle, state]);

  if (state.status === 'loading')
    return (
      <main>
        <UiState kind="loading" />
      </main>
    );
  if (state.status === 'error')
    return (
      <main>
        <UiState kind="error" actionLabel="Reintentar" onAction={retry} />
      </main>
    );

  if (state.status === 'anonymous') {
    if (match?.route.id === 'invitation')
      return (
        <main>
          <InvitationScreen token={match.params.token as string} />
        </main>
      );
    if (match?.route.id === 'login')
      return (
        <main>
          <LoginScreen />
        </main>
      );
    const next = router.path === '/' ? '' : `?siguiente=${encodeURIComponent(router.path)}`;
    return <Redirect to={`${loginPath}${next}`} />;
  }

  const { session } = state;
  const expired = state.status === 'expired';
  if (match?.route.id === 'login') return <Redirect to="/" />;

  const allowed = match ? isAllowed(match.route.access, can) : true;
  let screen: React.ReactNode;
  if (!match)
    screen = (
      <UiState
        kind="no-results"
        title="Página no encontrada"
        description="Revisa la dirección o usa el menú."
      />
    );
  else if (!allowed) screen = <UiState kind="no-permission" />;
  else
    switch (match.route.id) {
      case 'home':
        screen = <HomeScreen session={session} can={can} />;
        break;
      case 'company':
        screen = <TenantAdminScreen />;
        break;
      case 'users':
        screen = <UsersScreen />;
        break;
      case 'roles':
        screen = <RolesScreen />;
        break;
      case 'invitation':
        screen = <InvitationScreen token={match.params.token as string} />;
        break;
      default:
        screen = null;
    }

  return (
    <AppShell
      session={session}
      currentRouteId={match?.route.id ?? null}
      can={can}
      onSignOut={() => void logout()}
    >
      {expired && <SessionExpiredPanel email={session.user.email} />}
      {/* Keyed by user: signing back in as someone else drops the previous person's screen state. */}
      <div key={session.user.id} inert={expired}>
        {screen}
      </div>
    </AppShell>
  );
}
