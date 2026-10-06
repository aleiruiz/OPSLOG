import Box from '@mui/material/Box';
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
import type { CoverageType, InsurancePolicy, PolicyStatus } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  coverageLabel,
  coverageLabels,
  expiryNote,
  formatDate,
  isEditable,
  notStarted,
  statusOrder,
  statusPresentation,
} from './labels';
import { COVERAGE_TYPES } from './rules';
import { policiesPath, policyPath } from './PolicyMessages';

export interface PolicyFilters {
  readonly status: PolicyStatus | '';
  readonly vehicleId: string;
  readonly coverageType: CoverageType | '';
  /** `YYYY-MM-DD`: only policies whose period contains this day (BR-019). */
  readonly coversOn: string;
  readonly includeArchived: boolean;
}

export const noFilters: PolicyFilters = {
  status: '',
  vehicleId: '',
  coverageType: '',
  coversOn: '',
  includeArchived: false,
};

export interface PolicyListData {
  readonly items: readonly InsurancePolicy[];
  readonly total: number;
  readonly nextCursor: string | null;
}

interface Row extends InsurancePolicy {
  actions: string;
}

export interface PolicyListViewProps {
  readonly state: ResourceState<PolicyListData>;
  readonly filters: PolicyFilters;
  /** Vehicles for the filter and for naming them; `null` when they could not be loaded. */
  readonly vehicles: VehicleOptions | null;
  /** Message for a date filter that is not a valid day (it is not applied until it is). */
  readonly dateError?: string | undefined;
  readonly can: (permission: 'create' | 'edit') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: PolicyFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Policy list: filters, cursor-paginated table and every data state (SPECS §8). */
export function PolicyListView({
  state,
  filters,
  vehicles,
  dateError,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: PolicyListViewProps) {
  const uid = React.useId();
  const names = new Map((vehicles?.items ?? []).map((item) => [item.id, item.economicNumber]));
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
        title="Seguros"
        description="Pólizas de seguro de tus vehículos: consulta, alta, renovación y archivado."
        actions={
          can('create') ? (
            <RouterButton to={`${policiesPath}/nueva`} variant="contained">
              Nueva póliza
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
            (value) => onFiltersChange({ ...filters, status: value as PolicyStatus | '' }),
            <>
              <option value="">Todos los estados</option>
              {statusOrder.map((status) => (
                <option key={status} value={status}>
                  {statusPresentation[status].label}
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
          {select(
            'coverage',
            'Cobertura',
            filters.coverageType,
            (value) => onFiltersChange({ ...filters, coverageType: value as CoverageType | '' }),
            <>
              <option value="">Todas las coberturas</option>
              {COVERAGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {coverageLabels[type]}
                </option>
              ))}
            </>,
          )}
          <Field
            id={`${uid}-covers-on`}
            label="Vigente a la fecha"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={filters.coversOn}
            onChange={(event) => onFiltersChange({ ...filters, coversOn: event.target.value })}
            error={Boolean(dateError)}
            helperText={dateError ?? 'Pólizas que cubren ese día, extremos incluidos.'}
          />
          {select(
            'archived',
            'Archivadas',
            filters.includeArchived ? 'true' : 'false',
            (value) => onFiltersChange({ ...filters, includeArchived: value === 'true' }),
            <>
              <option value="false">Ocultar archivadas</option>
              <option value="true">Incluir archivadas</option>
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
                title="Aún no hay pólizas"
                description={
                  can('create')
                    ? 'Registra la primera póliza de seguro de tu flota.'
                    : 'Cuando se registren pólizas aparecerán aquí.'
                }
              />
            );
          const rows: Row[] = page.items.map((policy) => ({ ...policy, actions: policy.id }));
          return (
            <>
              <ScrollRegion label="Tabla de pólizas">
                <DataTable<Row>
                  caption={`Pólizas (${page.total})`}
                  columns={[
                    {
                      key: 'insurer',
                      label: 'Aseguradora',
                      render: (_, row) => (
                        <>
                          <RouterLink to={policyPath(row.id)} sx={linkSx}>
                            {row.insurer}
                          </RouterLink>
                          {row.archivedAt !== null && (
                            <StatusBadge label="Archivada" tone="neutral" />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'policyNumber',
                      label: 'Póliza',
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
                      key: 'vehicleId',
                      label: 'Vehículo',
                      render: (_, row) => (
                        <RouterLink
                          to={`/flota/vehiculos/${encodeURIComponent(row.vehicleId)}`}
                          label={`Vehículo ${names.get(row.vehicleId) ?? row.vehicleId}`}
                          sx={linkSx}
                        >
                          {names.get(row.vehicleId) ?? 'Vehículo'}
                        </RouterLink>
                      ),
                    },
                    {
                      key: 'coverageType',
                      label: 'Cobertura',
                      render: (value) => coverageLabel(String(value)),
                    },
                    {
                      key: 'endsOn',
                      label: 'Vigencia',
                      render: (_, row) => (
                        <>
                          {formatDate(row.startsOn)} – {formatDate(row.endsOn)}
                          <Typography variant="body2" color="text.secondary">
                            {notStarted(row) ? 'Aún no inicia' : expiryNote(row.daysToExpiry)}
                          </Typography>
                        </>
                      ),
                    },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as PolicyStatus];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) =>
                        can('edit') && isEditable(row) ? (
                          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                            <RouterLink
                              to={`${policyPath(row.id)}/editar`}
                              label={`Editar ${row.policyNumber}`}
                              sx={linkSx}
                            >
                              Editar
                            </RouterLink>
                            <RouterLink
                              to={`${policyPath(row.id)}/renovar`}
                              label={`Renovar ${row.policyNumber}`}
                              sx={linkSx}
                            >
                              Renovar
                            </RouterLink>
                          </Box>
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
                  Cargar más pólizas
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
