import React from 'react';
import Box from '@mui/material/Box';
import { BFF_EXPENSE_CATEGORIES, BFF_RECOVERY_CATEGORIES } from '@opslog/contracts';
import type { BffCostCategory, BffCostKind } from '@opslog/contracts';
import { Button, Field, InlineAlert } from '@opslog/ui';
import { COST_KIND_LABELS, categoryLabel } from './labelsCosts';
import { lineProblem, nextKey, type LineDraft } from './costsModel';

const CATEGORIES: Readonly<Record<BffCostKind, readonly BffCostCategory[]>> = {
  expense: BFF_EXPENSE_CATEGORIES,
  recovery: BFF_RECOVERY_CATEGORIES,
};

/**
 * One cost line, typed the way it reads on paper: kind (expense or recovery), concept, amount, currency and a
 * short note. The driver is never a payer (D15), so there is no such concept. It validates what the server
 * would refuse and hands the line back; nothing is sent from here.
 */
export function CostLineForm({
  initial,
  currency,
  onSubmit,
  onCancel,
}: {
  initial: LineDraft | null;
  currency: string;
  onSubmit: (line: LineDraft) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = React.useState<BffCostKind>(initial?.kind ?? 'expense');
  const [category, setCategory] = React.useState<BffCostCategory>(initial?.category ?? 'repair');
  const [amount, setAmount] = React.useState(initial?.amount ?? '');
  const [code, setCode] = React.useState(initial?.currency ?? currency);
  const [note, setNote] = React.useState(initial?.note ?? '');
  const [problem, setProblem] = React.useState<string | null>(null);
  const id = React.useId();
  const changeKind = (next: BffCostKind) => {
    setKind(next);
    if (!CATEGORIES[next].includes(category))
      setCategory(next === 'expense' ? 'repair' : 'insurer');
  };
  const submit = () => {
    const line: LineDraft = {
      key: initial?.key ?? nextKey(),
      id: initial?.id ?? null,
      kind,
      category,
      amount: amount.trim(),
      currency: code.trim(),
      note: note.trim(),
    };
    const found = lineProblem(line);
    setProblem(found);
    if (found === null) onSubmit(line);
  };
  return (
    <Box
      component="form"
      aria-label={initial ? 'Editar línea de costo' : 'Agregar línea de costo'}
      noValidate
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        submit();
      }}
      sx={{ display: 'grid', gap: 2, maxWidth: 720, mb: 2 }}
    >
      {problem && <InlineAlert severity="error">{problem}</InlineAlert>}
      <Field
        id={`${id}-kind`}
        label="Tipo de movimiento"
        select
        SelectProps={{ native: true }}
        InputLabelProps={{ shrink: true }}
        value={kind}
        onChange={(event) => changeKind(event.target.value as BffCostKind)}
      >
        {(Object.keys(COST_KIND_LABELS) as BffCostKind[]).map((value) => (
          <option key={value} value={value}>
            {COST_KIND_LABELS[value]}
          </option>
        ))}
      </Field>
      <Field
        id={`${id}-category`}
        label="Concepto"
        select
        SelectProps={{ native: true }}
        InputLabelProps={{ shrink: true }}
        value={category}
        onChange={(event) => setCategory(event.target.value as BffCostCategory)}
      >
        {CATEGORIES[kind].map((value) => (
          <option key={value} value={value}>
            {categoryLabel(kind, value)}
          </option>
        ))}
      </Field>
      <Field
        id={`${id}-amount`}
        label="Monto"
        required
        value={amount}
        inputProps={{ inputMode: 'decimal' }}
        onChange={(event) => setAmount(event.target.value)}
      />
      <Field
        id={`${id}-currency`}
        label="Moneda"
        required
        value={code}
        description="Código de tres letras, por ejemplo MXN."
        onChange={(event) => setCode(event.target.value.toUpperCase())}
      />
      <Field
        id={`${id}-note`}
        label="Nota (opcional)"
        value={note}
        description="Hasta 200 caracteres. No escribas datos personales."
        onChange={(event) => setNote(event.target.value)}
      />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="text" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="contained">
          {initial ? 'Actualizar línea' : 'Agregar línea'}
        </Button>
      </Box>
    </Box>
  );
}
