import { SeverityBadge, StatusBadge, type DataTableColumn } from '@opslog/ui';
import type { BffIncident } from '@opslog/contracts';
import { RouterLink, linkSx } from '../../app/router';
import { STATUS_LABELS, STATUS_TONES, TYPE_LABELS } from './labels';
import { incidentPath } from './paths';
import { SlaBadge } from './SlaBadge';
import { daysSince, formatDateTime } from './time';

/** Columns of the case table (S17): folio, event date in the company's zone, names instead of ids, state and SLA. */
export function incidentColumns(zone: string): DataTableColumn<BffIncident>[] {
  return [
    {
      key: 'folio',
      label: 'Folio',
      render: (_value, row) => (
        <RouterLink
          to={incidentPath(row.id)}
          sx={{ ...linkSx, fontFamily: 'ui-monospace, "IBM Plex Mono", monospace' }}
        >
          {row.folio}
        </RouterLink>
      ),
    },
    {
      key: 'occurredAt',
      label: 'Fecha del evento',
      render: (_value, row) => formatDateTime(row.occurredAt, zone),
    },
    {
      key: 'vehicle',
      label: 'Vehículo',
      render: (_value, row) => `${row.vehicle.economicNumber} · ${row.vehicle.plate}`,
    },
    {
      key: 'driver',
      label: 'Conductor',
      render: (_value, row) => row.driver?.displayName ?? 'Sin conductor',
    },
    {
      key: 'responsible',
      label: 'Responsable',
      render: (_value, row) => row.responsible?.displayName ?? 'Sin asignar',
    },
    { key: 'type', label: 'Tipo', render: (_value, row) => TYPE_LABELS[row.type] },
    {
      key: 'severity',
      label: 'Gravedad',
      render: (_value, row) =>
        row.severity ? <SeverityBadge severity={row.severity} /> : 'Sin definir',
    },
    {
      key: 'status',
      label: 'Estado',
      render: (_value, row) => (
        <StatusBadge label={STATUS_LABELS[row.status]} tone={STATUS_TONES[row.status]} />
      ),
    },
    {
      key: 'sla',
      label: 'SLA',
      render: (_value, row) => (row.sla ? <SlaBadge sla={row.sla} /> : 'Sin SLA'),
    },
    {
      key: 'updatedAt',
      label: 'Días sin movimiento',
      render: (_value, row) => String(daysSince(row.updatedAt)),
    },
  ];
}
