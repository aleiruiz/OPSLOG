import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffExport } from '@opslog/contracts';
import { Button, DataTable, InlineAlert, Panel, StatusBadge, UiState } from '@opslog/ui';
import { ResourceView } from '../../app/resource';
import { ScrollRegion } from '../../app/ScrollRegion';
import { useSession } from '../../auth/session';
import { useCompanyZone } from '../audit/useCompanyZone';
import { formatDateTime } from '../incidents/time';
import { copy, FAILURE_LABELS, FORMAT_SHORT, rangeText, STATUS_VIEW } from './labels';
import { useExportsList } from './useExportsList';

export const EXPORTS_PAGE = 25;
/** How often an open job is looked at again (ms). */
export const EXPORTS_POLL_MS = 4_000;

type Row = BffExport;

/** «Mis exportaciones»: the person's files, newest first, with what became of each one. */
export function ExportsTab({ pollMs = EXPORTS_POLL_MS }: { readonly pollMs?: number | undefined }) {
  const { ports } = useSession();
  const zone = useCompanyZone();
  const [offset, setOffset] = React.useState(0);
  const list = useExportsList(offset, EXPORTS_PAGE, pollMs);

  const columns = [
    { key: 'reportTitle' as const, label: 'Reporte' },
    {
      key: 'format' as const,
      label: 'Formato',
      render: (value: unknown) => FORMAT_SHORT[value as BffExport['format']],
    },
    {
      key: 'status' as const,
      label: 'Estado',
      render: (_: unknown, row: Row) => {
        const view = STATUS_VIEW[row.status];
        return (
          <>
            <StatusBadge label={view.label} tone={view.tone} />
            {row.failure && (
              <Typography variant="body2" color="text.secondary">
                {FAILURE_LABELS[row.failure]}
              </Typography>
            )}
          </>
        );
      },
    },
    {
      key: 'rowCount' as const,
      label: 'Filas',
      render: (value: unknown) => (value === null ? '—' : String(value)),
    },
    {
      key: 'createdAt' as const,
      label: 'Solicitada',
      render: (value: unknown) => formatDateTime(value as string, zone),
    },
    {
      key: 'expiresAt' as const,
      label: 'Disponible hasta',
      render: (value: unknown) => (value === null ? '—' : formatDateTime(value as string, zone)),
    },
    {
      key: 'id' as const,
      label: 'Archivo',
      render: (_: unknown, row: Row) =>
        row.status === 'completed' ? (
          <a
            href={ports.reports.downloadHref(row.id)}
            download
            aria-label={`${copy.download}: ${row.reportTitle}, ${FORMAT_SHORT[row.format]}`}
          >
            Descargar
          </a>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <Panel
      title={copy.exportsTab}
      description={copy.exportsHint}
      actions={
        <Button variant="outlined" size="small" onClick={list.refresh}>
          {copy.refresh}
        </Button>
      }
      flush
    >
      <ResourceView state={list.state} onRetry={list.retry}>
        {(page) =>
          page.items.length === 0 && page.total === 0 ? (
            <UiState kind="empty" title={copy.exportsEmpty} />
          ) : (
            <>
              <ScrollRegion label="Tabla de mis exportaciones">
                <DataTable<Row>
                  caption={`Mis exportaciones (${page.total})`}
                  columns={columns}
                  rows={[...page.items]}
                />
              </ScrollRegion>
              {page.items.some((item) => item.status === 'queued' || item.status === 'running') && (
                <Box sx={{ px: { xs: 2, sm: 2.5 }, pb: 2 }}>
                  <InlineAlert severity="info">
                    Hay exportaciones en curso. Esta lista se actualiza sola.
                  </InlineAlert>
                </Box>
              )}
              <Box
                component="nav"
                aria-label="Paginación de mis exportaciones"
                sx={{
                  display: 'flex',
                  gap: 1,
                  alignItems: 'center',
                  px: { xs: 2, sm: 2.5 },
                  pb: 2,
                }}
              >
                <Button
                  variant="outlined"
                  size="small"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - EXPORTS_PAGE))}
                >
                  {copy.previous}
                </Button>
                <Typography variant="body2" aria-live="polite">
                  {rangeText(page.offset, page.items.length, page.total)}
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={offset + EXPORTS_PAGE >= page.total}
                  onClick={() => setOffset(offset + EXPORTS_PAGE)}
                >
                  {copy.next}
                </Button>
              </Box>
            </>
          )
        }
      </ResourceView>
    </Panel>
  );
}
