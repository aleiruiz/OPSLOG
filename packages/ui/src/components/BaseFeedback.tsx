import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ButtonControl, Field } from './BaseControls';

export function SeverityBadge({ severity }: { severity: 'low' | 'medium' | 'high' | 'critical' }) {
  const labels = { low: 'Baja', medium: 'Media', high: 'Alta', critical: 'Crítica' };
  const colors = { low: 'success', medium: 'info', high: 'warning', critical: 'error' } as const;
  return (
    <Chip
      size="small"
      label={labels[severity]}
      color={colors[severity]}
      aria-label={`Severidad: ${labels[severity]}`}
    />
  );
}
export function Timeline({
  items,
}: {
  items: { id: string; title: string; description?: string; date: string }[];
}) {
  return (
    <Stack component="ol" aria-label="Línea de tiempo" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {items.map((item) => (
        <Box
          component="li"
          key={item.id}
          sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 2, pb: 2 }}
        >
          <Typography variant="subtitle1">{item.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {item.date}
          </Typography>
          {item.description && <Typography variant="body2">{item.description}</Typography>}
        </Box>
      ))}
    </Stack>
  );
}
export function NextStepPanel({
  title = 'Siguiente paso',
  steps,
}: {
  title?: string;
  steps: string[];
}) {
  return (
    <Card component="aside" aria-label={title} sx={{ p: 2 }}>
      <Typography variant="h6">{title}</Typography>
      <Stack component="ul" sx={{ pl: 2, mb: 0 }}>
        {steps.map((step) => (
          <li key={step}>
            <Typography>{step}</Typography>
          </li>
        ))}
      </Stack>
    </Card>
  );
}
export function ConfirmWithReason({
  title = 'Confirma la acción',
  reasonLabel = 'Motivo',
  onConfirm,
  onCancel,
}: {
  title?: string;
  reasonLabel?: string;
  onConfirm: (reason: string) => void;
  onCancel?: () => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Card component="section" aria-label={title} sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{title}</Typography>
        <Field
          required
          label={reasonLabel}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          multiline
          minRows={2}
        />
        <Stack direction="row" gap={1}>
          <ButtonControl
            variant="contained"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            Confirmar
          </ButtonControl>
          {onCancel && (
            <ButtonControl variant="text" onClick={onCancel}>
              Cancelar
            </ButtonControl>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
export type UploadItem = {
  id: string;
  name: string;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
};
export function UploadQueue({
  items,
  onRetry,
}: {
  items: UploadItem[];
  onRetry?: (id: string) => void;
}) {
  return (
    <Stack component="section" aria-label="Archivos por cargar" spacing={1}>
      {items.map((item) => (
        <Box key={item.id} sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <span aria-hidden="true">↑</span>
            <Typography sx={{ flex: 1 }}>{item.name}</Typography>
            {item.status === 'complete' && (
              <span role="img" aria-label="Completado">
                ✓
              </span>
            )}
            {item.status === 'error' && onRetry && (
              <ButtonControl size="small" onClick={() => onRetry?.(item.id)}>
                Reintentar
              </ButtonControl>
            )}
          </Stack>
          {item.status === 'uploading' && (
            <LinearProgress
              variant="determinate"
              value={item.progress}
              aria-label={`Progreso de ${item.name}`}
            />
          )}
          {item.status === 'error' && <Alert severity="error">No se pudo cargar el archivo.</Alert>}
        </Box>
      ))}
    </Stack>
  );
}
export function Notifications({
  messages,
}: {
  messages: { id: string; text: string; severity: 'info' | 'success' | 'warning' | 'error' }[];
}) {
  return (
    <Stack role="region" aria-label="Notificaciones" spacing={1}>
      {messages.map((message) => (
        <Alert key={message.id} severity={message.severity}>
          {message.text}
        </Alert>
      ))}
    </Stack>
  );
}
