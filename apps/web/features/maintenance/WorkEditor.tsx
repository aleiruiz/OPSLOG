import React from 'react';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Button, Field, FormSection } from '@opslog/ui';
import type {
  BffWorkOrder,
  BffWorkOrderCost,
  BffWorkOrderCostsInput,
  BffWorkOrderWorkInput,
} from '@opslog/contracts';
import { COST_CATEGORY_LABELS } from './labels';

/** Work facts: tasks (one per line) and parts. Parts are order records, never stock. */
export function WorkEditor({
  order,
  busy,
  onSubmit,
  onCancel,
}: {
  order: BffWorkOrder;
  busy: boolean;
  onSubmit: (body: BffWorkOrderWorkInput) => void;
  onCancel: () => void;
}) {
  const [tasks, setTasks] = React.useState(order.tasks.map((task) => task.description).join('\n'));
  const [parts, setParts] = React.useState(
    order.parts.map((part) => ({
      id: part.id as string | undefined,
      name: part.name,
      quantity: part.quantity,
    })),
  );
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const lines = tasks
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    onSubmit({
      version: order.version,
      tasks: lines.map((description) => {
        const known = order.tasks.find((task) => task.description === description);
        return known ? { id: known.id, description } : { description };
      }),
      parts: parts
        .filter((part) => part.name.trim())
        .map((part) => ({
          ...(part.id ? { id: part.id } : {}),
          name: part.name.trim(),
          quantity: part.quantity.trim(),
        })),
    });
  };
  return (
    <Card component="form" aria-label="Registrar trabajo" onSubmit={submit} sx={{ p: 2 }}>
      <FormSection title="Registrar trabajo" description="Escribe un trabajo realizado por línea.">
        <Field
          id="mnt-work-tasks"
          label="Trabajos realizados"
          multiline
          minRows={3}
          value={tasks}
          onChange={(event) => setTasks(event.target.value)}
        />
        <Typography component="h3" variant="subtitle1">
          Refacciones usadas
        </Typography>
        {parts.map((part, index) => (
          <Stack
            key={part.id ?? `new-${index}`}
            direction={{ xs: 'column', sm: 'row' }}
            gap={1}
            alignItems={{ sm: 'center' }}
          >
            <Field
              id={`mnt-part-name-${index}`}
              label={`Refacción ${index + 1}`}
              value={part.name}
              onChange={(event) =>
                setParts(
                  parts.map((p, i) => (i === index ? { ...p, name: event.target.value } : p)),
                )
              }
            />
            <Field
              id={`mnt-part-qty-${index}`}
              label={`Cantidad de la refacción ${index + 1}`}
              value={part.quantity}
              inputProps={{ inputMode: 'decimal' }}
              onChange={(event) =>
                setParts(
                  parts.map((p, i) => (i === index ? { ...p, quantity: event.target.value } : p)),
                )
              }
            />
            <IconButton
              aria-label={`Quitar refacción ${index + 1}`}
              onClick={() => setParts(parts.filter((_, i) => i !== index))}
            >
              ×
            </IconButton>
          </Stack>
        ))}
        <Button
          variant="outlined"
          onClick={() => setParts([...parts, { id: undefined, name: '', quantity: '1' }])}
        >
          Agregar refacción
        </Button>
        <Stack direction="row" gap={1}>
          <Button type="submit" variant="contained" loading={busy}>
            Guardar trabajo
          </Button>
          <Button variant="text" onClick={onCancel}>
            Volver
          </Button>
        </Stack>
      </FormSection>
    </Card>
  );
}

const MAJOR = /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/;
/** `1250.5` → `125050`: exact string arithmetic in the minor unit (two decimals), no floating point. */
export function toMinor(major: string): string | null {
  const value = major.trim().replace(/,/g, '');
  if (!MAJOR.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}${fraction.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}
const toMajor = (minor: string) => {
  const digits = minor.padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Costs need `view_costs`; this editor is only rendered for callers that have it. */
export function CostEditor({
  order,
  busy,
  onSubmit,
  onCancel,
}: {
  order: BffWorkOrder;
  busy: boolean;
  onSubmit: (body: BffWorkOrderCostsInput) => void;
  onCancel: () => void;
}) {
  const [lines, setLines] = React.useState(
    (order.costs ?? []).map((cost) => ({
      id: cost.id as string | undefined,
      category: cost.category,
      amount: toMajor(cost.amount.amountMinor),
      currency: cost.amount.currency,
    })),
  );
  const [error, setError] = React.useState<string | null>(null);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const costs = lines.map((line) => ({ line, minor: toMinor(line.amount) }));
    if (costs.some(({ minor, line }) => minor === null || !/^[A-Z]{3}$/.test(line.currency))) {
      setError('Revisa los importes (hasta dos decimales) y la moneda de tres letras.');
      return;
    }
    setError(null);
    onSubmit({
      version: order.version,
      costs: costs.map(({ line, minor }) => ({
        ...(line.id ? { id: line.id } : {}),
        category: line.category,
        amount: { amountMinor: minor as string, currency: line.currency },
      })),
    });
  };
  return (
    <Card component="form" aria-label="Registrar costos" onSubmit={submit} sx={{ p: 2 }}>
      <FormSection
        title="Registrar costos"
        description="Importes exactos con su moneda; no se suman monedas distintas."
      >
        {error && (
          <Typography role="alert" color="error">
            {error}
          </Typography>
        )}
        {lines.map((line, index) => (
          <Stack key={line.id ?? `new-${index}`} direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <Field
              select
              id={`mnt-cost-category-${index}`}
              label={`Concepto ${index + 1}`}
              value={line.category}
              onChange={(event) =>
                setLines(
                  lines.map((l, i) =>
                    i === index
                      ? { ...l, category: event.target.value as BffWorkOrderCost['category'] }
                      : l,
                  ),
                )
              }
            >
              {(Object.keys(COST_CATEGORY_LABELS) as BffWorkOrderCost['category'][]).map(
                (category) => (
                  <MenuItem key={category} value={category}>
                    {COST_CATEGORY_LABELS[category]}
                  </MenuItem>
                ),
              )}
            </Field>
            <Field
              id={`mnt-cost-amount-${index}`}
              label={`Importe ${index + 1}`}
              value={line.amount}
              inputProps={{ inputMode: 'decimal' }}
              onChange={(event) =>
                setLines(
                  lines.map((l, i) => (i === index ? { ...l, amount: event.target.value } : l)),
                )
              }
            />
            <Field
              id={`mnt-cost-currency-${index}`}
              label={`Moneda ${index + 1}`}
              value={line.currency}
              onChange={(event) =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, currency: event.target.value.toUpperCase() } : l,
                  ),
                )
              }
            />
          </Stack>
        ))}
        <Button
          variant="outlined"
          onClick={() =>
            setLines([...lines, { id: undefined, category: 'labor', amount: '', currency: '' }])
          }
        >
          Agregar costo
        </Button>
        <Stack direction="row" gap={1}>
          <Button type="submit" variant="contained" loading={busy}>
            Guardar costos
          </Button>
          <Button variant="text" onClick={onCancel}>
            Volver
          </Button>
        </Stack>
      </FormSection>
    </Card>
  );
}
