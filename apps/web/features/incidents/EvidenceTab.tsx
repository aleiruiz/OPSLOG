import React from 'react';
import CameraAltOutlined from '@mui/icons-material/CameraAltOutlined';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { BFF_EVIDENCE_CATEGORIES, BFF_EVIDENCE_STAGES } from '@opslog/contracts';
import type { BffEvidenceCategory, BffEvidenceStage, BffIncidentEvidence } from '@opslog/contracts';
import { Button, FileButton, Field, InlineAlert, Panel, UiState, UploadQueue } from '@opslog/ui';
import { errorKind } from '../maintenance/useResult';
import { useIncidentEnv } from './context';
import { RELOADED_COPY, describeError, isStale } from './errors';
import { EvidenceList } from './EvidenceList';
import { CATEGORY_LABELS, STAGE_LABELS } from './labels';
import { canWrite } from './model';
import type { Compressor } from './prepareFile';
import { useLive } from './useLive';
import { useUploadQueue } from './useUploadQueue';
import type { ChildProps } from './ThirdPartiesTab';

const DOCUMENT_ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,.docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Hands a stored file to the browser as a download; the server re-checks permissions on every fetch. */
function save(name: string, contentType: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Evidencia (US-030): camera or file, category and stage, a queue that retries by itself within the
 * session, and the saved list with the status of each file. A file in the queue or in review is never shown
 * as a met requirement.
 */
export function EvidenceTab({
  incident,
  onVersion,
  onReload,
  compress,
  retryDelays,
  pollMs = 5000,
}: ChildProps & {
  compress?: Compressor;
  retryDelays?: readonly number[];
  /** How often the list refreshes while a file is still in review. */
  pollMs?: number;
}) {
  const env = useIncidentEnv();
  const list = useLive(
    () => env.ports.evidence.list(incident.id),
    [env.ports, incident.id, incident.version],
    env.onExpired,
  );
  const [category, setCategory] = React.useState<BffEvidenceCategory>('photo');
  const [stage, setStage] = React.useState<BffEvidenceStage>('on_site');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const queue = useUploadQueue({
    ports: env.ports,
    incidentId: incident.id,
    version: incident.version,
    ...(compress ? { compress } : {}),
    ...(retryDelays ? { retryDelays } : {}),
    onUploaded: (version) => onVersion(version),
    onStale: onReload,
    onExpired: env.onExpired,
  });
  const writable = canWrite(incident);
  const items = list.data?.items ?? [];
  const reviewing = items.some((item) => item.fileStatus === 'pending_scan');
  React.useEffect(() => {
    if (!reviewing || pollMs <= 0) return undefined;
    const timer = setInterval(list.reload, pollMs);
    return () => clearInterval(timer);
  }, [reviewing, pollMs]);

  const download = async (item: BffIncidentEvidence) => {
    setProblem(null);
    const result = await env.ports.evidence.content(incident.id, item.id);
    if (result.ok)
      save(result.value.displayName, result.value.contentType, result.value.contentBase64);
    else setProblem('No pudimos descargar el archivo.');
  };
  const detach = async (item: BffIncidentEvidence) => {
    setBusy(true);
    setProblem(null);
    const result = await env.ports.evidence.detach(incident.id, item.id, incident.version);
    setBusy(false);
    if (result.ok) onVersion(result.value.version, 'Archivo retirado.');
    else {
      if (result.error.status === 401) env.onExpired();
      if (isStale(result.error)) onReload();
      setProblem(
        isStale(result.error) ? RELOADED_COPY : describeError(result.error, 'quitar el archivo'),
      );
    }
  };
  if (list.data === null)
    return list.error ? (
      <UiState kind={errorKind(list.error)} actionLabel="Reintentar" onAction={list.reload} />
    ) : (
      <UiState kind="loading" />
    );
  const counted = items.filter((item) => item.counts).length;
  const failed = queue.items.filter((item) => item.status === 'error');
  return (
    <Panel
      title="Evidencia del caso"
      description={`${counted === 1 ? '1 archivo cuenta' : `${counted} archivos cuentan`} como evidencia guardada. Los archivos en revisión todavía no cuentan.`}
    >
      {problem && <InlineAlert severity="error">{problem}</InlineAlert>}
      {writable ? (
        <Box component="section" aria-label="Agregar evidencia" sx={{ display: 'grid', gap: 2 }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <Field
              id="evidence-category"
              label="Categoría"
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={category}
              onChange={(event) => setCategory(event.target.value as BffEvidenceCategory)}
            >
              {BFF_EVIDENCE_CATEGORIES.map((id) => (
                <option key={id} value={id}>
                  {CATEGORY_LABELS[id]}
                </option>
              ))}
            </Field>
            <Field
              id="evidence-stage"
              label="Etapa"
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={stage}
              onChange={(event) => setStage(event.target.value as BffEvidenceStage)}
            >
              {BFF_EVIDENCE_STAGES.map((id) => (
                <option key={id} value={id}>
                  {STAGE_LABELS[id]}
                </option>
              ))}
            </Field>
          </Box>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <FileButton
              label="Tomar foto"
              accept="image/*"
              capture="environment"
              icon={<CameraAltOutlined aria-hidden="true" fontSize="small" />}
              onFiles={(files) => queue.add(files, { category, stage })}
            />
            <FileButton
              label="Adjuntar archivos"
              accept={DOCUMENT_ACCEPT}
              multiple
              onFiles={(files) => queue.add(files, { category, stage })}
            />
          </Box>
          <Typography variant="body2" color="text.secondary">
            Las fotos se comprimen en tu dispositivo antes de subirse. PDF, DOCX y XLSX se suben sin
            cambios.
          </Typography>
          {queue.items.length > 0 && (
            <Box>
              <UploadQueue
                items={queue.items.map((item) => ({
                  id: item.id,
                  name: item.name,
                  progress: item.progress,
                  status: item.status === 'pending' ? 'pending' : item.status,
                }))}
                onRetry={queue.retry}
              />
              {queue.items.map(
                (item) =>
                  item.message && (
                    <Typography
                      key={item.id}
                      variant="body2"
                      role={item.status === 'error' ? 'alert' : 'status'}
                      sx={{ mt: 1 }}
                    >
                      {`${item.name}: ${item.message}`}
                    </Typography>
                  ),
              )}
              {failed.length > 0 && (
                <Button variant="text" onClick={queue.discardFailed}>
                  Descartar los archivos con error
                </Button>
              )}
            </Box>
          )}
        </Box>
      ) : (
        <Typography color="text.secondary">
          {incident.status === 'closed' || incident.status === 'cancelled'
            ? 'El caso está cerrado: no admite nuevos archivos. Si hace falta uno, hay que reabrirlo.'
            : 'No tienes permiso para agregar archivos a este caso.'}
        </Typography>
      )}
      {items.length === 0 ? (
        <UiState
          kind="empty"
          title="Sin archivos"
          description="Cuando se suban fotos o documentos aparecerán aquí con su estado."
        />
      ) : (
        <EvidenceList
          items={items}
          writable={writable}
          busy={busy}
          onDownload={(item) => void download(item)}
          onDetach={(item) => void detach(item)}
        />
      )}
    </Panel>
  );
}
