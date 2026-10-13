import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { Button, DataTable, PageHeader, Panel, StatusBadge, UiState } from '@opslog/ui';
import type { BffMaintenanceMechanic, BffMaintenanceWorkshop } from '@opslog/contracts';
import { MechanicForm, WorkshopForm, type MemberOption } from './CatalogForms';

export type { MemberOption };
import type { MaintenancePorts, Result } from './ports';
import { errorKind, useResult } from './useResult';
import type { MaintenanceViewer } from './workflow';

const active = (value: boolean) => (
  <StatusBadge label={value ? 'Activo' : 'Inactivo'} tone={value ? 'success' : 'neutral'} />
);

/** FR-095/096: workshops and mechanics of the company. External mechanics never get an account. */
export function CatalogScreen({
  ports,
  viewer,
  members = [],
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  members?: readonly MemberOption[];
  onExpired: () => void;
}) {
  const workshops = useResult(() => ports.workshops.list(), [ports], onExpired);
  const mechanics = useResult(() => ports.mechanics.list(), [ports], onExpired);
  const [notice, setNotice] = React.useState<string | null>(null);
  const canCreate = viewer.permissions.includes('create');
  const canEdit = viewer.permissions.includes('edit');
  const act = async <T,>(call: () => Promise<Result<T>>, reload: () => void) => {
    const result = await call();
    if (result.ok) {
      setNotice(null);
      reload();
      return true;
    }
    if (result.error.status === 401) onExpired();
    setNotice(
      result.error.status === 409
        ? 'El taller o la persona elegida no está disponible en tu empresa.'
        : result.error.status === 403
          ? 'No tienes permiso para esta acción.'
          : 'No pudimos guardar el cambio. Intenta nuevamente.',
    );
    return false;
  };
  if (workshops.state.status === 'loading' || mechanics.state.status === 'loading')
    return <UiState kind="loading" />;
  if (workshops.state.status === 'error')
    return (
      <UiState
        kind={errorKind(workshops.state.error)}
        actionLabel="Reintentar"
        onAction={workshops.reload}
      />
    );
  if (mechanics.state.status === 'error')
    return (
      <UiState
        kind={errorKind(mechanics.state.error)}
        actionLabel="Reintentar"
        onAction={mechanics.reload}
      />
    );
  const workshopRows = workshops.state.data;
  const mechanicRows = mechanics.state.data;
  return (
    <Box>
      <PageHeader
        eyebrow="Mantenimiento"
        title="Talleres y mecánicos"
        description="Catálogo de tu empresa para asignar órdenes."
      />
      {notice && (
        <Alert severity="error" role="alert" sx={{ mb: 2 }}>
          {notice}
        </Alert>
      )}
      <Box>
        <Panel
          title="Talleres"
          flush={workshopRows.length > 0}
          {...(canCreate
            ? {
                toolbar: (
                  <WorkshopForm
                    onSubmit={(body) => act(() => ports.workshops.create(body), workshops.reload)}
                  />
                ),
              }
            : {})}
        >
          {workshopRows.length === 0 ? (
            <UiState kind="empty" title="Aún no hay talleres" />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <DataTable<BffMaintenanceWorkshop & { actions: null }>
                caption={`${workshopRows.length} talleres`}
                rows={workshopRows.map((w) => ({ ...w, actions: null }))}
                columns={[
                  { key: 'name', label: 'Nombre' },
                  {
                    key: 'specialties',
                    label: 'Especialidades',
                    render: (_v, row) => row.specialties.join(', ') || 'Sin especialidad',
                  },
                  {
                    key: 'contact',
                    label: 'Contacto',
                    render: (_v, row) => row.contact ?? 'Sin contacto',
                  },
                  { key: 'active', label: 'Estado', render: (_v, row) => active(row.active) },
                  {
                    key: 'actions',
                    label: 'Acciones',
                    render: (_v, row) =>
                      canEdit && row.active ? (
                        <Button
                          size="small"
                          aria-label={`Desactivar ${row.name}`}
                          onClick={() =>
                            act(() => ports.workshops.deactivate(row.id), workshops.reload)
                          }
                        >
                          Desactivar
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Box>
          )}
        </Panel>
        <Panel
          title="Mecánicos"
          flush={mechanicRows.length > 0}
          {...(canCreate
            ? {
                toolbar: (
                  <MechanicForm
                    workshops={workshopRows.filter((w) => w.active)}
                    members={members}
                    onSubmit={(body) => act(() => ports.mechanics.create(body), mechanics.reload)}
                  />
                ),
              }
            : {})}
        >
          {mechanicRows.length === 0 ? (
            <UiState kind="empty" title="Aún no hay mecánicos" />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <DataTable<BffMaintenanceMechanic & { actions: null }>
                caption={`${mechanicRows.length} mecánicos`}
                rows={mechanicRows.map((m) => ({ ...m, actions: null }))}
                columns={[
                  { key: 'name', label: 'Nombre' },
                  {
                    key: 'kind',
                    label: 'Vínculo',
                    render: (_v, row) =>
                      row.kind === 'internal'
                        ? 'Interno (usuario de la empresa)'
                        : 'Externo (sin cuenta)',
                  },
                  {
                    key: 'workshopId',
                    label: 'Taller',
                    render: (_v, row) =>
                      workshopRows.find((w) => w.id === row.workshopId)?.name ?? 'Sin taller',
                  },
                  { key: 'active', label: 'Estado', render: (_v, row) => active(row.active) },
                  {
                    key: 'actions',
                    label: 'Acciones',
                    render: (_v, row) =>
                      canEdit && row.active ? (
                        <Button
                          size="small"
                          aria-label={`Desactivar ${row.name}`}
                          onClick={() =>
                            act(() => ports.mechanics.deactivate(row.id), mechanics.reload)
                          }
                        >
                          Desactivar
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Box>
          )}
        </Panel>
      </Box>
    </Box>
  );
}
