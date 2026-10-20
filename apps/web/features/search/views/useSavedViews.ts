import React from 'react';
import type { BffSavedView } from '@opslog/contracts';
import type { ListState } from './useListState';
import { dropNotice, viewErrorText } from './viewMessages';

export interface SavedViewsControl {
  readonly views: readonly BffSavedView[] | null;
  readonly selected: BffSavedView | null;
  readonly busy: boolean;
  readonly error: string | null;
  /** Applied view that left things out for this reader. */
  readonly notice: string | null;
  readonly select: (id: string) => void;
  readonly save: (input: { name: string; shared: boolean }) => Promise<boolean>;
  readonly update: (input: { name: string; shared: boolean }) => Promise<boolean>;
  readonly remove: () => Promise<boolean>;
}

/** Saved views of one list: load, apply (revalidated by the server), create, update and delete. */
export function useSavedViews(list: ListState): SavedViewsControl {
  const { views: ports, module, onExpired } = list;
  const [views, setViews] = React.useState<readonly BffSavedView[] | null>(null);
  const [selectedId, setSelectedId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    if (!ports) return;
    const result = await ports.list(module);
    if (result.ok) setViews(result.value.items);
    else if (result.error.status === 401) onExpired();
    else setViews([]);
  }, [ports, module]);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  const selected = views?.find((view) => view.id === selectedId) ?? null;
  const content = () => ({
    filters: list.url.filters,
    sort: list.url.sort,
    columns: list.columns.selected,
  });
  const fail = async (status: number, text: string, code: string): Promise<false> => {
    if (status === 401) onExpired();
    else {
      setError(text);
      if (code === 'stale_version' || code === 'not_found') await reload();
    }
    return false;
  };
  return {
    views,
    selected,
    busy,
    error,
    notice,
    select: (id) => {
      setError(null);
      setSelectedId(id);
      const view = views?.find((candidate) => candidate.id === id);
      setNotice(view ? dropNotice(view.dropped) : null);
      if (!view) return;
      list.replace({ filters: view.filters, sort: view.sort });
      list.columns.preview(view.columns);
    },
    save: async (input) => {
      if (!ports) return false;
      setBusy(true);
      setError(null);
      const result = await ports.create({ module, ...input, ...content() });
      setBusy(false);
      if (!result.ok)
        return fail(result.error.status, viewErrorText(result.error), result.error.code);
      setSelectedId(result.value.id);
      setNotice(null);
      await reload();
      return true;
    },
    update: async (input) => {
      if (!ports || !selected) return false;
      setBusy(true);
      setError(null);
      const result = await ports.update(selected.id, {
        version: selected.version,
        ...input,
        ...content(),
      });
      setBusy(false);
      if (!result.ok)
        return fail(result.error.status, viewErrorText(result.error), result.error.code);
      setNotice(null);
      await reload();
      return true;
    },
    remove: async () => {
      if (!ports || !selected) return false;
      setBusy(true);
      setError(null);
      const result = await ports.remove(selected.id);
      setBusy(false);
      if (!result.ok)
        return fail(result.error.status, viewErrorText(result.error), result.error.code);
      setSelectedId('');
      setNotice(null);
      await reload();
      return true;
    },
  };
}
