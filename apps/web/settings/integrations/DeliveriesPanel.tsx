import Box from '@mui/material/Box';
import type { BffWebhookDelivery } from '@opslog/contracts';
import React from 'react';
import { Button, DataTable, InlineAlert, Panel, StatusBadge, UiState } from '@opslog/ui';
import type { DataTableColumn } from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { useSession } from '../../auth/session';
import { copy, errorLabel, eventLabels, statusLabels, statusTone } from './labels';

const when = (iso: string | null) => (iso === null ? '—' : iso.replace('T', ' ').slice(0, 16));

/** Delivery history of one endpoint: code, duration, attempt and state. The receiver's answer is not kept, so none is shown. */
export function DeliveriesPanel({
  endpointId,
  refreshKey,
}: {
  readonly endpointId: string;
  readonly refreshKey: number;
}) {
  const { ports, markExpired } = useSession();
  const { state, reload } = useResource(
    () => ports.integrations.deliveries(endpointId, { limit: 25 }),
    [ports, endpointId, refreshKey],
  );
  const [notice, setNotice] = React.useState<'retried' | 'failed' | null>(null);
  const retry = async (delivery: BffWebhookDelivery) => {
    const result = await ports.integrations.retry(endpointId, delivery.id);
    if (result.ok) {
      setNotice('retried');
      reload();
    } else if (result.error.status === 401) markExpired();
    else setNotice('failed');
  };
  const columns: DataTableColumn<BffWebhookDelivery>[] = [
    {
      key: 'eventType',
      label: copy.columns.event,
      render: (value) => eventLabels[value as keyof typeof eventLabels],
    },
    {
      key: 'status',
      label: copy.columns.status,
      render: (value) => (
        <StatusBadge
          label={statusLabels[value as keyof typeof statusLabels]}
          tone={statusTone[value as keyof typeof statusTone]}
        />
      ),
    },
    {
      key: 'lastStatusCode',
      label: copy.columns.code,
      render: (value) => (value === null ? '—' : String(value)),
    },
    {
      key: 'lastDurationMs',
      label: copy.columns.duration,
      render: (value) => (value === null ? '—' : `${String(value)} ms`),
    },
    { key: 'attempts', label: copy.columns.attempts },
    {
      key: 'lastAttemptAt',
      label: copy.columns.when,
      render: (value) => when(value as string | null),
    },
    {
      key: 'lastError',
      label: copy.columns.error,
      render: (value) => errorLabel(value as string | null),
    },
    {
      key: 'id',
      label: copy.columns.action,
      render: (_value, row) =>
        row.status === 'failed' || row.status === 'dead_letter' ? (
          <Button variant="outlined" size="small" onClick={() => void retry(row)}>
            {`${copy.retry} ${eventLabels[row.eventType]}`}
          </Button>
        ) : null,
    },
  ];
  return (
    <Panel title={copy.history}>
      {notice === 'retried' && <InlineAlert severity="success">{copy.retried}</InlineAlert>}
      {notice === 'failed' && <InlineAlert severity="error">{copy.loadError}</InlineAlert>}
      <ResourceView state={state} onRetry={reload}>
        {(data) =>
          data.items.length === 0 ? (
            <UiState kind="empty" title={copy.deliveriesEmpty} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <DataTable columns={columns} rows={[...data.items]} caption={copy.history} />
            </Box>
          )
        }
      </ResourceView>
    </Panel>
  );
}
