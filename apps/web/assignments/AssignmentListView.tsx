import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  DataTable,
  Field,
  FilterBar,
  Notifications,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import type { DriverOptions } from '../app/driverOptions';
import { NoSubmit, ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import { ScrollRegion } from '../app/ScrollRegion';
import type { AssignmentStatus, AssignmentType, VehicleAssignment } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import { assignmentPath, assignmentsPath } from './AssignmentMessages';
import {
  endKindLabels,
  formatDateTime,
  isCurrent,
  statusOrder,
  statusFilterLabels,
  statusPresentation,
  typeLabel,
  typeLabels,
  typeOrder,
} from './labels';

export interface AssignmentFilters {
  readonly status: AssignmentStatus | '';
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: AssignmentType | '';
}

export const noFilters: AssignmentFilters = {
  status: '',
  vehicleId: '',
  employeeId: '',
  type: '',
};

export interface AssignmentListData {
  readonly items: readonly VehicleAssignment[];
  readonly total: number;
  readonly nextCursor: string | null;
}

interface Row extends VehicleAssignment {
  actions: string;
}

export interface AssignmentListViewProps {
  readonly state: ResourceState<AssignmentListData>;
  readonly filters: AssignmentFilters;
  /** Vehicles and drivers for the filters and for naming them; `null` when they could not be loaded. */
  readonly vehicles: VehicleOptions | null;
  readonly drivers: DriverOptions | null;
  readonly can: (permission: 'create' | 'edit') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: AssignmentFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Assignment list: filters, cursor-paginated table and every data state (SPECS §8). With a status filter off it is the history. */
export function AssignmentListView({
  state,
  filters,
  vehicles,
  drivers,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: AssignmentListViewProps) {
  const uid = React.useId();
  const vehicleNames = new Map((vehicles?.items ?? []).map((item) => [item.id, item.economicNumber]));
  const driverNames = new Map((drivers?.items ?? []).map((item) => [item.id, item.name]));
  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    children: React.ReactNode,
  ) => (
    <Field
      id={`${uid}-${id}`}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </Field>
  );

  return (
    <>
      <PageHeader
        title="Asignaciones"
        description="Quién conduce cada vehículo. Filtra por vehículo o por conductor para ver su asignación vigente y su historial."
        actions={
          can('create') ? (
            <RouterButton to={`${assignmentsPath}/nueva`} variant="contained">
              Nueva asignación
            </RouterButton>
          ) : undefined
        }
      />
      {notice && (
        <Notifications
          messages={[{ id: 'notice', text: notice.text, severity: notice.severity }]}
        />
      )}
      <NoSubmit>
        <FilterBar onClear={onClear}>
          {select(
            'status',
            'Estado',
            filters.status,
            (value) => onFiltersChange({ ...filters, status: value as AssignmentStatus | '' }),
            <>
              <option value="">Vigentes e historial</option>
              {statusOrder.map((status) => (
                <option key={status} value={status}>
                  {statusFilterLabels[status]}
                </option>
              ))}
            </>,
          )}
          {vehicles &&
            select(
              'vehicle',
              'Vehículo',
              filters.vehicleId,
              (value) => onFiltersChange({ ...filters, vehicleId: value }),
              <>
                <option value="">Todos los vehículos</option>
                {vehicles.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </>,
            )}
          {drivers &&
            select(
              'driver',
              'Conductor',
              filters.employeeId,
              (value) => onFiltersChange({ ...filters, employeeId: value }),
              <>
                <option value="">Todos los conductores</option>
                {drivers.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </>,
            )}
          {select(
            'type',
            'Tipo',
            filters.type,
            (value) => onFiltersChange({ ...filters, type: value as AssignmentType | '' }),
            <>
              <option value="">Todos los tipos</option>
              {typeOrder.map((type) => (
                <option key={type} value={type}>
                  {typeLabels[type]}
                </option>
              ))}
            </>,
          )}
        </FilterBar>
      </NoSubmit>
      <ResourceView state={state} onRetry={onRetry}>
        {(page) => {
          if (page.items.length === 0)
            return filtersActive ? (
              <UiState kind="no-results" />
            ) : (
              <UiState
                kind="empty"
                title="Aún no hay asignaciones"
                description={
                  can('create')
                    ? 'Asigna el primer conductor a un vehículo de tu flota.'
                    : 'Cuando se asignen conductores aparecerán aquí.'
                }
              />
            );
          const rows: Row[] = page.items.map((assignment) => ({
            ...assignment,
            actions: assignment.id,
          }));
          return (
            <>
              <ScrollRegion label="Tabla de asignaciones">
                <DataTable<Row>
                  caption={`Asignaciones (${page.total})`}
                  columns={[
                    {
                      key: 'vehicleId',
                      label: 'Vehículo',
                      render: (_, row) => (
                        <RouterLink
                          to={`/flota/vehiculos/${encodeURIComponent(row.vehicleId)}`}
                          label={`Vehículo ${vehicleNames.get(row.vehicleId) ?? row.vehicleId}`}
                          sx={linkSx}
                        >
                          {vehicleNames.get(row.vehicleId) ?? 'Vehículo'}
                        </RouterLink>
                      ),
                    },
                    {
                      key: 'employeeId',
                      label: 'Conductor',
                      render: (_, row) => (
                        <RouterLink
                          to={`/plantilla/empleados/${encodeURIComponent(row.employeeId)}`}
                          label={`Conductor ${driverNames.get(row.employeeId) ?? row.employeeId}`}
                          sx={linkSx}
                        >
                          {driverNames.get(row.employeeId) ?? 'Conductor'}
                        </RouterLink>
                      ),
                    },
                    { key: 'type', label: 'Tipo', render: (value) => typeLabel(String(value)) },
                    {
                      key: 'startedAt',
                      label: 'Inicio',
                      render: (value) => formatDateTime(String(value)),
                    },
                    {
                      key: 'endedAt',
                      label: 'Fin',
                      render: (_, row) =>
                        row.endedAt === null ? (
                          '—'
                        ) : (
                          <>
                            {formatDateTime(row.endedAt)}
                            {row.endKind && (
                              <Typography variant="body2" color="text.secondary">
                                {endKindLabels[row.endKind]}
                              </Typography>
                            )}
                          </>
                        ),
                    },
                    {
                      key: 'current',
                      label: 'Estado',
                      render: (_, row) => {
                        const view = statusPresentation[isCurrent(row) ? 'current' : 'ended'];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) => (
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                          <RouterLink
                            to={assignmentPath(row.id)}
                            label={`Ver asignación de ${driverNames.get(row.employeeId) ?? 'conductor'} en ${vehicleNames.get(row.vehicleId) ?? 'vehículo'}`}
                            sx={linkSx}
                          >
                            Ver
                          </RouterLink>
                          {can('edit') && isCurrent(row) && (
                            <RouterLink
                              to={`${assignmentPath(row.id)}/cerrar`}
                              label={`Cerrar asignación de ${driverNames.get(row.employeeId) ?? 'conductor'} en ${vehicleNames.get(row.vehicleId) ?? 'vehículo'}`}
                              sx={linkSx}
                            >
                              Cerrar
                            </RouterLink>
                          )}
                        </Box>
                      ),
                    },
                  ]}
                  rows={rows}
                />
              </ScrollRegion>
              {page.nextCursor && (
                <Button
                  variant="outlined"
                  loading={loadingMore}
                  onClick={() => onLoadMore(page.nextCursor as string)}
                >
                  Cargar más asignaciones
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
