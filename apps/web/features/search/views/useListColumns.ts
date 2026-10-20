import React from 'react';
import { listModuleSpec, type BffListColumn, type BffListModule } from '@opslog/contracts';
import type { CanUse } from './urlState';
import type { ViewsPorts } from './ports';

export interface ListColumnsControl {
  /** Columns this reader may choose (the identifying ones are always shown and not offered). */
  readonly choices: readonly BffListColumn[];
  /** Keys shown now; `null` means the module's defaults (every column). */
  readonly selected: readonly string[] | null;
  readonly error: string | null;
  /** Persists the choice for this user and list. `null` goes back to the defaults. */
  readonly save: (columns: readonly string[] | null) => Promise<void>;
  /** Uses a column set without persisting it (applying a saved view). */
  readonly preview: (columns: readonly string[] | null) => void;
  /** Keeps the columns of a table that the user chose, in the table's own order. */
  readonly visible: <T extends { readonly key: string }>(columns: readonly T[]) => T[];
}

/** Visible columns of one list, persisted per user and module on the server. Without ports the list shows all. */
export function useListColumns(
  module: BffListModule,
  views: ViewsPorts | undefined,
  can: CanUse,
  onExpired: () => void,
): ListColumnsControl {
  const spec = listModuleSpec(module);
  const [selected, setSelected] = React.useState<readonly string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!views) return undefined;
    let current = true;
    void views.columns(module).then((result) => {
      if (!current) return;
      if (result.ok) setSelected(result.value.columns);
      else if (result.error.status === 401) onExpired();
    });
    return () => {
      current = false;
    };
  }, [views, module]);

  const choices = spec.columns.filter(
    (column) => !column.locked && (column.permission === undefined || can(column.permission)),
  );
  const locked = new Set(
    spec.columns.filter((column) => column.locked).map((column) => column.key),
  );
  const known = new Set<string>(spec.columns.map((column) => column.key));
  return {
    choices,
    selected,
    error,
    preview: setSelected,
    save: async (columns) => {
      setSelected(columns);
      setError(null);
      if (!views) return;
      const result = await views.saveColumns(module, columns);
      if (result.ok) setSelected(result.value.columns);
      else if (result.error.status === 401) onExpired();
      else setError('No pudimos guardar tus columnas. Tu elección solo vale en esta pantalla.');
    },
    visible: (columns) =>
      columns.filter(
        (column) =>
          selected === null ||
          locked.has(column.key) ||
          !known.has(column.key) ||
          selected.includes(column.key),
      ),
  };
}
