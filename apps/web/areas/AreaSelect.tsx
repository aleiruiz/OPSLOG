import React from 'react';
import { Field } from '@opslog/ui';
import type { AreaChoice } from './areaChoices';

export interface AreaSelectProps {
  readonly id: string;
  readonly label?: string;
  readonly value: string;
  readonly choices: readonly AreaChoice[];
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly error?: string | undefined;
  readonly description?: string | undefined;
  /** Label of the empty option: "Elige un área" in a form, "Todas las áreas" in a filter. */
  readonly emptyLabel?: string;
  /** In a filter every area (inactive too) is meaningful: nothing is disabled. */
  readonly allowInactive?: boolean;
}

/** Area selector: the areas of the company, never a free-text id. */
export function AreaSelect({
  id,
  label = 'Área',
  value,
  choices,
  onChange,
  required = false,
  error,
  description,
  emptyLabel = 'Elige un área',
  allowInactive = false,
}: AreaSelectProps) {
  const known = choices.some((choice) => choice.id === value);
  return (
    <Field
      id={id}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required={required}
      error={Boolean(error)}
      {...(error || description ? { helperText: error ?? description } : {})}
      fullWidth
    >
      <option value="">{emptyLabel}</option>
      {/* An id the catalog does not list (loaded from an old record) stays visible instead of silently clearing. */}
      {value !== '' && !known && <option value={value}>{value}</option>}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id} disabled={!allowInactive && choice.disabled}>
          {choice.label}
        </option>
      ))}
    </Field>
  );
}
