import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  ConfirmDialog,
  Notifications,
  opslogTokens,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { VehicleNotFound } from './VehicleMessages';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type { Vehicle } from '../app/types';
import {
  formatDate,
  formatDateTime,
  formatKm,
  isArchivable,
  isEditable,
  statusPresentation,
} from './labels';

export interface ArchiveDialogState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const archiveClosed: ArchiveDialogState = { open: false, busy: false };

export interface VehicleDetailViewProps {
  readonly state: ResourceState<Vehicle>;
  readonly can: (permission: 'edit' | 'delete') => boolean;
  readonly notice?: string | null;
  readonly archive: ArchiveDialogState;
  readonly onRetry: () => void;
  readonly onArchiveRequest: () => void;
  readonly onArchiveConfirm: () => void;
  readonly onArchiveCancel: () => void;
  readonly onArchiveErrorAction: () => void;
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Typography component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
      {children}
    </Typography>
  );
}

function BackLink() {
  return (
    <Box sx={{ mb: 2 }}>
      <RouterLink to="/flota/vehiculos" sx={{ color: 'primary.main', textDecoration: 'underline' }}>
        Volver a vehículos
      </RouterLink>
    </Box>
  );
}

/** Success message of the last change; kept focusable so the result is announced and reachable. */
function FocusNotice({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), [text]);
  return (
    <Box ref={ref} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
      <Notifications messages={[{ id: 'notice', text, severity: 'success' }]} />
    </Box>
  );
}

function Detail({ vehicle }: { vehicle: Vehicle }) {
  const status = statusPresentation[vehicle.status];
  const rows: [string, React.ReactNode][] = [
    ['Número económico', <Mono>{vehicle.economicNumber}</Mono>],
    ['Placa', <Mono>{vehicle.plate}</Mono>],
    ['VIN', vehicle.vin ? <Mono>{vehicle.vin}</Mono> : 'Sin VIN registrado'],
    ['Marca', vehicle.make],
    ['Modelo', vehicle.model],
    ['Año', String(vehicle.year)],
    ['Área', <Mono>{vehicle.areaId}</Mono>],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Motivo del estado', vehicle.statusReason],
    ['Odómetro', formatKm(vehicle.odometerKm)],
    ['Fecha de alta', formatDate(vehicle.registeredOn)],
    ['Última actualización', formatDateTime(vehicle.updatedAt)],
  ];
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1.5 },
        m: 0,
        maxWidth: 720,
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography component="dd" variant="body1" sx={{ m: 0, mb: { xs: 1.5, sm: 0 } }}>
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}

/** Vehicle detail: data, read-only explanations and the permission-aware actions (edit, archive). */
export function VehicleDetailView({
  state,
  can,
  notice = null,
  archive,
  onRetry,
  onArchiveRequest,
  onArchiveConfirm,
  onArchiveCancel,
  onArchiveErrorAction,
}: VehicleDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <VehicleNotFound />;
  return (
    <>
      <BackLink />
      <ResourceView state={state} onRetry={onRetry}>
        {(vehicle) => (
          <>
            <PageHeader
              title={`Vehículo ${vehicle.economicNumber}`}
              description={`${vehicle.make} ${vehicle.model} ${vehicle.year}`}
              actions={
                <>
                  {can('edit') && isEditable(vehicle) && (
                    <RouterButton
                      to={`/flota/vehiculos/${encodeURIComponent(vehicle.id)}/editar`}
                      variant="contained"
                    >
                      Editar
                    </RouterButton>
                  )}
                  {can('delete') && isArchivable(vehicle) && (
                    <Button variant="outlined" color="error" onClick={onArchiveRequest}>
                      Archivar
                    </Button>
                  )}
                </>
              }
            />
            {notice && <FocusNotice text={notice} />}
            {vehicle.archivedAt !== null ? (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="closed"
                  title="Vehículo archivado"
                  description={`Se archivó el ${formatDateTime(vehicle.archivedAt)}. Es de solo lectura y no se puede restaurar desde la aplicación.`}
                />
              </Box>
            ) : (
              vehicle.status === 'decommissioned' && (
                <Box sx={{ mb: 3 }}>
                  <UiState
                    kind="closed"
                    title="Vehículo dado de baja"
                    description="Es un registro histórico y no admite cambios."
                  />
                </Box>
              )
            )}
            <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
              Datos del vehículo
            </Typography>
            <Detail vehicle={vehicle} />
            {archive.open && (
              <ConfirmDialog
                title={`Archivar el vehículo ${vehicle.economicNumber}`}
                description="Dejará de aparecer en el listado y no se podrá editar. Esta acción no se puede deshacer desde la aplicación."
                confirmLabel="Archivar vehículo"
                busy={archive.busy}
                {...(archive.error ? { error: archive.error } : {})}
                {...(archive.errorActionLabel
                  ? {
                      errorActionLabel: archive.errorActionLabel,
                      onErrorAction: onArchiveErrorAction,
                    }
                  : {})}
                onConfirm={onArchiveConfirm}
                onCancel={onArchiveCancel}
              />
            )}
          </>
        )}
      </ResourceView>
    </>
  );
}
