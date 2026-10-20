import React from 'react';
import { useRouter } from '../../app/router';
import { loadVehicleOptions, type VehicleOptions } from '../../app/vehicleOptions';
import { useSession } from '../../auth/session';
import type { MemberOption } from './CatalogForms';
import { MaintenanceArea } from './MaintenanceArea';
import { loadMemberOptions } from './members';

export const maintenancePath = '/flota/mantenimiento';
export const maintenanceOrderPath = (orderId: string): string =>
  `${maintenancePath}/ordenes/${encodeURIComponent(orderId)}`;

/**
 * Shell entry for maintenance: the session's ports, grants and user, with the shared 401 handling.
 * The open order lives in the address (`/flota/mantenimiento/ordenes/:id`), so it can be linked
 * and the browser's back button returns to the list. Vehicles are always loaded for the pickers;
 * company members come from the user directory when the session may read it (`manage_users`),
 * otherwise only the caller and the members linked to mechanics can be chosen by name.
 */
export function MaintenanceScreen({ orderId = null }: { orderId?: string | null }) {
  const { state, ports, can, markExpired } = useSession();
  const router = useRouter();
  const [members, setMembers] = React.useState<{
    items: readonly MemberOption[];
    truncated: boolean;
  }>({ items: [], truncated: false });
  const [vehicles, setVehicles] = React.useState<VehicleOptions | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const mayListMembers = can('manage_users');
  React.useEffect(() => {
    if (!mayListMembers) return;
    let current = true;
    void loadMemberOptions(ports.users).then((loaded) => {
      if (current && loaded) setMembers(loaded);
    });
    return () => {
      current = false;
    };
  }, [ports, mayListMembers]);
  React.useEffect(() => {
    let current = true;
    void loadVehicleOptions(ports.vehicles).then((result) => {
      if (!current) return;
      if (result.ok) setVehicles(result.value);
      else {
        setVehicles(null);
        if (result.error.status === 401) markExpired();
      }
    });
    return () => {
      current = false;
    };
  }, [ports, attempt]);
  if (state.status !== 'authenticated' && state.status !== 'expired') return null;
  return (
    <MaintenanceArea
      ports={ports.maintenance}
      permissions={state.session.permissions}
      userId={state.session.user.id}
      members={members.items}
      membersTruncated={members.truncated}
      vehicles={vehicles ? [...vehicles.items].sort(byLabel) : null}
      vehiclesTruncated={vehicles?.truncated ?? false}
      onRetryVehicles={() => setAttempt((value) => value + 1)}
      orderId={orderId}
      onOrderChange={(next) => router.navigate(next ? maintenanceOrderPath(next) : maintenancePath)}
      onExpired={markExpired}
      views={ports.views}
    />
  );
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, 'es');
