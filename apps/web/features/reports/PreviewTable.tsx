import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BffReportCell, BffReportPreview } from '@opslog/contracts';
import { Button, DataTable, UiState } from '@opslog/ui';
import { ScrollRegion } from '../../app/ScrollRegion';
import { copy, rangeText } from './labels';

type Row = { id: string } & Record<string, BffReportCell>;

const cell = (value: BffReportCell): string => (value === null ? '—' : String(value));

/** A page of the preview, as a table with the paging controls below it. */
export function PreviewTable({
  preview,
  title,
  onPage,
}: {
  readonly preview: BffReportPreview;
  readonly title: string;
  readonly onPage: (offset: number) => void;
}) {
  if (preview.total === 0) return <UiState kind="no-results" title={copy.noRows} />;
  const rows: Row[] = preview.rows.map((values, index) => ({
    id: `${preview.offset + index}`,
    ...Object.fromEntries(preview.columns.map((c, i) => [c.id, values[i] ?? null])),
  }));
  const columns = preview.columns.map((column) => ({
    key: column.id,
    label: column.label,
    render: (value: unknown) => cell(value as BffReportCell),
  }));
  const from = preview.offset + preview.limit;
  return (
    <>
      <ScrollRegion label={`Tabla del reporte ${title}`}>
        <DataTable<Row>
          caption={`${title}: ${rangeText(preview.offset, preview.rows.length, preview.total)}`}
          columns={columns}
          rows={rows}
        />
      </ScrollRegion>
      <Box
        component="nav"
        aria-label="Paginación de la vista previa"
        sx={{ display: 'flex', gap: 1, alignItems: 'center', pt: 2 }}
      >
        <Button
          variant="outlined"
          size="small"
          disabled={preview.offset === 0}
          onClick={() => onPage(Math.max(0, preview.offset - preview.limit))}
        >
          {copy.previous}
        </Button>
        <Typography variant="body2" aria-live="polite">
          {rangeText(preview.offset, preview.rows.length, preview.total)}
        </Typography>
        <Button
          variant="outlined"
          size="small"
          disabled={from >= preview.total}
          onClick={() => onPage(from)}
        >
          {copy.next}
        </Button>
      </Box>
    </>
  );
}
