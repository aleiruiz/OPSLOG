import React from 'react';
import type { BffReportFilter } from '@opslog/contracts';
import { Field } from '@opslog/ui';
import { copy } from './labels';

/** One input per filter of the report, by kind: a list for enums, a day for dates, free text otherwise. */
export function FilterFields({
  filters,
  values,
  onChange,
}: {
  readonly filters: readonly BffReportFilter[];
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (id: string, value: string) => void;
}) {
  const uid = React.useId();
  return (
    <>
      {filters.map((filter) => {
        const id = `${uid}-${filter.id}`;
        const common = {
          id,
          label: filter.label,
          value: values[filter.id] ?? '',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            onChange(filter.id, event.target.value),
          InputLabelProps: { shrink: true },
        };
        if (filter.kind === 'enum')
          return (
            <Field key={filter.id} {...common} select SelectProps={{ native: true }}>
              <option value="">{copy.allOptions}</option>
              {(filter.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Field>
          );
        return (
          <Field
            key={filter.id}
            {...common}
            type={filter.kind === 'date' ? 'date' : filter.kind === 'number' ? 'number' : 'text'}
          />
        );
      })}
    </>
  );
}
