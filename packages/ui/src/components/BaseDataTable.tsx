import React from 'react';
import Checkbox from '@mui/material/Checkbox';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';

export type DataTableColumn<T> = {
  key: keyof T & string;
  label: string;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
};
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  caption = 'Registros',
  selectable = false,
  selected = [],
  onSelectedChange,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  caption?: string;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onSelectedChange?.(
      selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id],
    );
  return (
    <Table aria-label={caption} size="small">
      <caption style={{ textAlign: 'left', padding: 8 }}>{caption}</caption>
      <TableHead>
        <TableRow>
          {selectable && (
            <TableCell padding="checkbox">
              <span className="sr-only">Seleccionar</span>
            </TableCell>
          )}
          {columns.map((column) => (
            <TableCell key={column.key}>{column.label}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} hover>
            {selectable && (
              <TableCell padding="checkbox">
                <Checkbox
                  checked={selected.includes(row.id)}
                  onChange={() => toggle(row.id)}
                  inputProps={{ 'aria-label': `Seleccionar ${row.id}` }}
                />
              </TableCell>
            )}
            {columns.map((column) => (
              <TableCell key={column.key}>
                {column.render
                  ? column.render(row[column.key], row)
                  : String(row[column.key] ?? '')}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
