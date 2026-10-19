import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffAuditReconciliation } from '@opslog/contracts';
import { DataTable, InlineAlert, Panel, StatCard } from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { ScrollRegion } from '../../app/ScrollRegion';
import { useSession } from '../../auth/session';
import { formatDateTime } from '../incidents/time';

const DELIVERY: Readonly<Record<string, string>> = {
  pending: 'Pendiente',
  delivered: 'Entregado',
  missing: 'Sin entrega registrada',
};

/** «hace 5 min», «hace 2 h»: how long an event has waited. */
export function ageText(seconds: number): string {
  if (seconds < 60) return 'menos de 1 min';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

function Body({ data, zone }: { data: BffAuditReconciliation; zone: string }) {
  const clean = data.pendingTotal === 0;
  const rows = data.pending.map((item) => ({ ...item, id: item.eventId }));
  return (
    <>
      <Box
        sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' } }}
      >
        <StatCard
          label="Eventos registrados"
          value={data.local}
          hint="En el registro de auditoría"
          tone="neutral"
        />
        <StatCard
          label="Ya en la consulta"
          value={data.relayed}
          hint="Visibles en esta pantalla"
          tone="success"
        />
        <StatCard
          label="Pendientes"
          value={data.pendingTotal}
          hint="Aún no aparecen"
          tone={clean ? 'success' : 'warning'}
        />
      </Box>
      <Box sx={{ mt: 2 }}>
        {clean ? (
          <InlineAlert severity="success">
            Todos los eventos del periodo ya aparecen en la consulta.
          </InlineAlert>
        ) : (
          <>
            <InlineAlert severity="warning">
              {data.pendingTotal === 1
                ? 'Hay 1 evento registrado que aún no aparece en la consulta.'
                : `Hay ${data.pendingTotal} eventos registrados que aún no aparecen en la consulta.`}{' '}
              El más antiguo espera {ageText(data.oldestPendingAgeSeconds ?? 0)}. Se entregan solos;
              esta vista no los modifica.
            </InlineAlert>
            <ScrollRegion label="Eventos pendientes">
              <DataTable
                caption={`Eventos pendientes (${data.pendingTotal}${data.pendingTotal > data.pending.length ? `, se muestran ${data.pending.length}` : ''})`}
                columns={[
                  {
                    key: 'occurredAt',
                    label: 'Fecha y hora',
                    render: (value) => formatDateTime(value as string, zone),
                  },
                  { key: 'action', label: 'Acción' },
                  { key: 'entityType', label: 'Tipo de registro' },
                  {
                    key: 'delivery',
                    label: 'Entrega',
                    render: (value) => DELIVERY[value as string] ?? 'Pendiente',
                  },
                  {
                    key: 'ageSeconds',
                    label: 'Espera',
                    render: (value) => ageText(value as number),
                  },
                ]}
                rows={rows}
              />
            </ScrollRegion>
          </>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
        Calculado el {formatDateTime(data.generatedAt, zone)}.
      </Typography>
    </>
  );
}

/** FR-170: compares what was recorded locally with what the consultation already shows, for the range. */
export function ReconciliationPanel({
  from,
  to,
  zone,
}: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly zone: string;
}) {
  const { ports } = useSession();
  const { state, reload } = useResource(
    () => ports.audit.reconciliation(from && to ? { from, to } : undefined),
    [ports, from, to],
  );
  return (
    <Panel
      title="Conciliación"
      description="Compara lo registrado con lo que ya aparece en esta consulta."
    >
      <ResourceView state={state} onRetry={reload}>
        {(data) => <Body data={data} zone={zone} />}
      </ResourceView>
    </Panel>
  );
}
