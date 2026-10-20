import React from 'react';
import {
  BFF_LIST_LIMITS,
  isValidFilterValue,
  listModuleSpec,
  type BffFilterSpec,
} from '@opslog/contracts';
import { Field } from '@opslog/ui';
import type { ListState } from './useListState';

const INPUT: Readonly<Record<string, { type: string }>> = {
  date: { type: 'date' },
  month: { type: 'month' },
  int: { type: 'number' },
};

/** Text typed by the person; it reaches the address only once valid, so half-typed numbers never reload the list. */
function DraftField({
  id,
  label,
  spec,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  spec: BffFilterSpec;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  const invalid = text !== '' && !isValidFilterValue(spec, text);
  const hint =
    spec.kind === 'int'
      ? `Entre ${spec.min.toLocaleString('es-MX')} y ${spec.max.toLocaleString('es-MX')}.`
      : undefined;
  return (
    <Field
      id={id}
      label={label}
      type={INPUT[spec.kind]?.type ?? 'text'}
      value={text}
      error={invalid}
      {...(invalid && hint ? { helperText: hint } : {})}
      InputLabelProps={{ shrink: true }}
      onChange={(event) => {
        setText(event.target.value);
        if (event.target.value === '' || isValidFilterValue(spec, event.target.value))
          onCommit(event.target.value);
      }}
    />
  );
}

/** Page size of every list (SPECS §7), kept in the address as `limit`. */
export function PageSizeField({ list, label }: { list: ListState; label: string }) {
  const id = React.useId();
  return (
    <Field
      id={id}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={String(list.url.limit)}
      onChange={(event) => list.setLimit(Number(event.target.value))}
    >
      {BFF_LIST_LIMITS.map((size) => (
        <option key={size} value={size}>
          {size}
        </option>
      ))}
    </Field>
  );
}

/**
 * Range and date filters of the catalog (`yearFrom`, `hiredTo`, `expiresFrom`...) as inputs of a
 * FilterBar, and the page size. Filters that need a permission the reader lacks are not offered.
 */
export function ExtraFilters({
  list,
  keys,
  pageSizeLabel = 'Registros por página',
}: {
  list: ListState;
  keys: readonly string[];
  /** `null` leaves the page size out (lists that are not paginated). */
  pageSizeLabel?: string | null;
}) {
  const uid = React.useId();
  const filters = listModuleSpec(list.module).filters;
  return (
    <>
      {keys.map((key) => {
        const filter = filters[key];
        if (!filter || (filter.permission && !list.can(filter.permission))) return null;
        return (
          <DraftField
            key={key}
            id={`${uid}-${key}`}
            label={filter.label}
            spec={filter.spec}
            value={list.url.filters[key] ?? ''}
            onCommit={(value) => list.setFilter(key, value)}
          />
        );
      })}
      {pageSizeLabel !== null && <PageSizeField list={list} label={pageSizeLabel} />}
    </>
  );
}
