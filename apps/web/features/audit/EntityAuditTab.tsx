import Box from '@mui/material/Box';
import React from 'react';
import type { BffAuditEntry } from '@opslog/contracts';
import { Button, InlineAlert, Panel, UiState } from '@opslog/ui';
import { ResourceView } from '../../app/resource';
import { useSession } from '../../auth/session';
import { formatDateTime } from '../incidents/time';
import { AuditDetail } from './AuditDetail';
import { AuditTable } from './AuditTable';
import { useCompanyZone } from './useCompanyZone';
import { usePagedAudit } from './usePagedAudit';

/**
 * «Historial de auditoría» of one record (S26, per-record tab). Shown only to people with `view_audit`; the
 * server also checks the read permission of the record's module, so a 403 renders as no permission.
 */
export function EntityAuditTab({
  entityType,
  entityId,
}: {
  readonly entityType: string;
  readonly entityId: string;
}) {
  const { ports, can } = useSession();
  const zone = useCompanyZone();
  const mayView = can('view_audit');
  const paged = usePagedAudit(
    (cursor) => ports.audit.forEntity(entityType, entityId, cursor ? { cursor } : undefined),
    [ports, entityType, entityId, mayView],
  );
  const [open, setOpen] = React.useState<BffAuditEntry | null>(null);
  if (!mayView) return <UiState kind="no-permission" />;
  const ready = paged.state.status === 'ready' ? paged.state.data : null;
  return (
    <Panel
      title="Historial de auditoría"
      description={
        ready
          ? `Del ${formatDateTime(ready.from, zone)} al ${formatDateTime(ready.to, zone)}, del más reciente al más antiguo.`
          : 'Del más reciente al más antiguo.'
      }
      flush={ready !== null && ready.items.length > 0}
    >
      <ResourceView state={paged.state} onRetry={paged.reload}>
        {(page) =>
          page.items.length === 0 ? (
            <UiState
              kind="empty"
              title="Sin eventos en el periodo"
              description="Este registro no tiene actividad auditada en los últimos 30 días."
            />
          ) : (
            <>
              <AuditTable
                entries={paged.entries}
                total={page.total}
                zone={zone}
                showRecord={false}
                onOpen={setOpen}
              />
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
