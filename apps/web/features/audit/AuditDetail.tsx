import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffAuditEntry } from '@opslog/contracts';
import { Button, DescriptionList, StatusBadge } from '@opslog/ui';
import { formatDateTime } from '../incidents/time';
import { describeChangeSide, resultView } from './labels';

/** What changed in one event: field names always; values only where the module history keeps them. */
function Changes({ entry }: { readonly entry: BffAuditEntry }) {
  if (entry.changes === null)
    return (
      <Typography variant="body2" color="text.secondary">
        Este tipo de registro no guarda el detalle de los campos cambiados.
      </Typography>
    );
  if (entry.changes.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        El evento no cambió ningún campo.
      </Typography>
    );
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }} aria-label="Campos cambiados">
      {entry.changes.map((change) => (
        <li key={change.field}>
          <strong>{change.label}</strong>
          {change.state === 'value' ? (
            <>
              : {describeChangeSide(change, 'before', entry.entityType)} →{' '}
              {describeChangeSide(change, 'after', entry.entityType)}
            </>
          ) : change.state === 'restricted' ? (
            <>: valor restringido (cambió, pero su valor no se muestra)</>
          ) : (
            <>: cambió (el historial no guarda su valor)</>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Modal with one audited event. Escape and the close button return focus to the row that opened it. */
export function AuditDetail({
  entry,
  zone,
  onClose,
}: {
  readonly entry: BffAuditEntry | null;
  readonly zone: string;
  readonly onClose: () => void;
}) {
  const titleId = React.useId();
  const result = entry ? resultView(entry.result) : null;
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
    >
      {entry && result && (
        <>
          <DialogTitle id={titleId}>{entry.actionLabel}</DialogTitle>
          <DialogContent dividers>
            <DescriptionList
              columns={1}
              items={[
                { label: 'Fecha y hora', value: formatDateTime(entry.occurredAt, zone) },
                {
                  label: 'Quién',
                  value: `${entry.actor.label} (${entry.actor.alias})`,
                },
                {
                  label: 'Registro',
                  value: `${entry.entityTypeLabel}: ${entry.entityLabel}`,
                },
                {
                  label: 'Resultado',
                  value: <StatusBadge label={result.label} tone={result.tone} />,
                },
                { label: 'Referencia del evento', value: entry.correlationId },
                { label: 'Cambios', value: <Changes entry={entry} /> },
              ]}
            />
          </DialogContent>
          <DialogActions>
            <Button variant="outlined" onClick={onClose}>
              Cerrar
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
