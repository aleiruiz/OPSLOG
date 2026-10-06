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
import type { Document, DocumentRevision } from '../app/types';
import { DocumentNotFound, documentPath, documentsPath } from './DocumentMessages';
import {
  expiryNote,
  formatDate,
  formatDateTime,
  isEditable,
  ownerTypeLabels,
  statusPresentation,
  typeLabel,
} from './labels';

export interface ArchiveDialogState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly errorActionLabel?: string | undefined;
}

export const archiveClosed: ArchiveDialogState = { open: false, busy: false };

export interface HistoryPage {
  readonly items: readonly DocumentRevision[];
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

export interface DocumentDetailViewProps {
  readonly state: ResourceState<Document>;
  readonly history: HistoryProps;
  /** Economic number of the vehicle that owns the document, when it could be read. */
  readonly ownerName?: string | null;
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

function Detail({ document, ownerName }: { document: Document; ownerName: string | null }) {
  const status = statusPresentation[document.status];
  const owner =
    document.ownerType === 'vehicle' ? (
      <RouterLink to={`/flota/vehiculos/${encodeURIComponent(document.ownerId)}`} sx={linkSx}>
        {ownerName ?? 'Ver vehículo'}
      </RouterLink>
    ) : (
      'Empleado'
    );
  const rows: [string, React.ReactNode][] = [
    ['Título', document.title],
    ['Tipo', typeLabel(document.ownerType, document.typeCode)],
    [ownerTypeLabels[document.ownerType], owner],
    ['Número de documento', document.documentNumber ? <Mono>{document.documentNumber}</Mono> : '—'],
    ['Fecha de emisión', document.issuedOn ? formatDate(document.issuedOn) : '—'],
    ['Vencimiento', document.expiresOn ? formatDate(document.expiresOn) : 'Sin vencimiento'],
    [
      'Estado',
      <>
        <StatusBadge label={status.label} tone={status.tone} />{' '}
        {document.expiresOn && expiryNote(document.daysToExpiry)}
      </>,
    ],
    ['Revisión', String(document.revision)],
    ['Notas', document.notes ?? '—'],
    ['Última actualización', formatDateTime(document.updatedAt)],
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

function revisionTitle(entry: DocumentRevision): string {
  return `Revisión ${entry.revision} · ${statusPresentation[entry.status].label}`;
}

function revisionDescription(entry: DocumentRevision): string {
  const parts = [
    entry.issuedOn ? `Emitido el ${formatDate(entry.issuedOn)}` : 'Sin fecha de emisión',
    entry.expiresOn ? `vence el ${formatDate(entry.expiresOn)}` : 'sin vencimiento',
  ];
  if (entry.documentNumber) parts.push(`número ${entry.documentNumber}`);
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
              title: revisionTitle(entry),
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

/** Document detail: data, history of revisions and the permission-aware actions (edit, renew, archive). */
export function DocumentDetailView({
  state,
  history,
  ownerName = null,
  can,
  notice = null,
  archive,
  onRetry,
  onArchiveRequest,
  onArchiveConfirm,
  onArchiveCancel,
  onArchiveErrorAction,
}: DocumentDetailViewProps) {
  if (state.status === 'error' && state.error.status === 404) return <DocumentNotFound />;
  return (
    <>
      <Box sx={{ mb: 2 }}>
        <RouterLink to={documentsPath} sx={linkSx}>
          Volver a documentos
        </RouterLink>
      </Box>
      <ResourceView state={state} onRetry={onRetry}>
        {(document) => (
          <>
            <PageHeader
              title={document.title}
              description={`${typeLabel(document.ownerType, document.typeCode)}${ownerName ? ` · Vehículo ${ownerName}` : ''}`}
              actions={
                <>
                  {can('edit') && isEditable(document) && (
                    <>
                      <RouterButton to={`${documentPath(document.id)}/renovar`} variant="contained">
                        Renovar
                      </RouterButton>
                      <RouterButton to={`${documentPath(document.id)}/editar`}>Editar</RouterButton>
                    </>
                  )}
                  {can('delete') && isEditable(document) && (
                    <Button variant="outlined" color="error" onClick={onArchiveRequest}>
                      Archivar
                    </Button>
                  )}
                </>
              }
            />
            {notice && <FocusNotice text={notice} />}
            {document.archivedAt !== null && (
              <Box sx={{ mb: 3 }}>
                <UiState
                  kind="closed"
                  title="Documento archivado"
                  description={`Se archivó el ${formatDateTime(document.archivedAt)}. Es de solo lectura y no se puede restaurar desde la aplicación.`}
                />
              </Box>
            )}
            <Typography component="h2" variant="h2" sx={{ mb: 2 }}>
              Datos del documento
            </Typography>
            <Detail document={document} ownerName={ownerName} />
            <History props={history} />
            {archive.open && (
              <ConfirmDialog
                title={`Archivar el documento ${document.title}`}
                description="Dejará de aparecer en el listado y no se podrá editar ni renovar. Su historial se conserva. Esta acción no se puede deshacer desde la aplicación."
                confirmLabel="Archivar documento"
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
