import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffAuditEntry } from '@opslog/contracts';
import { Button, DataTable, StatusBadge } from '@opslog/ui';
import { ScrollRegion } from '../../app/ScrollRegion';
import { formatDateTime } from '../incidents/time';
import { resultView } from './labels';

type Row = BffAuditEntry & { id: string };

/** Audit events newest first, as a table: when, who, what, on which record and the result. */
export function AuditTable({
  entries,
  total,
  zone,
  showRecord = true,
  onOpen,
}: {
  readonly entries: readonly BffAuditEntry[];
  readonly total: number;
  readonly zone: string;
  /** The tab of one record already knows which record it is. */
  readonly showRecord?: boolean;
  readonly onOpen: (entry: BffAuditEntry) => void;
}) {
  const rows: Row[] = entries.map((entry) => ({ ...entry, id: entry.eventId }));
  const columns = [
    {
      key: 'occurredAt' as const,
      label: 'Fecha y hora',
      render: (value: unknown) => formatDateTime(value as string, zone),
    },
    {
      key: 'actor' as const,
      label: 'Quién',
      render: (_: unknown, row: Row) => (
        <>
          {row.actor.label}
          <Typography variant="body2" color="text.secondary">
            {row.actor.alias}
          </Typography>
        </>
      ),
    },
    { key: 'actionLabel' as const, label: 'Acción' },
    ...(showRecord
      ? [
          {
            key: 'entityLabel' as const,
            label: 'Registro',
            render: (_: unknown, row: Row) => (
              <>
                {row.entityLabel}
                <Typography variant="body2" color="text.secondary">
                  {row.entityTypeLabel}
                </Typography>
              </>
            ),
          },
        ]
      : []),
    {
      key: 'result' as const,
      label: 'Resultado',
      render: (value: unknown) => {
        const view = resultView(value as BffAuditEntry['result']);
        return <StatusBadge label={view.label} tone={view.tone} />;
      },
    },
    {
      key: 'eventId' as const,
      label: 'Detalle',
      render: (_: unknown, row: Row) => (
        <Button
          variant="text"
          size="small"
          aria-label={`Ver detalle: ${row.actionLabel}, ${formatDateTime(row.occurredAt, zone)}`}
          onClick={() => onOpen(row)}
        >
          Ver detalle
        </Button>
      ),
    },
  ];
  return (
    <ScrollRegion label="Tabla de auditoría">
      <DataTable<Row> caption={`Eventos de auditoría (${total})`} columns={columns} rows={rows} />
    </ScrollRegion>
  );
}
