import Typography from '@mui/material/Typography';
import React from 'react';
import { DataTable, StatusBadge } from '@opslog/ui';
import { RouterLink } from '../app/router';
import { ScrollRegion } from '../app/ScrollRegion';
import type { ImportEntity, ImportRow } from '../app/types';
import { codeLabel, columnLabel, entityPaths, outcomePresentation } from './labels';

interface Row extends ImportRow {
  id: string;
}

const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;

/**
 * The per-row report of an import: the row number, the outcome, why, and which columns. It never shows a cell value:
 * the server does not keep them and neither does the screen.
 */
export function ImportRowsTable({
  rows,
  entity,
  caption,
  label,
}: {
  readonly rows: readonly ImportRow[];
  readonly entity: ImportEntity;
  readonly caption: string;
  /** Accessible name of the scrollable region. */
  readonly label: string;
}) {
  const data: Row[] = rows.map((row) => ({ ...row, id: String(row.rowNumber) }));
  return (
    <ScrollRegion label={label}>
      <DataTable<Row>
        caption={caption}
        columns={[
          {
            key: 'rowNumber',
            label: 'Fila',
            render: (value) => (
              <Typography component="span" variant="body2">
                {String(value)}
              </Typography>
            ),
          },
          {
            key: 'outcome',
            label: 'Resultado',
            render: (value) => {
              const view = outcomePresentation[value as ImportRow['outcome']];
              return <StatusBadge label={view.label} tone={view.tone} />;
            },
          },
          { key: 'code', label: 'Motivo', render: (_, row) => codeLabel(row.code) },
          {
            key: 'columns',
            label: 'Columnas',
            render: (_, row) =>
              row.columns.length === 0 ? '—' : row.columns.map(columnLabel).join(', '),
          },
          {
            key: 'entityId',
            label: 'Registro creado',
            render: (_, row) =>
              row.entityId === null ? (
                '—'
              ) : (
                <RouterLink
                  to={`${entityPaths[entity]}/${encodeURIComponent(row.entityId)}`}
                  label={`Abrir el registro creado de la fila ${row.rowNumber}`}
                  sx={linkSx}
                >
                  Abrir
                </RouterLink>
              ),
          },
        ]}
        rows={data}
      />
    </ScrollRegion>
  );
}
