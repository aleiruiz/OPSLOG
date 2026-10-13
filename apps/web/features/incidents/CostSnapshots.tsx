import Typography from '@mui/material/Typography';
import { DataTable, Panel } from '@opslog/ui';
import type { BffCostSnapshot } from '@opslog/contracts';
import { ScrollRegion } from '../../app/ScrollRegion';
import { useIncidentEnv } from './context';
import { STATUS_LABELS as ORDER_STATUS } from '../maintenance/labels';
import { formatMinor } from './money';
import { formatDateTime } from './time';

const orderStatus = (status: string): string =>
  (ORDER_STATUS as Readonly<Record<string, string>>)[status] ?? 'Estado desconocido';

/** Cierres anteriores: what the company bore at each closing cycle. They are append-only and never change. */
export function CostSnapshots({ snapshots }: { snapshots: readonly BffCostSnapshot[] }) {
  const env = useIncidentEnv();
  if (snapshots.length === 0) return null;
  return (
    <Panel
      title="Costos al cierre"
      description="Cada cierre guarda una copia de los totales y del estado de las órdenes. No cambia aunque los costos cambien después."
    >
      <ScrollRegion label="Costos al cierre">
        <DataTable
          caption={`${snapshots.length} cierres`}
          rows={[...snapshots]
            .reverse()
            .map((snapshot) => ({ ...snapshot, id: String(snapshot.cycle) }))}
          columns={[
            { key: 'cycle', label: 'Ciclo', render: (_value, row) => `Ciclo ${row.cycle}` },
            {
              key: 'closedAt',
              label: 'Cerrado el',
              render: (_value, row) => formatDateTime(row.closedAt, env.zone),
            },
            {
              key: 'totals',
              label: 'A cargo de la empresa',
              render: (_value, row) =>
                row.totals.length === 0
                  ? 'Sin costos'
                  : row.totals.map((total) => (
                      <Typography key={total.currency} variant="body2">
                        {formatMinor(total.companyBorne, total.currency)}
                      </Typography>
                    )),
            },
            {
              key: 'orders',
              label: 'Órdenes al cierre',
              render: (_value, row) =>
                row.orders.length === 0
                  ? 'Sin órdenes'
                  : [...new Set(row.orders.map((order) => orderStatus(order.status)))].join(', '),
            },
          ]}
        />
      </ScrollRegion>
    </Panel>
  );
}
