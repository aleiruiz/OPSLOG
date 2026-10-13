import Typography from '@mui/material/Typography';
import { DataTable, InlineAlert, Panel } from '@opslog/ui';
import type { BffIncidentCosts, BffRepairLink } from '@opslog/contracts';
import { ScrollRegion } from '../../app/ScrollRegion';
import { formatMinor, formatMoney } from './money';

/**
 * Totales por moneda: repairs of the linked orders plus expenses minus recoveries is what the company bears.
 * One row per currency and never a combined total (BR-027); several currencies carry a visible warning.
 */
export function CostTotals({ costs }: { costs: BffIncidentCosts }) {
  return (
    <Panel
      title="Totales a cargo de la empresa"
      description="Reparaciones de las órdenes vinculadas más gastos, menos recuperaciones."
    >
      {costs.mixedCurrencies && (
        <InlineAlert severity="warning">
          Hay costos en más de una moneda. Los totales se muestran por moneda y no se suman entre
          sí.
        </InlineAlert>
      )}
      {costs.differsFromLastClosure && (
        <InlineAlert severity="info">
          Los costos cambiaron desde el último cierre. El resumen de ese cierre no se modifica.
        </InlineAlert>
      )}
      {costs.totals.length === 0 ? (
        <Typography color="text.secondary">Sin costos registrados.</Typography>
      ) : (
        <ScrollRegion label="Totales por moneda">
          <DataTable
            caption={`Totales en ${costs.totals.length} ${costs.totals.length === 1 ? 'moneda' : 'monedas'}`}
            rows={costs.totals.map((total) => ({ ...total, id: total.currency }))}
            columns={[
              { key: 'currency', label: 'Moneda' },
              {
                key: 'repairs',
                label: 'Reparaciones (órdenes)',
                render: (_value, row) => formatMinor(row.repairs, row.currency),
              },
              {
                key: 'expenses',
                label: 'Gastos',
                render: (_value, row) => formatMinor(row.expenses, row.currency),
              },
              {
                key: 'recoveries',
                label: 'Recuperaciones',
                render: (_value, row) => formatMinor(row.recoveries, row.currency),
              },
              {
                key: 'companyBorne',
                label: 'A cargo de la empresa',
                render: (_value, row) => (
                  <strong>{formatMinor(row.companyBorne, row.currency)}</strong>
                ),
              },
            ]}
          />
        </ScrollRegion>
      )}
    </Panel>
  );
}

/** Costos de las órdenes vinculadas: read from the workshop's orders, never copied into the case. */
export function CostRepairs({
  costs,
  links,
}: {
  costs: BffIncidentCosts;
  links: readonly BffRepairLink[];
}) {
  if (costs.repairs.length === 0) return null;
  const nameOf = (linkId: string): string => {
    const found = links.find((link) => link.id === linkId);
    return found?.order.description?.trim() || 'Orden correctiva sin descripción';
  };
  return (
    <Panel
      title="Costos de las órdenes vinculadas"
      description="Se leen de mantenimiento: el detalle por línea está en la orden."
    >
      <ScrollRegion label="Costos por orden">
        <DataTable
          caption={`${costs.repairs.length} órdenes vinculadas`}
          rows={costs.repairs.map((repair) => ({ ...repair, id: repair.linkId }))}
          columns={[
            { key: 'linkId', label: 'Orden', render: (_value, row) => nameOf(row.linkId) },
            {
              key: 'totals',
              label: 'Costo registrado',
              render: (_value, row) =>
                row.totals.length === 0
                  ? 'Sin costos en la orden'
                  : row.totals.map((total) => (
                      <Typography key={total.currency} variant="body2">
                        {formatMoney(total)}
                      </Typography>
                    )),
            },
          ]}
        />
      </ScrollRegion>
    </Panel>
  );
}
