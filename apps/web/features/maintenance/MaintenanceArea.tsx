import React from 'react';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { UiState } from '@opslog/ui';
import type { BffMaintenanceMechanic, BffMaintenanceWorkshop } from '@opslog/contracts';
import { CatalogScreen, type MemberOption } from './CatalogScreen';
import { MaintenanceSettingsScreen } from './MaintenanceSettingsScreen';
import { MyOrdersScreen } from './MyOrdersScreen';
import { PlansScreen } from './PlansScreen';
import type { MaintenancePorts } from './ports';
import { WorkOrderDetail } from './WorkOrderDetail';
import { WorkOrdersScreen } from './WorkOrdersScreen';
import type { MaintenanceViewer } from './workflow';

export type MaintenanceView = 'orders' | 'mine' | 'plans' | 'catalog' | 'settings';
const VIEWS: readonly { id: MaintenanceView; label: string; permission?: string }[] = [
  { id: 'orders', label: 'Órdenes' },
  { id: 'mine', label: 'Mis órdenes' },
  { id: 'plans', label: 'Planes' },
  { id: 'catalog', label: 'Talleres y mecánicos' },
  { id: 'settings', label: 'Configuración', permission: 'manage_config' },
];

/**
 * The maintenance feature behind one entry point. Routing and navigation belong to the shell
 * (MNT-INTEGRATE); this component only needs the ports and who the caller is.
 */
export function MaintenanceArea({
  ports,
  permissions,
  userId,
  members = [],
  initialView = 'orders',
  onExpired,
}: {
  ports: MaintenancePorts;
  permissions: readonly string[];
  userId: string;
  members?: readonly MemberOption[];
  initialView?: MaintenanceView;
  onExpired: () => void;
}) {
  const [view, setView] = React.useState<MaintenanceView>(initialView);
  const [orderId, setOrderId] = React.useState<string | null>(null);
  const [workshops, setWorkshops] = React.useState<readonly BffMaintenanceWorkshop[]>([]);
  const [mechanics, setMechanics] = React.useState<readonly BffMaintenanceMechanic[]>([]);
  const [mechanicsFailed, setMechanicsFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    // Names for display and the caller's own mechanic records; the server keeps the authority.
    void Promise.all([ports.workshops.list(), ports.mechanics.list()]).then(([w, m]) => {
      if (!current) return;
      if (w.ok) setWorkshops(w.value);
      if (m.ok) setMechanics(m.value);
      else if (m.error.status === 401) onExpired();
      setMechanicsFailed(!m.ok);
    });
    return () => {
      current = false;
    };
  }, [ports, view, attempt]);
  const viewer: MaintenanceViewer = {
    permissions,
    mechanicIds: mechanics.filter((m) => m.active && m.memberId === userId).map((m) => m.id),
  };
  return (
    <Box component="section" aria-label="Mantenimiento">
      <Tabs
        value={view}
        onChange={(_event, next: MaintenanceView) => {
          setView(next);
          setOrderId(null);
        }}
        aria-label="Secciones de mantenimiento"
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2 }}
      >
        {VIEWS.filter((item) => !item.permission || permissions.includes(item.permission)).map(
          (item) => (
            <Tab key={item.id} value={item.id} label={item.label} />
          ),
        )}
      </Tabs>
      {orderId ? (
        <WorkOrderDetail
          ports={ports}
          viewer={viewer}
          orderId={orderId}
          workshops={workshops}
          mechanics={mechanics}
          onBack={() => setOrderId(null)}
          onExpired={onExpired}
        />
      ) : view === 'orders' ? (
        <WorkOrdersScreen ports={ports} viewer={viewer} onOpen={setOrderId} onExpired={onExpired} />
      ) : view === 'mine' && mechanicsFailed ? (
        // Without the caller's mechanic records an empty list would be misleading.
        <UiState
          kind="error"
          description="No pudimos identificar tus órdenes asignadas."
          actionLabel="Reintentar"
          onAction={() => setAttempt((value) => value + 1)}
        />
      ) : view === 'mine' ? (
        <MyOrdersScreen ports={ports} viewer={viewer} onOpen={setOrderId} onExpired={onExpired} />
      ) : view === 'plans' ? (
        <PlansScreen
          ports={ports}
          viewer={viewer}
          workshops={workshops}
          mechanics={mechanics}
          onOpenOrder={setOrderId}
          onExpired={onExpired}
        />
      ) : view === 'settings' ? (
        <MaintenanceSettingsScreen ports={ports} onExpired={onExpired} />
      ) : (
        <CatalogScreen ports={ports} viewer={viewer} members={members} onExpired={onExpired} />
      )}
    </Box>
  );
}
