import UploadFileOutlined from '@mui/icons-material/UploadFileOutlined';
import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, Panel } from '@opslog/ui';
import type {
  BffWorkOrder,
  BffWorkOrderFile,
  BffWorkOrderFileKind,
  BffWorkOrderFileStatus,
} from '@opslog/contracts';
import { BFF_WORK_ORDER_FILE_MAX_BYTES } from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';
import { useResult } from './useResult';
import { canAttachEvidence, canAttachInvoice, type MaintenanceViewer } from './workflow';

const STATUS_COPY: Readonly<Record<BffWorkOrderFileStatus, string>> = {
  pending_upload: 'Subiendo',
  pending_scan: 'En revisión: aún no cuenta como evidencia',
  clean: 'Guardado',
  rejected: 'Rechazado por la revisión',
  missing: 'No disponible',
};
const KIND_COPY: Readonly<Record<BffWorkOrderFileKind, { title: string; empty: string }>> = {
  evidence: { title: 'Evidencia', empty: 'Aún no hay evidencia.' },
  invoice: { title: 'Facturas', empty: 'Aún no hay facturas.' },
};
const ACCEPT = 'image/jpeg,image/png,application/pdf';

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });

/** Downloads a stored file through the order route (the server re-checks permissions). */
function save(name: string, contentType: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** G3 H3: evidence and invoice files of an order. Only saved files count for completing or closing. */
export function EvidencePanel({
  ports,
  order,
  viewer,
  onOrder,
  onExpired,
}: {
  ports: MaintenancePorts;
  order: BffWorkOrder;
  viewer: MaintenanceViewer;
  onOrder: (order: BffWorkOrder) => void;
  onExpired: () => void;
}) {
  const files = useResult(
    () => ports.orders.files.list(order.id),
    [ports, order.id, order.version],
    onExpired,
  );
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const run = async (call: () => Promise<Result<BffWorkOrder>>, failure: string) => {
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (result.ok) return onOrder(result.value);
    if (result.error.status === 401) return onExpired();
    setProblem(
      result.error.status === 409 && result.error.code === 'stale_version'
        ? 'La orden cambió. Recárgala e intenta de nuevo.'
        : result.error.status === 403
          ? 'No tienes permiso para esta acción.'
          : failure,
    );
  };
  const upload = async (kind: BffWorkOrderFileKind, file: File | undefined) => {
    if (!file) return;
    if (file.size > BFF_WORK_ORDER_FILE_MAX_BYTES) {
      setProblem('El archivo supera el máximo de 8 MB.');
      return;
    }
    const contentBase64 = await toBase64(file);
    await run(
      () =>
        ports.orders.files.upload(order.id, {
          version: order.version,
          kind,
          name: file.name,
          contentType: file.type,
          contentBase64,
        }),
      'No pudimos subir el archivo. Revisa que sea una imagen o un PDF.',
    );
  };
  const download = async (file: BffWorkOrderFile) => {
    const result = await ports.orders.files.content(order.id, file.id);
    if (result.ok)
      save(result.value.displayName, result.value.contentType, result.value.contentBase64);
    else setProblem('No pudimos descargar el archivo.');
  };
  const list: readonly BffWorkOrderFile[] = files.state.status === 'ready' ? files.state.data : [];
  const section = (kind: BffWorkOrderFileKind, allowed: boolean) => {
    const own = list.filter((file) => file.kind === kind);
    if (!allowed && own.length === 0 && kind === 'invoice') return null;
    const { title, empty } = KIND_COPY[kind];
    const id = `mnt-files-${kind}`;
    return (
      <Box component="section" aria-labelledby={id} key={kind}>
        <Typography id={id} component="h3" variant="subtitle1">
          {title}
        </Typography>
        {files.state.status === 'loading' ? (
          <Typography color="text.secondary">Cargando…</Typography>
        ) : own.length === 0 ? (
          <Typography color="text.secondary">{empty}</Typography>
        ) : (
          <ul aria-label={title}>
            {own.map((file) => (
              <li key={file.id}>
                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <span>
                    {file.displayName} · {STATUS_COPY[file.fileStatus]}
                  </span>
                  {file.fileStatus === 'clean' && (
                    <Button variant="text" onClick={() => void download(file)}>
                      {`Descargar ${file.displayName}`}
                    </Button>
                  )}
                  {allowed && (
                    <Button
                      variant="text"
                      color="error"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => ports.orders.files.detach(order.id, file.id, order.version),
                          'No pudimos quitar el archivo.',
                        )
                      }
                    >
                      {`Quitar ${file.displayName}`}
                    </Button>
                  )}
                </Stack>
              </li>
            ))}
          </ul>
        )}
        {allowed && (
          <Box
            component="label"
            htmlFor={`mnt-upload-${kind}`}
            sx={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              px: 2,
              py: 0.75,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              typography: 'button',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
              '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
              '&:focus-within': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            <UploadFileOutlined aria-hidden="true" fontSize="small" />
            {kind === 'evidence' ? 'Subir evidencia (foto o PDF)' : 'Subir factura (PDF o imagen)'}
            <Box
              component="input"
              sx={{
                position: 'absolute',
                width: 1,
                height: 1,
                overflow: 'hidden',
                clip: 'rect(0 0 0 0)',
                whiteSpace: 'nowrap',
              }}
              id={`mnt-upload-${kind}`}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                const input = event.target;
                void upload(kind, input.files?.[0]).finally(() => {
                  input.value = '';
                });
              }}
            />
          </Box>
        )}
      </Box>
    );
  };
  return (
    <Panel title="Evidencia y facturas">
      {problem && (
        <Alert severity="error" role="alert" sx={{ my: 1 }}>
          {problem}
        </Alert>
      )}
      {files.state.status === 'error' && (
        <Typography color="text.secondary">No pudimos cargar los archivos.</Typography>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 3,
        }}
      >
        {section('evidence', canAttachEvidence(order, viewer))}
        {section('invoice', canAttachInvoice(order, viewer))}
      </Box>
    </Panel>
  );
}
