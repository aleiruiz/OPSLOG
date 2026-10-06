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
import type { Area, Employee, EmployeeKind, EmployeeStatus } from '../app/types';
import { areaChoices } from '../areas/areaChoices';
import { AreaSelect } from '../areas/AreaSelect';
import { employeePath, employeesPath } from './EmployeeMessages';
import {
  fitnessPresentation,
  isEditable,
  kindLabels,
  kindOrder,
  listName,
  statusOrder,
  statusPresentation,
} from './labels';

export interface EmployeeFilters {
  readonly kind: EmployeeKind | '';
  readonly status: EmployeeStatus | '';
  readonly areaId: string;
  readonly includeArchived: boolean;
}

export const noFilters: EmployeeFilters = {
  kind: '',
  status: '',
  areaId: '',
  includeArchived: false,
};

export interface EmployeeListData {
  readonly items: readonly Employee[];
  readonly total: number;
  readonly nextCursor: string | null;
}

interface Row extends Employee {
  actions: string;
}

export interface EmployeeListViewProps {
  readonly state: ResourceState<EmployeeListData>;
  readonly filters: EmployeeFilters;
  /** The company's areas (every status): names for the column and options of the area filter. */
  readonly areas: readonly Area[];
  readonly can: (permission: 'create' | 'edit') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: EmployeeFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Employee list: filters, cursor-paginated table and every data state (SPECS §8). */
export function EmployeeListView({
  state,
  filters,
  areas,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: EmployeeListViewProps) {
  const uid = React.useId();
  const names = new Map(areas.map((area) => [area.id, area.name]));
  return (
    <>
      <PageHeader
        title="Empleados"
        description="Plantilla de tu empresa: conductores, despachadores y demás personal."
        actions={
          can('create') ? (
            <RouterButton to={`${employeesPath}/nuevo`} variant="contained">
              Nuevo empleado
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
            id={`${uid}-kind`}
            label="Tipo"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={filters.kind}
            onChange={(event) =>
              onFiltersChange({ ...filters, kind: event.target.value as EmployeeKind | '' })
            }
          >
            <option value="">Todos los tipos</option>
            {kindOrder.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </Field>
          <Field
            id={`${uid}-status`}
            label="Estado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={filters.status}
            onChange={(event) =>
              onFiltersChange({ ...filters, status: event.target.value as EmployeeStatus | '' })
            }
          >
            <option value="">Todos los estados</option>
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {statusPresentation[status].label}
              </option>
            ))}
          </Field>
          <AreaSelect
            id={`${uid}-area`}
            value={filters.areaId}
            choices={areaChoices(areas)}
            onChange={(areaId) => onFiltersChange({ ...filters, areaId })}
            emptyLabel="Todas las áreas"
            allowInactive
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
                title="Aún no hay empleados"
                description={
                  can('create')
                    ? 'Registra al primer empleado de tu empresa.'
                    : 'Cuando se registren empleados aparecerán aquí.'
                }
              />
            );
          const rows: Row[] = page.items.map((employee) => ({ ...employee, actions: employee.id }));
          return (
            <>
              <ScrollRegion label="Tabla de empleados">
                <DataTable<Row>
                  caption={`Empleados (${page.total})`}
                  columns={[
                    {
                      key: 'lastName',
                      label: 'Nombre',
                      render: (_, row) => (
                        <>
                          <RouterLink to={employeePath(row.id)} sx={linkSx}>
                            {listName(row)}
                          </RouterLink>
                          {row.archivedAt !== null && (
                            <StatusBadge label="Archivado" tone="neutral" />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'employeeNumber',
                      label: 'Número',
                      render: (value) =>
                        value ? (
                          <Typography
                            component="span"
                            variant="body2"
                            sx={{ fontFamily: opslogTokens.typography.monoFamily }}
                          >
                            {String(value)}
                          </Typography>
                        ) : (
                          '—'
                        ),
                    },
                    {
                      key: 'kind',
                      label: 'Tipo',
                      render: (value) => kindLabels[value as EmployeeKind],
                    },
                    {
                      key: 'areaId',
                      label: 'Área',
                      render: (value) => names.get(String(value)) ?? String(value),
                    },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as EmployeeStatus];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'fitness',
                      label: 'Aptitud',
                      render: (_, row) => {
                        if (row.fitness === null) return '—';
                        const view = fitnessPresentation(row.fitness);
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) =>
                        can('edit') && isEditable(row) ? (
                          <RouterLink
                            to={`${employeePath(row.id)}/editar`}
                            label={`Editar ${listName(row)}`}
                            sx={linkSx}
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
                  Cargar más empleados
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
