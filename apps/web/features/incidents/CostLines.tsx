import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Button, DataTable, Panel, UiState } from '@opslog/ui';
import { ScrollRegion } from '../../app/ScrollRegion';
import { CostLineForm } from './CostLineForm';
import { atLineLimit, type CostEdits, type LineDraft } from './costsModel';
import { COST_KIND_LABELS, categoryLabel } from './labelsCosts';
import { formatMinor, parseAmount } from './money';

/**
 * Gastos y recuperaciones: the case's own cost lines. Changes are staged here (added, changed, removed) and sent
 * together by the parent with one save, so a conflict never loses what was typed.
 */
export function CostLines({
  lines,
  edits,
  editable,
  defaultCurrency,
  onEdits,
}: {
  lines: readonly LineDraft[];
  edits: CostEdits;
  editable: boolean;
  defaultCurrency: string;
  onEdits: (next: CostEdits) => void;
}) {
  const [form, setForm] = React.useState<'new' | LineDraft | null>(null);
  const save = (line: LineDraft) => {
    if (form === 'new' || form === null) onEdits({ ...edits, added: [...edits.added, line] });
    else if (line.id === null)
      onEdits({
        ...edits,
        added: edits.added.map((item) => (item.key === line.key ? line : item)),
      });
    else onEdits({ ...edits, changed: { ...edits.changed, [line.id]: line } });
    setForm(null);
  };
  const remove = (line: LineDraft) =>
    onEdits(
      line.id === null
        ? { ...edits, added: edits.added.filter((item) => item.key !== line.key) }
        : {
            ...edits,
            removed: [...edits.removed, line.id],
            changed: Object.fromEntries(
              Object.entries(edits.changed).filter(([id]) => id !== line.id),
            ),
          },
    );
  const draftOf = (key: string): LineDraft => lines.find((line) => line.key === key) as LineDraft;
  const pending = (line: LineDraft) => line.id === null || edits.changed[line.id] !== undefined;
  return (
    <Panel
      title="Gastos y recuperaciones"
      description="Lo que la empresa pagó y lo que otra parte pagó o reembolsó. Las reparaciones con orden vinculada se suman aparte."
      actions={
        editable && form === null && !atLineLimit(lines) ? (
          <Button variant="contained" onClick={() => setForm('new')}>
            Agregar línea
          </Button>
        ) : undefined
      }
    >
      {form !== null && (
        <CostLineForm
          key={form === 'new' ? 'new' : form.key}
          initial={form === 'new' ? null : form}
          currency={defaultCurrency}
          onSubmit={save}
          onCancel={() => setForm(null)}
        />
      )}
      {lines.length === 0 ? (
        <UiState
          kind="empty"
          title="Sin gastos ni recuperaciones"
          description={
            editable
              ? 'Agrega el deducible, la grúa, las multas o lo que pagó la aseguradora.'
              : 'Cuando se registren aparecerán aquí.'
          }
        />
      ) : (
        <ScrollRegion label="Líneas de costo">
          <DataTable
            caption={`${lines.length} líneas de costo`}
            rows={lines.map((line) => ({ ...line, lineId: line.id, id: line.key }))}
            columns={[
              {
                key: 'kind',
                label: 'Movimiento',
                render: (_value, row) => (
                  <>
                    {COST_KIND_LABELS[row.kind]}
                    {pending(draftOf(row.id)) && (
                      <Typography variant="body2" color="text.secondary">
                        Sin guardar
                      </Typography>
                    )}
                  </>
                ),
              },
              {
                key: 'category',
                label: 'Concepto',
                render: (_value, row) => categoryLabel(row.kind, row.category),
              },
              {
                key: 'amount',
                label: 'Monto',
                render: (_value, row) => {
                  const minor = parseAmount(row.amount, row.currency);
                  return minor === null ? row.amount : formatMinor(minor, row.currency);
                },
              },
              { key: 'note', label: 'Nota', render: (_value, row) => row.note || 'Sin nota' },
              ...(editable
                ? [
                    {
                      key: 'id' as const,
                      label: 'Acciones',
                      render: (
                        _value: unknown,
                        row: {
                          id: string;
                          kind: LineDraft['kind'];
                          category: LineDraft['category'];
                        },
                      ) => (
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Button
                            variant="text"
                            onClick={() => setForm(draftOf(row.id))}
                          >{`Editar ${categoryLabel(row.kind, row.category)}`}</Button>
                          <Button
                            variant="text"
                            color="error"
                            onClick={() => remove(draftOf(row.id))}
                          >{`Quitar ${categoryLabel(row.kind, row.category)}`}</Button>
                        </Box>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </ScrollRegion>
      )}
    </Panel>
  );
}
