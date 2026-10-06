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
  Timeline,
  UiState,
} from '@opslog/ui';
import { ResourceView, type ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type { Deductible, InsurancePolicy, InsurancePolicyRevision } from '../app/types';
import {
  coverageLabel,
  expiryNote,
  formatDate,
  formatDateTime,
  formatDeductible,
  isEditable,
  notStarted,
  statusPresentation,
} from './labels';
import { PolicyNotFound, policiesPath, policyPath } from './PolicyMessages';

export interface ArchiveDialogState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const archiveClosed: ArchiveDialogState = { open: false, busy: false };

export interface HistoryPage {
  readonly items: readonly InsurancePolicyRevision[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface HistoryProps {
  readonly state: ResourceState<HistoryPage>;
  readonly loadingMore?: boolean;
  readonly notice?: string | null;
  readonly onRetry: () => void;
  readonly onLoadMore: (cursor: string) => void;
}

export interface PolicyDetailViewProps {
  readonly state: ResourceState<InsurancePolicy>;
  readonly history: HistoryProps;
  /** Economic number of the insured vehicle, when it could be read. */
  readonly vehicleName?: string | null;
  readonly can: (permission: 'edit' | 'delete') => boolean;
  readonly notice?: string | null;
  readonly archive: ArchiveDialogState;
  readonly onRetry: () => void;
  readonly onArchiveRequest: () => void;
  readonly onArchiveConfirm: () => void;
  readonly onArchiveCancel: () => void;
  readonly onArchiveErrorAction: () => void;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

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

/**
 * The deductible as the session may see it. Without `view_costs` the amount never arrives: only whether one exists
 * is known, and the screen says so instead of showing an empty value.
 */
function deductibleText(deductible: Deductible | null, hasDeductible: boolean): string {
  if (deductible) return formatDeductible(deductible);
  return hasDeductible
    ? 'Registrado. Solo lo ve quien tiene permiso para ver costos.'
    : 'Sin deducible';
}

function Detail({ policy, vehicleName }: { policy: InsurancePolicy; vehicleName: string | null }) {
  const status = statusPresentation[policy.status];
  const rows: [string, React.ReactNode][] = [
    ['Aseguradora', policy.insurer],
    [
      'Vehículo',
      <RouterLink to={`/flota/vehiculos/${encodeURIComponent(policy.vehicleId)}`} sx={linkSx}>
        {vehicleName ?? 'Ver vehículo'}
      </RouterLink>,
    ],
    ['Número de póliza', <Mono>{policy.policyNumber}</Mono>],
    ['Cobertura', coverageLabel(policy.coverageType)],
    ['Inicio de vigencia', formatDate(policy.startsOn)],
    ['Fin de vigencia', formatDate(policy.endsOn)],
    [
      'Estado',
      <>
        <StatusBadge label={status.label} tone={status.tone} />{' '}
        {notStarted(policy) ? 'Aún no inicia' : expiryNote(policy.daysToExpiry)}
      </>,
    ],
    ['Deducible', deductibleText(policy.deductible, policy.hasDeductible)],
    ['Revisión', String(policy.revision)],
    ['Notas de cobertura', policy.coverageNotes ?? '—'],
    ['Última actualización', formatDateTime(policy.updatedAt)],
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

function revisionDescription(entry: InsurancePolicyRevision): string {
  const parts = [
    `Póliza ${entry.policyNumber}`,
    coverageLabel(entry.coverageType),
    `${formatDate(entry.startsOn)} – ${formatDate(entry.endsOn)}`,
    `Deducible: ${deductibleText(entry.deductible, entry.hasDeductible)}`,
  ];
  return `${parts.join(' · ')} · Por ${entry.actorId}`;
}

function History({ props }: { props: HistoryProps }) {
  const { state } = props;
  return (
    <Box component="section" aria-labelledby="history-title" sx={{ mt: 4 }}>
      <Typography id="history-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Historial de revisiones
      </Typography>
      {state.status === 'ready' ? (
        <>
          <Timeline
            items={state.data.items.map((entry) => ({
              id: String(entry.revision),
              title: `Revisión ${entry.revision} · ${statusPresentation[entry.status].label}`,
              description: revisionDescription(entry),
              date: formatDateTime(entry.at),
            }))}
          />
          {props.notice && (
            <Box sx={{ my: 1 }}>
              <Notifications
                messages={[{ id: 'history-notice', text: props.notice, severity: 'error' }]}
              />
            </Box>
          )}
          {state.data.nextCursor && (
            <Button
              variant="outlined"
              loading={props.loadingMore ?? false}
              onClick={() => props.onLoadMore(state.data.nextCursor as string)}
            >
              Cargar más historial
            </Button>
          )}
        </>
      ) : (
        <ResourceView state={state} onRetry={props.onRetry}>
          {() => null}
        </ResourceView>
      )}
    </Box>
  );
}

/** Policy detail: data, history of revisions and the permission-aware actions (edit, renew, archive). */
export function PolicyDetailView({
  state,
  history,
  vehicleName = null,
  can,
  notice = null,
  archive,
  onRetry,
  onArchiveRequest,
  onArchiveConfirm,
  onArchiveCancel,
  onArchiveErrorAction,
}: PolicyDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <PolicyNotFound />;
  return (
    <>
      <Box sx={{ mb: 2 }}>
        <RouterLink to={policiesPath} sx={linkSx}>
          Volver a seguros
        </RouterLink>
      </Box>
      <ResourceView state={state} onRetry={onRetry}>
        {(policy) => (
          <>
            <PageHeader
              title={`Póliza ${policy.policyNumber}`}
              description={`${policy.insurer} · ${coverageLabel(policy.coverageType)}${vehicleName ? ` · Vehículo ${vehicleName}` : ''}`}
              actions={
                <>
                  {can('edit') && isEditable(policy) && (
                    <>
                      <RouterButton to={`${policyPath(policy.id)}/renovar`} variant="contained">
                        Renovar
                      </RouterButton>
                      <RouterButton to={`${policyPath(policy.id)}/editar`}>Editar</RouterButton>
                    </>
                  )}
                  {can('delete') && isEditable(policy) && (
                    <Button variant="outlined" color="error" onClick={onArchiveRequest}>
                      Archivar
                    </Button>
                  )}
                </>
              }
            />
            {notice && <FocusNotice text={notice} />}
            {policy.archivedAt !== null && (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="closed"
                  title="Póliza archivada"
                  description={`Se archivó el ${formatDateTime(policy.archivedAt)}. Es de solo lectura y no se puede restaurar desde la aplicación.`}
                />
              </Box>
            )}
            <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
              Datos de la póliza
            </Typography>
            <Detail policy={policy} vehicleName={vehicleName} />
            <History props={history} />
            {archive.open && (
              <ConfirmDialog
                title={`Archivar la póliza ${policy.policyNumber}`}
                description="Dejará de aparecer en el listado y no se podrá editar ni renovar. Su historial se conserva. Esta acción no se puede deshacer desde la aplicación."
                confirmLabel="Archivar póliza"
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
