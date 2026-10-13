import React from 'react';
import { UiState } from '@opslog/ui';
import { loadDriverOptions } from '../../app/driverOptions';
import { useRouter } from '../../app/router';
import { loadVehicleOptions, type VehicleOptions } from '../../app/vehicleOptions';
import { useSession } from '../../auth/session';
import { DirectoryProvider, type DirectoryOption } from '../maintenance/directory';
import { loadMemberOptions } from '../maintenance/members';
import { IncidentDetail } from './IncidentDetail';
import { IncidentListScreen } from './IncidentListScreen';
import { IncidentWizard } from './IncidentWizard';
import { IncidentEnvProvider, type IncidentEnv } from './env';
import { mayStartIncident, mayViewIncidents } from './model';
import { DEFAULT_ZONE } from './time';

export type IncidentView = 'list' | 'new' | 'detail';

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, 'es');

/**
 * Shell entry for incidents (INC-UI): builds what every incident screen needs from the session (ports, grants,
 * the caller, the company's zone, people, drivers and vehicles by name) and picks the view from the address:
 * the list, the wizard (`/incidents/new?borrador=...`) or one case in a tab (`/incidents/:id/:tab`). Without
 * `incidents:view` nothing is requested and the screen says so; the wizard needs a creation grant.
 */
export function IncidentsScreen({
  view,
  id,
  tab,
}: {
  view: IncidentView;
  id?: string;
  tab?: string;
}) {
  const { state, ports, can, markExpired } = useSession();
  const router = useRouter();
  const permissions =
    state.status === 'authenticated' || state.status === 'expired' ? state.session.permissions : [];
  const userId =
    state.status === 'authenticated' || state.status === 'expired' ? state.session.user.id : '';
  const mayView = mayViewIncidents(permissions);
  const [vehicles, setVehicles] = React.useState<VehicleOptions | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [members, setMembers] = React.useState<readonly DirectoryOption[]>([]);
  const [drivers, setDrivers] = React.useState<readonly DirectoryOption[]>([]);
  const [zone, setZone] = React.useState(DEFAULT_ZONE);
  const [photoRequired, setPhotoRequired] = React.useState(false);
  const mayListMembers = can('manage_users');

  React.useEffect(() => {
    if (!mayView) return;
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
  }, [ports, mayView, attempt]);
  React.useEffect(() => {
    if (!mayView) return;
    let current = true;
    void ports.alerts.settings().then((result) => {
      if (!current || !result.ok) return;
      setZone(result.value.timeZone);
      setPhotoRequired(result.value.incidentReportPhoto === 'photo_required');
    });
    void loadDriverOptions(ports.employees).then((result) => {
      if (current && result.ok)
        setDrivers(
          result.value.items.map((item) => ({ id: item.id, label: item.label })).sort(byLabel),
        );
    });
    return () => {
      current = false;
    };
  }, [ports, mayView]);
  React.useEffect(() => {
    if (!mayView || !mayListMembers) return;
    let current = true;
    void loadMemberOptions(ports.users).then((loaded) => {
      if (current && loaded) setMembers(loaded.items);
    });
    return () => {
      current = false;
    };
  }, [ports, mayView, mayListMembers]);

  const env = React.useMemo<IncidentEnv>(
    () => ({
      ports: ports.incidents,
      permissions,
      userId,
      zone,
      members: [{ id: userId, label: 'Tú' }, ...members.filter((member) => member.id !== userId)],
      drivers,
      mayChangeVehicles: permissions.includes('edit'),
      photoRequired,
      onExpired: markExpired,
    }),
    [ports, permissions, userId, zone, members, drivers, photoRequired],
  );
  const directory = React.useMemo(
    () => ({
      vehicles: vehicles ? [...vehicles.items].sort(byLabel) : null,
      vehiclesTruncated: vehicles?.truncated ?? false,
      members: [],
      membersTruncated: false,
      reloadVehicles: () => setAttempt((value) => value + 1),
    }),
    [vehicles],
  );

  if (state.status !== 'authenticated' && state.status !== 'expired') return null;
  if (!mayView || (view === 'new' && !mayStartIncident(permissions)))
    return <UiState kind="no-permission" />;
  return (
    <IncidentEnvProvider value={env}>
      <DirectoryProvider value={directory}>
        {view === 'list' && <IncidentListScreen key={router.path} />}
        {view === 'new' && <IncidentWizard />}
        {view === 'detail' && id !== undefined && <IncidentDetail key={id} id={id} tab={tab} />}
      </DirectoryProvider>
    </IncidentEnvProvider>
  );
}
