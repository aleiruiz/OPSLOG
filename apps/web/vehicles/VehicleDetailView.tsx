import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  ConfirmDialog,
  DescriptionList,
  Notifications,
  opslogTokens,
  PageHeader,
  Panel,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { VehicleNotFound } from './VehicleMessages';
import { BackLink } from '../app/BackLink';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton } from '../app/router';
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
  readonly can: (permission: 'edit' | 'delete' | 'incidents:view') => boolean;
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
  return (
    <Panel title="Datos del vehículo">
      <DescriptionList
        columns={3}
        items={[
          { label: 'Número económico', value: <Mono>{vehicle.economicNumber}</Mono> },
          { label: 'Placa', value: <Mono>{vehicle.plate}</Mono> },
          { label: 'VIN', value: vehicle.vin ? <Mono>{vehicle.vin}</Mono> : 'Sin VIN registrado' },
          { label: 'Marca', value: vehicle.make },
          { label: 'Modelo', value: vehicle.model },
          { label: 'Año', value: String(vehicle.year) },
          { label: 'Área', value: <Mono>{vehicle.areaId}</Mono> },
          { label: 'Estado', value: <StatusBadge label={status.label} tone={status.tone} /> },
          { label: 'Motivo del estado', value: vehicle.statusReason },
          { label: 'Odómetro', value: formatKm(vehicle.odometerKm) },
          { label: 'Fecha de alta', value: formatDate(vehicle.registeredOn) },
          { label: 'Última actualización', value: formatDateTime(vehicle.updatedAt) },
        ]}
      />
    </Panel>
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
      <BackLink to="/flota/vehiculos">Volver a vehículos</BackLink>
      <ResourceView state={state} onRetry={onRetry}>
        {(vehicle) => (
          <>
            <PageHeader
              eyebrow="Flota"
              title={`Vehículo ${vehicle.economicNumber}`}
              description={`${vehicle.make} ${vehicle.model} ${vehicle.year}`}
              actions={
                <>
                  {can('incidents:view') && (
                    <RouterButton
                      to={`/incidents?vehicleId=${encodeURIComponent(vehicle.id)}`}
                      variant="outlined"
                    >
                      Siniestros del vehículo
                    </RouterButton>
                  )}
                  {can('edit') && isEditable(vehicle) && (
                    <RouterButton
                      to={`/flota/vehiculos/${encodeURIComponent(vehicle.id)}/editar`}
                      variant="contained"
                      startIcon={<EditOutlined />}
                    >
                      Editar
                    </RouterButton>
                  )}
                  {can('delete') && isArchivable(vehicle) && (
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<ArchiveOutlined />}
                      onClick={onArchiveRequest}
                    >
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
