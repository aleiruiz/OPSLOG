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
import type { ImportEntity, ImportJob, ImportStatus } from '../app/types';
import { importPath, importsPath } from './ImportMessages';
import {
  entityLabel,
  entityLabels,
  formatDateTime,
  modeLabel,
  statusOrder,
  statusPresentation,
} from './labels';

export interface ImportFilters {
  readonly entity: ImportEntity | '';
  readonly status: ImportStatus | '';
}

export const noFilters: ImportFilters = { entity: '', status: '' };

export interface ImportListData {
  readonly items: readonly ImportJob[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface ImportListViewProps {
  readonly state: ResourceState<ImportListData>;
  readonly filters: ImportFilters;
  readonly can: (permission: 'create') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: ImportFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Import history: filters, cursor-paginated table of jobs and every data state (SPECS §8, S27). */
export function ImportListView({
  state,
  filters,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: ImportListViewProps) {
  const uid = React.useId();
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
        title="Importaciones"
        description="Alta masiva de vehículos y empleados desde un archivo CSV: valida primero, importa después y consulta aquí qué pasó con cada fila."
        actions={
          can('create') ? (
            <RouterButton to={`${importsPath}/nueva`} variant="contained">
              Nueva importación
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
            'entity',
            'Qué se importó',
            filters.entity,
            (value) => onFiltersChange({ ...filters, entity: value as ImportEntity | '' }),
            <>
              <option value="">Vehículos y empleados</option>
              {(Object.keys(entityLabels) as ImportEntity[]).map((entity) => (
                <option key={entity} value={entity}>
                  {entityLabels[entity]}
                </option>
              ))}
            </>,
          )}
          {select(
            'status',
            'Estado',
            filters.status,
            (value) => onFiltersChange({ ...filters, status: value as ImportStatus | '' }),
            <>
              <option value="">Todos los estados</option>
              {statusOrder.map((status) => (
                <option key={status} value={status}>
                  {statusPresentation[status].label}
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
                title="Aún no hay importaciones"
                description={
                  can('create')
                    ? 'Valida un archivo CSV para empezar. Las validaciones también quedan en el historial.'
                    : 'Cuando se importen archivos aparecerán aquí.'
                }
              />
            );
          return (
            <>
              <ScrollRegion label="Tabla de importaciones">
                <DataTable<ImportJob>
                  caption={`Importaciones (${page.total})`}
                  columns={[
                    {
                      key: 'createdAt',
                      label: 'Fecha',
                      render: (_, row) => (
                        <RouterLink
                          to={importPath(row.id)}
                          label={`Importación de ${entityLabel(row.entity).toLowerCase()} del ${formatDateTime(row.createdAt)}`}
                          sx={linkSx}
                        >
                          {formatDateTime(row.createdAt)}
                        </RouterLink>
                      ),
                    },
                    {
                      key: 'entity',
                      label: 'Qué',
                      render: (value) => entityLabel(String(value)),
                    },
                    { key: 'mode', label: 'Modo', render: (value) => modeLabel(String(value)) },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as ImportStatus];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'totalRows',
                      label: 'Filas',
                      render: (_, row) => (
                        <>
                          {row.totalRows}
                          <Typography variant="body2" color="text.secondary">
                            {row.validRows} válidas · {row.invalidRows} con error ·{' '}
                            {row.importedRows} importadas
                          </Typography>
                        </>
                      ),
                    },
                    { key: 'createdBy', label: 'Por' },
                  ]}
                  rows={[...page.items]}
                />
              </ScrollRegion>
              {page.nextCursor && (
                <Button
                  variant="outlined"
                  loading={loadingMore}
                  onClick={() => onLoadMore(page.nextCursor as string)}
                >
                  Cargar más importaciones
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
