import React from 'react';
import Box from '@mui/material/Box';
import { Button, Field, InlineAlert } from '@opslog/ui';
import type { SubmitOutcome } from './EventForm';

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'multiline' | 'date' | 'select';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Text of the empty choice of a select. */
  readonly empty?: string;
  readonly description?: string;
  readonly required?: boolean;
  /** Draws the field only when this holds for the values shown (a reason that depends on a choice). */
  readonly when?: (values: Readonly<Record<string, string>>) => boolean;
}

/**
 * A plain form over string fields. `base` is what the server holds; what the person types is kept apart as
 * `edits`, so a refreshed `base` after a conflict never overwrites unsent text, and a save sends only the
 * fields that changed. The caller maps the strings to the request.
 */
export function RecordForm({
  label,
  fields,
  base,
  submitLabel,
  onSubmit,
  onReload,
  actions,
}: {
  label: string;
  fields: readonly FieldSpec[];
  base: Readonly<Record<string, string>>;
  submitLabel: string;
  onSubmit: (changed: Readonly<Record<string, string>>) => Promise<SubmitOutcome>;
  onReload?: () => void;
  actions?: React.ReactNode;
}) {
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<{ message: string; stale: boolean } | null>(null);
  const prefix = React.useId();
  const values = { ...base, ...edits };
  const pristine = Object.keys(edits).length === 0;
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await onSubmit(edits);
    setBusy(false);
    if (outcome.ok) setEdits({});
    else setProblem({ message: outcome.message, stale: outcome.stale === true });
  };
  return (
    <Box
      component="form"
      aria-label={label}
      noValidate
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'grid', gap: 2, maxWidth: 720 }}
    >
      {problem && (
        <InlineAlert
          severity={problem.stale ? 'warning' : 'error'}
          {...(problem.stale && onReload
            ? {
                action: (
                  <Button
                    color="inherit"
                    onClick={() => {
                      setProblem(null);
                      onReload();
                    }}
                  >
                    Recargar
                  </Button>
                ),
              }
            : {})}
        >
          {problem.message}
        </InlineAlert>
      )}
      {fields
        .filter((field) => field.when === undefined || field.when(values))
        .map((field) => {
          const common = {
            id: `${prefix}-${field.key}`,
            label: field.label,
            value: values[field.key] ?? '',
            ...(field.required ? { required: true } : {}),
            ...(field.description ? { description: field.description } : {}),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              setEdits((current) => ({ ...current, [field.key]: event.target.value })),
          };
          if (field.kind === 'select')
            return (
              <Field
                key={field.key}
                {...common}
                select
                SelectProps={{ native: true }}
                InputLabelProps={{ shrink: true }}
              >
                <option value="">{field.empty ?? 'Sin dato'}</option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Field>
            );
          if (field.kind === 'date')
            return (
              <Field key={field.key} {...common} type="date" InputLabelProps={{ shrink: true }} />
            );
          return (
            <Field
              key={field.key}
              {...common}
              {...(field.kind === 'multiline' ? { multiline: true, minRows: 2 } : {})}
            />
          );
        })}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {actions}
        <Button type="submit" variant="contained" loading={busy} disabled={pristine}>
          {submitLabel}
        </Button>
      </Box>
    </Box>
  );
}
