import React from 'react';
import Stack from '@mui/material/Stack';
import { Button, CheckField, ConfirmDialog, Field, InlineAlert } from '@opslog/ui';
import { BFF_VIEW_NAME_MAX } from '@opslog/contracts';
import { ColumnPicker } from './ColumnPicker';
import type { ListState } from './useListState';
import { useSavedViews } from './useSavedViews';

type Mode = null | 'create' | 'update';

/**
 * "Vistas guardadas" (FR-162): apply, save, update and delete the views of one list, and pick the
 * columns. The server revalidates a view for each reader, so what cannot be used arrives already left out.
 */
export function ViewsBar({ list }: { list: ListState }) {
  const saved = useSavedViews(list);
  const [mode, setMode] = React.useState<Mode>(null);
  const [name, setName] = React.useState('');
  const [shared, setShared] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const id = React.useId();
  if (!list.views) return null;
  const { selected, views } = saved;
  const mine = (views ?? []).filter((view) => view.mine);
  const others = (views ?? []).filter((view) => !view.mine);

  const open = (next: Exclude<Mode, null>) => {
    setName(next === 'update' && selected ? selected.name : '');
    setShared(next === 'update' && selected ? selected.shared : false);
    setMode(next);
  };
  const submit = async () => {
    const done = await (mode === 'update'
      ? saved.update({ name, shared })
      : saved.save({ name, shared }));
    if (done) setMode(null);
  };
  return (
    <Stack gap={1.5} sx={{ mb: 2 }} role="group" aria-label="Vistas guardadas">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        gap={1.5}
        alignItems={{ sm: 'center' }}
        flexWrap="wrap"
      >
        <Field
          id={`${id}-view`}
          label="Vista guardada"
          select
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          value={selected?.id ?? ''}
          disabled={views === null}
          onChange={(event) => saved.select(event.target.value)}
        >
          <option value="">Sin vista aplicada</option>
          {mine.length > 0 && (
            <optgroup label="Mis vistas">
              {mine.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.shared ? `${view.name} (compartida)` : view.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Compartidas por la empresa">
              {others.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </optgroup>
          )}
        </Field>
        <Button variant="outlined" size="small" onClick={() => open('create')}>
          Guardar vista
        </Button>
        {selected?.canEdit && (
          <>
            <Button variant="outlined" size="small" onClick={() => open('update')}>
              Actualizar vista
            </Button>
            <Button variant="text" size="small" onClick={() => setConfirming(true)}>
              Eliminar vista
            </Button>
          </>
        )}
        <ColumnPicker list={list} />
      </Stack>
      {saved.notice && <InlineAlert severity="warning">{saved.notice}</InlineAlert>}
      {saved.error && mode === null && <InlineAlert severity="error">{saved.error}</InlineAlert>}
      {mode !== null && (
        <Stack
          role="group"
          aria-label={mode === 'update' ? 'Actualizar vista' : 'Guardar vista'}
          direction={{ xs: 'column', sm: 'row' }}
          gap={1.5}
          alignItems={{ sm: 'center' }}
          flexWrap="wrap"
        >
          <Field
            id={`${id}-name`}
            label="Nombre de la vista"
            value={name}
            inputProps={{ maxLength: BFF_VIEW_NAME_MAX }}
            onChange={(event) => setName(event.target.value)}
          />
          <CheckField label="Compartir con la empresa" checked={shared} onChange={setShared} />
          <Button
            variant="contained"
            size="small"
            loading={saved.busy}
            disabled={name.trim() === ''}
            onClick={() => void submit()}
          >
            {mode === 'update' ? 'Guardar cambios' : 'Guardar'}
          </Button>
          <Button variant="text" size="small" onClick={() => setMode(null)}>
            Cancelar
          </Button>
          {saved.error && <InlineAlert severity="error">{saved.error}</InlineAlert>}
        </Stack>
      )}
      {confirming && selected && (
        <ConfirmDialog
          title="Eliminar vista"
          description={`Se eliminará la vista «${selected.name}». Los filtros actuales no cambian.`}
          confirmLabel="Eliminar"
          busy={saved.busy}
          {...(saved.error ? { error: saved.error } : {})}
          onConfirm={() => void saved.remove().then((done) => done && setConfirming(false))}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Stack>
  );
}
