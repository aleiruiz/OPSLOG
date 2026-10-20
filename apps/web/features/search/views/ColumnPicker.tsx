import React from 'react';
import ViewColumnOutlined from '@mui/icons-material/ViewColumnOutlined';
import Stack from '@mui/material/Stack';
import { Button, CheckField, InlineAlert } from '@opslog/ui';
import type { ListState } from './useListState';

/** "Columnas": the user picks what each list shows; the choice is kept on the server for them (FR-162). */
export function ColumnPicker({ list }: { list: ListState }) {
  const [open, setOpen] = React.useState(false);
  const { choices, selected, error, save } = list.columns;
  const id = React.useId();
  if (choices.length === 0) return null;
  const shown = (key: string) => selected === null || selected.includes(key);
  const toggle = (key: string, on: boolean) => {
    const all = choices.map((choice) => choice.key);
    const base = selected === null ? all : all.filter((k) => selected.includes(k));
    const next = on
      ? all.filter((k) => k === key || base.includes(k))
      : base.filter((k) => k !== key);
    void save(next.length === all.length ? null : next);
  };
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<ViewColumnOutlined />}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Columnas
      </Button>
      {open && (
        <Stack
          id={id}
          role="group"
          aria-label="Columnas visibles"
          direction="row"
          flexWrap="wrap"
          gap={2}
        >
          {choices.map((choice) => (
            <CheckField
              key={choice.key}
              label={choice.label}
              checked={shown(choice.key)}
              onChange={(on) => toggle(choice.key, on)}
            />
          ))}
          <Button variant="text" size="small" onClick={() => void save(null)}>
            Restablecer columnas
          </Button>
        </Stack>
      )}
      {error && <InlineAlert severity="warning">{error}</InlineAlert>}
    </>
  );
}
