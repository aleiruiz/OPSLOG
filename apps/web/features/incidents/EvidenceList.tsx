import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, StatusBadge } from '@opslog/ui';
import type { BffIncidentEvidence } from '@opslog/contracts';
import { DateTime } from './DateTime';
import { CATEGORY_LABELS, FILE_STATUS_LABELS, STAGE_LABELS } from './labels';

const TONES = {
  pending_upload: 'warning',
  pending_scan: 'warning',
  clean: 'success',
  rejected: 'danger',
  missing: 'neutral',
} as const;

/** The files linked to the case. Only a reviewed (`clean`) file counts; one in review or rejected never does. */
export function EvidenceList({
  items,
  writable,
  busy,
  onDownload,
  onDetach,
}: {
  items: readonly BffIncidentEvidence[];
  writable: boolean;
  busy: boolean;
  onDownload: (item: BffIncidentEvidence) => void;
  onDetach: (item: BffIncidentEvidence) => void;
}) {
  return (
    <Box
      component="ul"
      aria-label="Archivos del caso"
      sx={{ display: 'grid', gap: 1.5, p: 0, m: 0 }}
    >
      {items.map((item) => (
        <Box
          component="li"
          key={item.id}
          sx={{
            listStyle: 'none',
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            p: 1.5,
            display: 'flex',
            gap: 1.5,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <Typography sx={{ overflowWrap: 'anywhere', fontWeight: 500 }}>
              {item.displayName}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {CATEGORY_LABELS[item.category]} · {STAGE_LABELS[item.stage]}
              {item.capturedAt && (
                <>
                  {' · tomada el '}
                  <DateTime value={item.capturedAt} />
                </>
              )}
              {item.clientCompressed && ' · comprimida al subir'}
            </Typography>
          </Box>
          <StatusBadge label={FILE_STATUS_LABELS[item.fileStatus]} tone={TONES[item.fileStatus]} />
          {item.fileStatus === 'clean' && (
            <Button variant="text" onClick={() => onDownload(item)}>
              {`Descargar ${item.displayName}`}
            </Button>
          )}
          {writable && (
            <Button variant="text" color="error" disabled={busy} onClick={() => onDetach(item)}>
              {`Quitar ${item.displayName}`}
            </Button>
          )}
        </Box>
      ))}
    </Box>
  );
}
