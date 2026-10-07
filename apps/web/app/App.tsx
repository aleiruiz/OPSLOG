import React from 'react';
import { UiState } from '@opslog/ui';
import { InvitationScreen } from '../auth/InvitationScreen';
import { LoginScreen } from '../auth/LoginScreen';
import { SessionExpiredPanel } from '../auth/SessionExpiredPanel';
import { SessionProvider, useSession } from '../auth/session';
import { RolesScreen } from '../settings/access/RolesScreen';
import { TenantAdminScreen } from '../settings/access/TenantAdminScreen';
import { UsersScreen } from '../settings/access/UsersScreen';
import { AlertSettingsScreen } from '../alerts/AlertSettingsScreen';
import { AlertsScreen } from '../alerts/AlertsScreen';
import { AreaDetailScreen } from '../areas/AreaDetailScreen';
import { AreaCreateScreen, AreaEditScreen, AreaMoveScreen } from '../areas/AreaFormScreen';
import { AreasScreen } from '../areas/AreasScreen';
import { AssignmentDetailScreen } from '../assignments/AssignmentDetailScreen';
import { AssignmentCreateScreen, AssignmentEndScreen } from '../assignments/AssignmentFormScreen';
import { AssignmentsScreen } from '../assignments/AssignmentsScreen';
import { DocumentDetailScreen } from '../documents/DocumentDetailScreen';
import {
  DocumentCreateScreen,
  DocumentEditScreen,
  DocumentRenewScreen,
} from '../documents/DocumentFormScreen';
import { DocumentsScreen } from '../documents/DocumentsScreen';
import { ImportDetailScreen } from '../imports/ImportDetailScreen';
import { ImportCreateScreen } from '../imports/ImportFormScreen';
import { ImportsScreen } from '../imports/ImportsScreen';
import { PolicyDetailScreen } from '../insurance/PolicyDetailScreen';
import {
  PolicyCreateScreen,
  PolicyEditScreen,
  PolicyRenewScreen,
} from '../insurance/PolicyFormScreen';
import { PoliciesScreen } from '../insurance/PoliciesScreen';
import { EmployeeDetailScreen } from '../employees/EmployeeDetailScreen';
import { EmployeeCreateScreen, EmployeeEditScreen } from '../employees/EmployeeFormScreen';
import { EmployeesScreen } from '../employees/EmployeesScreen';
import { VehicleDetailScreen } from '../vehicles/VehicleDetailScreen';
import { VehicleCreateScreen, VehicleEditScreen } from '../vehicles/VehicleFormScreen';
import { VehiclesScreen } from '../vehicles/VehiclesScreen';
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

/** Sub-screens keep the entry of their list highlighted ("Vehículos", "Áreas", "Empleados"). */
function navigationRoute(id: string | null): string | null {
  if (id === 'vehicleNew' || id === 'vehicleDetail' || id === 'vehicleEdit') return 'vehicles';
  if (
    id === 'assignmentNew' ||
    id === 'assignmentDetail' ||
    id === 'assignmentEnd'
  )
    return 'assignments';
  if (id === 'importNew' || id === 'importDetail') return 'imports';
  if (id === 'employeeNew' || id === 'employeeDetail' || id === 'employeeEdit') return 'employees';
  if (id === 'areaNew' || id === 'areaDetail' || id === 'areaEdit' || id === 'areaMove')
    return 'areas';
  if (
    id === 'documentNew' ||
    id === 'documentDetail' ||
    id === 'documentEdit' ||
    id === 'documentRenew'
  )
    return 'documents';
  if (id === 'policyNew' || id === 'policyDetail' || id === 'policyEdit' || id === 'policyRenew')
    return 'policies';
  return id;
}

function Redirect({ to }: { to: string }) {
  const router = useRouter();
  React.useEffect(() => router.navigate(to, { replace: true }), [router, to]);
  return <UiState kind="loading" />;
}

function Routes() {
  const router = useRouter();
  const { state, can, logout, retry } = useSession();
  const [signOutFailed, setSignOutFailed] = React.useState(false);
  const match = resolveRoute(router.path);
  // The invitation token is kept in memory only and removed from the address bar and history entry.
  const invitationToken = React.useRef('');
  if (match?.route.id === 'invitation' && match.params.token)
    invitationToken.current = match.params.token;
  const tokenInUrl = match?.route.id === 'invitation' && Boolean(match.params.token);
  React.useEffect(() => {
    if (tokenInUrl) router.navigate('/invitacion', { replace: true });
  }, [tokenInUrl, router]);
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
          <InvitationScreen
            token={invitationToken.current}
            onConsumed={() => {
              invitationToken.current = '';
            }}
          />
        </main>
      );
    if (match?.route.id === 'login')
      return (
        <main>
          <LoginScreen />
        </main>
      );
    const query = router.search.toString();
    const target = query ? `${router.path}?${query}` : router.path;
    const next = target === '/' ? '' : `?siguiente=${encodeURIComponent(target)}`;
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
      case 'vehicles':
        screen = <VehiclesScreen />;
        break;
      case 'vehicleNew':
        screen = <VehicleCreateScreen />;
        break;
      case 'vehicleDetail':
        screen = <VehicleDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'vehicleEdit':
        screen = <VehicleEditScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'assignments':
        screen = <AssignmentsScreen />;
        break;
      case 'assignmentNew':
        screen = <AssignmentCreateScreen />;
        break;
      case 'assignmentDetail':
        screen = <AssignmentDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'assignmentEnd':
        screen = <AssignmentEndScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'imports':
        screen = <ImportsScreen />;
        break;
      case 'importNew':
        screen = <ImportCreateScreen />;
        break;
      case 'importDetail':
        screen = <ImportDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'employees':
        screen = <EmployeesScreen />;
        break;
      case 'employeeNew':
        screen = <EmployeeCreateScreen />;
        break;
      case 'employeeDetail':
        screen = <EmployeeDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'employeeEdit':
        screen = <EmployeeEditScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'areas':
        screen = <AreasScreen />;
        break;
      case 'areaNew':
        screen = <AreaCreateScreen />;
        break;
      case 'areaDetail':
        screen = <AreaDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'areaEdit':
        screen = <AreaEditScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'areaMove':
        screen = <AreaMoveScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'documents':
        screen = <DocumentsScreen />;
        break;
      case 'documentNew':
        screen = <DocumentCreateScreen />;
        break;
      case 'documentDetail':
        screen = <DocumentDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'documentEdit':
        screen = <DocumentEditScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'documentRenew':
        screen = <DocumentRenewScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'policies':
        screen = <PoliciesScreen />;
        break;
      case 'policyNew':
        screen = <PolicyCreateScreen />;
        break;
      case 'policyDetail':
        screen = <PolicyDetailScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'policyEdit':
        screen = <PolicyEditScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'policyRenew':
        screen = <PolicyRenewScreen key={match.params.id} id={match.params.id as string} />;
        break;
      case 'alerts':
        screen = <AlertsScreen />;
        break;
      case 'alertSettings':
        screen = <AlertSettingsScreen />;
        break;
      case 'invitation':
        screen = (
          <UiState
            kind="closed"
            title="Ya tienes una sesión activa"
            description="Cierra sesión si quieres aceptar una invitación con otra cuenta."
          />
        );
        break;
      default:
        screen = null;
    }

  return (
    <AppShell
      session={session}
      currentRouteId={navigationRoute(match?.route.id ?? null)}
      can={can}
      onSignOut={() => void logout().then((result) => setSignOutFailed(!result.ok))}
      locked={expired}
    >
      {signOutFailed && !expired && (
        <UiState
          kind="error"
          title="No pudimos cerrar sesión"
          description="Tu sesión sigue abierta. Intenta nuevamente."
        />
      )}
      {expired && <SessionExpiredPanel />}
      {/* Keyed by user: signing back in as someone else drops the previous person's screen state. */}
      <div key={session.user.id} inert={expired}>
        {screen}
      </div>
    </AppShell>
  );
}
