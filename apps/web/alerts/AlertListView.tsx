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
import { NoSubmit, ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import { ScrollRegion } from '../app/ScrollRegion';
import type { Alert, AlertSeverity, AlertSource } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  alertRecordPath,
  alertSettingsPath,
  alertTitle,
  expiryNote,
  formatDate,
  severityOrder,
  severityPresentation,
  sourceChoiceLabels,
  sourceLabels,
  sourceOrder,
} from './labels';

export interface AlertFilters {
  readonly source: AlertSource | '';
  readonly severity: AlertSeverity | '';
  readonly vehicleId: string;
}

export const noFilters: AlertFilters = { source: '', severity: '', vehicleId: '' };

export interface AlertListData {
  readonly items: readonly Alert[];
  readonly total: number;
  readonly nextCursor: string | null;
  /** `YYYY-MM-DD`: the server date the alerts were derived for. */
  readonly asOf: string;
  readonly windowDays: number;
}

interface Row extends Alert {
  id: string;
}

export interface AlertListViewProps {
  readonly state: ResourceState<AlertListData>;
  readonly filters: AlertFilters;
  /** Vehicles for the filter and for naming them; `null` when they could not be loaded. */
  readonly vehicles: VehicleOptions | null;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: AlertFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

const plural = (count: number) => `${count} ${count === 1 ? 'día' : 'días'}`;

/** Expiry alerts: filters, cursor-paginated table and every data state (SPECS §8). Read-only: alerts are derived. */
export function AlertListView({
  state,
  filters,
  vehicles,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: AlertListViewProps) {
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
  const ready = state.status === 'ready' ? state.data : null;

  return (
    <>
      <PageHeader
        title="Alertas"
        description={
          ready
            ? `Documentos de vehículo y seguros que vencen en los próximos ${plural(ready.windowDays)} o que ya vencieron, al ${formatDate(ready.asOf)}.`
            : 'Documentos de vehículo y seguros por vencer o vencidos.'
        }
        actions={
          <RouterButton to={alertSettingsPath} variant="outlined">
            Ajustes de alertas
          </RouterButton>
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
            'source',
            'Origen',
            filters.source,
            (value) => onFiltersChange({ ...filters, source: value as AlertSource | '' }),
            <>
              <option value="">Todos los orígenes</option>
              {sourceOrder.map((source) => (
                <option key={source} value={source}>
                  {sourceChoiceLabels[source]}
                </option>
              ))}
            </>,
          )}
          {select(
            'severity',
            'Estado',
            filters.severity,
            (value) => onFiltersChange({ ...filters, severity: value as AlertSeverity | '' }),
            <>
              <option value="">Todos los estados</option>
              {severityOrder.map((severity) => (
                <option key={severity} value={severity}>
                  {severityPresentation[severity].label}
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
                title="Sin vencimientos pendientes"
                description={`Ningún documento ni seguro vence en los próximos ${plural(page.windowDays)} y no hay vencidos.`}
              />
            );
          const rows: Row[] = page.items.map((alert) => ({ ...alert, id: alert.key }));
          return (
            <>
              <ScrollRegion label="Tabla de alertas">
                <DataTable<Row>
                  caption={`Alertas (${page.total})`}
                  columns={[
                    {
                      key: 'typeCode',
                      label: 'Registro',
                      render: (_, row) => (
                        <>
                          <RouterLink
                            to={alertRecordPath(row)}
                            label={`Ver ${sourceLabels[row.source].toLowerCase()}: ${alertTitle(row)}`}
                            sx={linkSx}
                          >
                            {alertTitle(row)}
                          </RouterLink>
                          <Typography variant="body2" color="text.secondary">
                            {sourceLabels[row.source]}
                          </Typography>
                        </>
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
                      key: 'dueOn',
                      label: 'Vencimiento',
                      render: (_, row) => (
                        <>
                          {formatDate(row.dueOn)}
                          <Typography variant="body2" color="text.secondary">
                            {expiryNote(row.daysToExpiry)}
                          </Typography>
                        </>
                      ),
                    },
                    {
                      key: 'severity',
                      label: 'Estado',
                      render: (value) => {
                        const view = severityPresentation[value as AlertSeverity];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                  ]}
                  rows={rows}
                />
              </ScrollRegion>
              {page.nextCursor && (
                <Box>
                  <Button
                    variant="outlined"
                    loading={loadingMore}
                    onClick={() => onLoadMore(page.nextCursor as string)}
                  >
                    Cargar más alertas
                  </Button>
                </Box>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
