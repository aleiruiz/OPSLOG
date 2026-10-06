import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  DataTable,
  Field,
  FilterBar,
  Notifications,
  opslogTokens,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { NoSubmit, ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import { ScrollRegion } from '../app/ScrollRegion';
import type { Vehicle, VehicleStatus } from '../app/types';
import { formatKm, isEditable, statusOrder, statusPresentation } from './labels';

export interface VehicleFilters {
  readonly status: VehicleStatus | '';
  readonly areaId: string;
  readonly includeArchived: boolean;
}

export const noFilters: VehicleFilters = { status: '', areaId: '', includeArchived: false };

export interface VehicleListData {
  readonly items: readonly Vehicle[];
  readonly total: number;
  readonly nextCursor: string | null;
}

interface Row extends Vehicle {
  actions: string;
}

export interface VehicleListViewProps {
  readonly state: ResourceState<VehicleListData>;
  readonly filters: VehicleFilters;
  /** Message for an area filter that is not a valid identifier (it is not applied until it is). */
  readonly areaError?: string | undefined;
  readonly can: (permission: 'create' | 'edit') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: VehicleFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const detailPath = (id: string) => `/flota/vehiculos/${encodeURIComponent(id)}`;

/** Vehicle list: filters, cursor-paginated table and every data state (SPECS §8). */
export function VehicleListView({
  state,
  filters,
  areaError,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: VehicleListViewProps) {
  const uid = React.useId();
  return (
    <>
      <PageHeader
        title="Vehículos"
        description="Flota de tu empresa: consulta, alta y edición de unidades."
        actions={
          can('create') ? (
            <RouterButton to="/flota/vehiculos/nuevo" variant="contained">
              Nuevo vehículo
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
          <Field
            id={`${uid}-status`}
            label="Estado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={filters.status}
            onChange={(event) =>
              onFiltersChange({ ...filters, status: event.target.value as VehicleStatus | '' })
            }
          >
            <option value="">Todos los estados</option>
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {statusPresentation[status].label}
              </option>
            ))}
          </Field>
          <Field
            id={`${uid}-area`}
            label="Identificador de área"
            value={filters.areaId}
            onChange={(event) => onFiltersChange({ ...filters, areaId: event.target.value })}
            error={Boolean(areaError)}
            {...(areaError ? { helperText: areaError } : {})}
          />
          <Field
            id={`${uid}-archived`}
            label="Archivados"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={filters.includeArchived ? 'true' : 'false'}
            onChange={(event) =>
              onFiltersChange({ ...filters, includeArchived: event.target.value === 'true' })
            }
          >
            <option value="false">Ocultar archivados</option>
            <option value="true">Incluir archivados</option>
          </Field>
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
                title="Aún no hay vehículos"
                description={
                  can('create')
                    ? 'Registra el primer vehículo de tu flota.'
                    : 'Cuando se registren vehículos aparecerán aquí.'
                }
              />
            );
          const rows: Row[] = page.items.map((vehicle) => ({ ...vehicle, actions: vehicle.id }));
          return (
            <>
              <ScrollRegion label="Tabla de vehículos">
                <DataTable<Row>
                  caption={`Vehículos (${page.total})`}
                  columns={[
                    {
                      key: 'economicNumber',
                      label: 'Número económico',
                      render: (_, row) => (
                        <>
                          <RouterLink
                            to={detailPath(row.id)}
                            sx={{
                              fontFamily: opslogTokens.typography.monoFamily,
                              color: 'primary.main',
                              textDecoration: 'underline',
                            }}
                          >
                            {row.economicNumber}
                          </RouterLink>
                          {row.archivedAt !== null && (
                            <StatusBadge label="Archivado" tone="neutral" />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'plate',
                      label: 'Placa',
                      render: (value) => (
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{ fontFamily: opslogTokens.typography.monoFamily }}
                        >
                          {String(value)}
                        </Typography>
                      ),
                    },
                    {
                      key: 'make',
                      label: 'Marca y modelo',
                      render: (_, row) => `${row.make} ${row.model}`,
                    },
                    { key: 'year', label: 'Año' },
                    { key: 'areaId', label: 'Área' },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as VehicleStatus];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'odometerKm',
                      label: 'Odómetro',
                      render: (value) => formatKm(Number(value)),
                    },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) =>
                        can('edit') && isEditable(row) ? (
                          <RouterLink
                            to={`${detailPath(row.id)}/editar`}
                            label={`Editar ${row.economicNumber}`}
                            sx={{ color: 'primary.main', textDecoration: 'underline' }}
                          >
                            Editar
                          </RouterLink>
                        ) : null,
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
                  Cargar más vehículos
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
