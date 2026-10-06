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
import type { Document, DocumentOwnerType, DocumentStatus } from '../app/types';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  allTypes,
  expiryNote,
  formatDate,
  isEditable,
  ownerTypeLabels,
  statusOrder,
  statusPresentation,
  typeLabel,
} from './labels';
import { DOCUMENT_TYPES } from './rules';
import { documentPath, documentsPath } from './DocumentMessages';

export interface DocumentFilters {
  readonly status: DocumentStatus | '';
  readonly ownerType: DocumentOwnerType | '';
  /** Only with `ownerType: 'vehicle'`. */
  readonly vehicleId: string;
  readonly typeCode: string;
  readonly includeArchived: boolean;
}

export const noFilters: DocumentFilters = {
  status: '',
  ownerType: '',
  vehicleId: '',
  typeCode: '',
  includeArchived: false,
};

export interface DocumentListData {
  readonly items: readonly Document[];
  readonly total: number;
  readonly nextCursor: string | null;
}

interface Row extends Document {
  actions: string;
}

export interface DocumentListViewProps {
  readonly state: ResourceState<DocumentListData>;
  readonly filters: DocumentFilters;
  /** Vehicles for the owner filter and for naming owners; `null` when they could not be loaded. */
  readonly vehicles: VehicleOptions | null;
  readonly can: (permission: 'create' | 'edit') => boolean;
  readonly filtersActive: boolean;
  readonly loadingMore?: boolean;
  readonly notice?: { readonly text: string; readonly severity: 'success' | 'error' } | null;
  readonly onFiltersChange: (filters: DocumentFilters) => void;
  readonly onClear: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Document list: filters, cursor-paginated table and every data state (SPECS §8). */
export function DocumentListView({
  state,
  filters,
  vehicles,
  can,
  filtersActive,
  loadingMore = false,
  notice = null,
  onFiltersChange,
  onClear,
  onRetry,
  onLoadMore,
}: DocumentListViewProps) {
  const uid = React.useId();
  const names = new Map((vehicles?.items ?? []).map((item) => [item.id, item.economicNumber]));
  const typeChoices = filters.ownerType === '' ? allTypes() : DOCUMENT_TYPES[filters.ownerType];
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
        title="Documentos"
        description="Documentos con vencimiento de tus vehículos: consulta, alta, renovación y archivado."
        actions={
          can('create') ? (
            <RouterButton to={`${documentsPath}/nuevo`} variant="contained">
              Nuevo documento
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
            (value) => onFiltersChange({ ...filters, status: value as DocumentStatus | '' }),
            <>
              <option value="">Todos los estados</option>
              {statusOrder.map((status) => (
                <option key={status} value={status}>
                  {statusPresentation[status].label}
                </option>
              ))}
            </>,
          )}
          {select(
            'owner-type',
            'Propietario',
            filters.ownerType,
            (value) => {
              const ownerType = value as DocumentOwnerType | '';
              const stillValid =
                ownerType === '' ||
                DOCUMENT_TYPES[ownerType].some((type) => type.code === filters.typeCode);
              onFiltersChange({
                ...filters,
                ownerType,
                vehicleId: '',
                typeCode: stillValid ? filters.typeCode : '',
              });
            },
            <>
              <option value="">Todos los propietarios</option>
              <option value="vehicle">{ownerTypeLabels.vehicle}s</option>
              <option value="employee">{ownerTypeLabels.employee}s</option>
            </>,
          )}
          {filters.ownerType === 'vehicle' &&
            vehicles &&
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
            'type',
            'Tipo de documento',
            filters.typeCode,
            (value) => onFiltersChange({ ...filters, typeCode: value }),
            <>
              <option value="">Todos los tipos</option>
              {typeChoices.map((type) => (
                <option key={type.code} value={type.code}>
                  {type.label}
                </option>
              ))}
            </>,
          )}
          {select(
            'archived',
            'Archivados',
            filters.includeArchived ? 'true' : 'false',
            (value) => onFiltersChange({ ...filters, includeArchived: value === 'true' }),
            <>
              <option value="false">Ocultar archivados</option>
              <option value="true">Incluir archivados</option>
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
                title="Aún no hay documentos"
                description={
                  can('create')
                    ? 'Registra el primer documento con vencimiento de tu flota.'
                    : 'Cuando se registren documentos aparecerán aquí.'
                }
              />
            );
          const rows: Row[] = page.items.map((document) => ({ ...document, actions: document.id }));
          return (
            <>
              <ScrollRegion label="Tabla de documentos">
                <DataTable<Row>
                  caption={`Documentos (${page.total})`}
                  columns={[
                    {
                      key: 'title',
                      label: 'Documento',
                      render: (_, row) => (
                        <>
                          <RouterLink to={documentPath(row.id)} sx={linkSx}>
                            {row.title}
                          </RouterLink>
                          {row.archivedAt !== null && (
                            <StatusBadge label="Archivado" tone="neutral" />
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'typeCode',
                      label: 'Tipo',
                      render: (_, row) => typeLabel(row.ownerType, row.typeCode),
                    },
                    {
                      key: 'ownerId',
                      label: 'Propietario',
                      render: (_, row) =>
                        row.ownerType === 'vehicle' ? (
                          <RouterLink
                            to={`/flota/vehiculos/${encodeURIComponent(row.ownerId)}`}
                            label={`Vehículo ${names.get(row.ownerId) ?? row.ownerId}`}
                            sx={linkSx}
                          >
                            {names.get(row.ownerId) ?? ownerTypeLabels.vehicle}
                          </RouterLink>
                        ) : (
                          ownerTypeLabels.employee
                        ),
                    },
                    {
                      key: 'documentNumber',
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
                      key: 'expiresOn',
                      label: 'Vencimiento',
                      render: (_, row) => (
                        <>
                          {row.expiresOn ? formatDate(row.expiresOn) : 'Sin vencimiento'}
                          {row.expiresOn && (
                            <Typography variant="body2" color="text.secondary">
                              {expiryNote(row.daysToExpiry)}
                            </Typography>
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as DocumentStatus];
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
                              to={`${documentPath(row.id)}/editar`}
                              label={`Editar ${row.title}`}
                              sx={linkSx}
                            >
                              Editar
                            </RouterLink>
                            <RouterLink
                              to={`${documentPath(row.id)}/renovar`}
                              label={`Renovar ${row.title}`}
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
                  Cargar más documentos
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
