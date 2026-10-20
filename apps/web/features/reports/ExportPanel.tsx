import Box from '@mui/material/Box';
import React from 'react';
import type { BffExport, BffExportInput, BffReportSummary } from '@opslog/contracts';
import { Button, Field, InlineAlert, Panel } from '@opslog/ui';
import { useSession } from '../../auth/session';
import { copy, FORMAT_LABELS } from './labels';

/** A key that stays the same while the request does not change, so a double click is one export. */
function newKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `exp-${random}`.replace(/[^A-Za-z0-9_-]/g, '');
}

type Outcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'direct'; readonly item: BffExport }
  | { readonly kind: 'job' }
  | { readonly kind: 'error'; readonly message: string };

/** The format picker and the export button of a report, with what happened when it was pressed. */
export function ExportPanel({
  report,
  canExport,
  blocked = false,
  request,
  onShowExports,
}: {
  readonly report: BffReportSummary;
  readonly canExport: boolean;
  /** A required filter is still empty: there is nothing to export yet. */
  readonly blocked?: boolean;
  /** The columns, filters and order on screen, exactly what the file will hold. */
  readonly request: Omit<BffExportInput, 'format'>;
  readonly onShowExports: () => void;
}) {
  const { ports, markExpired } = useSession();
  const uid = React.useId();
  const [format, setFormat] = React.useState<BffExportInput['format']>(report.formats[0] ?? 'csv');
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome>({ kind: 'none' });
  const key = React.useRef<{ signature: string; value: string } | null>(null);

  React.useEffect(() => setOutcome({ kind: 'none' }), [report.id]);

  if (!canExport)
    return (
      <Panel title={copy.export}>
        <InlineAlert severity="info">{copy.noExport}</InlineAlert>
      </Panel>
    );

  const run = async () => {
    const body: BffExportInput = { format, ...request };
    const signature = JSON.stringify([report.id, body]);
    if (key.current?.signature !== signature) key.current = { signature, value: newKey() };
    setBusy(true);
    const result = await ports.reports.exportReport(report.id, body, key.current.value);
    setBusy(false);
    if (result.ok) {
      key.current = null;
      setOutcome(
        result.value.status === 'completed'
          ? { kind: 'direct', item: result.value }
          : { kind: 'job' },
      );
      return;
    }
    if (result.error.status === 401) markExpired();
    setOutcome({
      kind: 'error',
      message:
        result.error.status === 429
          ? copy.tooMany
          : result.error.status === 403
            ? copy.noExport
            : copy.exportFailed,
    });
  };

  return (
    <Panel
      title={copy.export}
      description="El archivo contiene las columnas y filtros de la vista previa."
    >
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field
          id={`${uid}-format`}
          label={copy.format}
          select
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          value={format}
          onChange={(event) => setFormat(event.target.value as typeof format)}
        >
          {report.formats.map((value) => (
            <option key={value} value={value}>
              {FORMAT_LABELS[value]}
            </option>
          ))}
        </Field>
        <Button loading={busy} disabled={blocked} onClick={() => void run()}>
          {copy.export}
        </Button>
      </Box>
      <Box aria-live="polite" sx={{ mt: 2 }}>
        {outcome.kind === 'direct' && (
          <InlineAlert severity="success">
            Tu archivo está listo ({outcome.item.rowCount ?? 0} filas).{' '}
            <a href={ports.reports.downloadHref(outcome.item.id)} download>
              {copy.download}
            </a>
          </InlineAlert>
        )}
        {outcome.kind === 'job' && (
          <InlineAlert severity="info">
            {copy.queuedNotice}{' '}
            <Button variant="text" size="small" onClick={onShowExports}>
              Ver mis exportaciones
            </Button>
          </InlineAlert>
        )}
        {outcome.kind === 'error' && <InlineAlert severity="error">{outcome.message}</InlineAlert>}
      </Box>
    </Panel>
  );
}
