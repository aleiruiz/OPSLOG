import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import type { Area } from '../../app/types';
import { Field, InlineAlert } from '@opslog/ui';
import { customRangeError, RANGE_CHOICES, type RangeChoice } from './range';

export interface DashboardFilterValues {
  readonly areaId: string;
  readonly choice: RangeChoice;
  readonly customFrom: string;
  readonly customTo: string;
}

/** Area (its descendants count too) and range with shortcuts. Shortcuts wait for the company's day. */
export function DashboardFilters({
  values,
  areas,
  ready,
  onChange,
}: {
  values: DashboardFilterValues;
  areas: readonly Area[];
  /** The company's day is known (a first answer arrived): the shortcuts need it. */
  ready: boolean;
  onChange: (patch: Partial<DashboardFilterValues>) => void;
}) {
  const uid = React.useId();
  const error =
    values.choice === 'custom' ? customRangeError(values.customFrom, values.customTo) : null;
  return (
    <Box
      component="form"
      role="search"
      aria-label="Filtros del dashboard"
      onSubmit={(event: React.FormEvent) => event.preventDefault()}
      sx={{ display: 'grid', gap: 2, mb: 2 }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-end' }}>
        <Box sx={{ minWidth: { xs: '100%', sm: 260 } }}>
          <Field
            id={`${uid}-area`}
            label="Área"
            select
            fullWidth
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
            value={values.areaId}
            onChange={(event) => onChange({ areaId: event.target.value })}
          >
            <MenuItem value="">Toda la empresa</MenuItem>
            {areas.map((area) => (
              <MenuItem key={area.id} value={area.id}>
                {`${'  '.repeat(Math.max(0, area.depth - 1))}${area.name}`}
              </MenuItem>
            ))}
          </Field>
        </Box>
        <ToggleButtonGroup
          exclusive
          size="small"
          aria-label="Periodo"
          value={values.choice}
          onChange={(_event, next: RangeChoice | null) => next && onChange({ choice: next })}
          sx={{ flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButton-root': { borderRadius: 1 } }}
        >
          {RANGE_CHOICES.map((item) => (
            <ToggleButton
              key={item.id}
              value={item.id}
              disabled={!ready && item.id !== 'default'}
              sx={{ textTransform: 'none', minHeight: 40 }}
            >
              {item.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
      {values.choice === 'custom' && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          <Field
            id={`${uid}-from`}
            label="Desde"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={values.customFrom}
            onChange={(event) => onChange({ customFrom: event.target.value })}
          />
          <Field
            id={`${uid}-to`}
            label="Hasta"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={values.customTo}
            onChange={(event) => onChange({ customTo: event.target.value })}
          />
        </Box>
      )}
      {error && <InlineAlert severity="warning">{error}</InlineAlert>}
    </Box>
  );
}
