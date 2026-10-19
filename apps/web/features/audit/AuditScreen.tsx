import Box from '@mui/material/Box';
import React from 'react';
import type { BffAuditQuery } from '@opslog/contracts';
import { Button, Field, FilterBar, InlineAlert, PageHeader, Panel, UiState } from '@opslog/ui';
import { NoSubmit } from '../../app/resource';
import { useSession } from '../../auth/session';
import { AuditResults } from './AuditResults';
import { DOMAIN_OPTIONS, ENTITY_OPTIONS, RESULT_OPTIONS } from './labels';
import { ReconciliationPanel } from './ReconciliationPanel';
import { resolveRange, SHORTCUTS, shortcutDays } from './range';
import { useCompanyZone } from './useCompanyZone';

interface Filters {
  readonly fromDay: string;
  readonly toDay: string;
  readonly action: string;
  readonly entityType: string;
  readonly result: string;
}
const NONE: Filters = { fromDay: '', toDay: '', action: '', entityType: '', result: '' };

/** S26 Auditoría: who did what and when, read-only, with the reconciliation of what was recorded (FR-170/171). */
export function AuditScreen({ now = Date.now }: { readonly now?: () => number }) {
  const { can } = useSession();
  const zone = useCompanyZone();
  const uid = React.useId();
  const [filters, setFilters] = React.useState<Filters>(NONE);
  if (!can('view_audit')) return <UiState kind="no-permission" />;

  const range = resolveRange(filters.fromDay, filters.toDay, zone);
  const query: BffAuditQuery = {
    ...(range.ok && range.from && range.to ? { from: range.from, to: range.to } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.result ? { result: filters.result as 'success' | 'denied' } : {}),
  };
  const active = JSON.stringify(filters) !== JSON.stringify(NONE);
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const select = (
    id: keyof Filters,
    label: string,
    allLabel: string,
    options: readonly { value: string; label: string }[],
  ) => (
    <Field
      id={`${uid}-${id}`}
      label={label}
      select
      SelectProps={{ native: true }}
      InputLabelProps={{ shrink: true }}
      value={filters[id]}
      onChange={(event) => set({ [id]: event.target.value })}
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Field>
  );
  const date = (id: 'fromDay' | 'toDay', label: string) => (
    <Field
      id={`${uid}-${id}`}
      label={label}
      type="date"
      InputLabelProps={{ shrink: true }}
      value={filters[id]}
      onChange={(event) => set({ [id]: event.target.value })}
    />
  );

  return (
    <>
      <PageHeader
        eyebrow="Análisis"
        title="Auditoría"
        description="Quién hizo qué y cuándo. Sin periodo se muestran los últimos 30 días. Es de solo lectura."
      />
      <NoSubmit>
        <Panel>
          <Box
            role="group"
            aria-label="Periodos rápidos"
            sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}
          >
            {SHORTCUTS.map((shortcut) => (
              <Button
                key={shortcut.id}
                variant="outlined"
                size="small"
                onClick={() => {
                  const days = shortcutDays(shortcut.id, now(), zone);
                  set({ fromDay: days.from, toDay: days.to });
                }}
              >
                {shortcut.label}
              </Button>
            ))}
          </Box>
          <FilterBar onClear={() => setFilters(NONE)}>
            {date('fromDay', 'Desde')}
            {date('toDay', 'Hasta')}
            {select('action', 'Módulo', 'Todos los módulos', DOMAIN_OPTIONS)}
            {select('entityType', 'Tipo de registro', 'Todos los registros', ENTITY_OPTIONS)}
            {select('result', 'Resultado', 'Todos los resultados', RESULT_OPTIONS)}
          </FilterBar>
        </Panel>
      </NoSubmit>
      {range.ok ? (
        <>
          <AuditResults query={query} filtersActive={active} zone={zone} />
          <ReconciliationPanel from={range.from} to={range.to} zone={zone} />
        </>
      ) : (
        <InlineAlert severity="warning">{range.message}</InlineAlert>
      )}
    </>
  );
}
