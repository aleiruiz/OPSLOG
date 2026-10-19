import Box from '@mui/material/Box';
import React from 'react';
import type { BffAuditEntry, BffAuditQuery } from '@opslog/contracts';
import { Button, InlineAlert, Panel, UiState } from '@opslog/ui';
import { ResourceView } from '../../app/resource';
import { useSession } from '../../auth/session';
import { formatDateTime } from '../incidents/time';
import { AuditDetail } from './AuditDetail';
import { AuditTable } from './AuditTable';
import { usePagedAudit } from './usePagedAudit';

export const PAGE_SIZE = 50;

/** The table of events for one set of filters, with «load more» and the detail of a selected event. */
export function AuditResults({
  query,
  filtersActive,
  zone,
}: {
  readonly query: BffAuditQuery;
  readonly filtersActive: boolean;
  readonly zone: string;
}) {
  const { ports } = useSession();
  const paged = usePagedAudit(
    (cursor) => ports.audit.list({ ...query, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
    [ports, JSON.stringify(query)],
  );
  const [open, setOpen] = React.useState<BffAuditEntry | null>(null);
  const ready = paged.state.status === 'ready' ? paged.state.data : null;
  return (
    <Panel
      title="Eventos"
      description={
        ready
          ? `Del más reciente al más antiguo, del ${formatDateTime(ready.from, zone)} al ${formatDateTime(ready.to, zone)}.`
          : 'Del más reciente al más antiguo.'
      }
      flush={ready !== null && ready.items.length > 0}
    >
      <ResourceView state={paged.state} onRetry={paged.reload}>
        {(page) =>
          page.items.length === 0 ? (
            filtersActive ? (
              <UiState kind="no-results" />
            ) : (
              <UiState
                kind="empty"
                title="Sin eventos en el periodo"
                description="Todavía no hay actividad registrada en el periodo elegido."
              />
            )
          ) : (
            <>
              <AuditTable entries={paged.entries} total={page.total} zone={zone} onOpen={setOpen} />
              {paged.moreFailed && (
                <Box sx={{ px: { xs: 2, sm: 2.5 }, pb: 2 }}>
                  <InlineAlert severity="error">
                    No se pudieron cargar más eventos. Inténtalo de nuevo.
                  </InlineAlert>
                </Box>
              )}
              {paged.nextCursor && (
                <Box sx={{ px: { xs: 2, sm: 2.5 }, pb: 2 }}>
                  <Button variant="outlined" loading={paged.loadingMore} onClick={paged.loadMore}>
                    Cargar más eventos
                  </Button>
                </Box>
              )}
            </>
          )
        }
      </ResourceView>
      <AuditDetail entry={open} zone={zone} onClose={() => setOpen(null)} />
    </Panel>
  );
}
