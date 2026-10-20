import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BffReportColumn } from '@opslog/contracts';
import { CheckField } from '@opslog/ui';
import { copy } from './labels';

/**
 * The columns of the report the reader may see; at least one stays selected. A column the reader's
 * role does not allow is not in the list at all: the server never sends it.
 */
export function ColumnSelector({
  columns,
  selected,
  onChange,
}: {
  readonly columns: readonly BffReportColumn[];
  readonly selected: readonly string[];
  readonly onChange: (selected: readonly string[]) => void;
}) {
  const toggle = (id: string, checked: boolean) => {
    const next = checked
      ? columns.filter((c) => c.id === id || selected.includes(c.id)).map((c) => c.id)
      : selected.filter((item) => item !== id);
    if (next.length > 0) onChange(next);
  };
  return (
    <Box component="fieldset" sx={{ border: 0, p: 0, m: 0 }}>
      <Typography component="legend" variant="h6" sx={{ p: 0, mb: 0.5 }}>
        {copy.columns}
      </Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
        {copy.columnsHelp}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 3 }}>
        {columns.map((column) => (
          <CheckField
            key={column.id}
            label={column.label}
            checked={selected.includes(column.id)}
            disabled={selected.length === 1 && selected.includes(column.id)}
            onChange={(checked) => toggle(column.id, checked)}
          />
        ))}
      </Box>
    </Box>
  );
}
