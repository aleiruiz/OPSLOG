import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffDashboard } from '@opslog/contracts';
import { UiState } from '@opslog/ui';
import { RouterButton } from '../../app/router';
import { useSession } from '../../auth/session';
import { formatDateTime, formatDay } from '../incidents/time';
import { isEmptyWidget, WidgetView } from './WidgetView';

const grid = {
  display: 'grid',
  gridTemplateColumns: {
    xs: 'minmax(0, 1fr)',
    sm: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(4, minmax(0, 1fr))',
  },
  gap: 2,
  mb: 3,
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <Box component="section" aria-labelledby={id}>
      <Typography id={id} component="h2" variant="h2" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      <Box sx={grid}>{children}</Box>
    </Box>
  );
}

/** The widgets the server sent, grouped by the day they describe; nothing is rendered for what is absent. */
export function DashboardBody({ data, refreshing }: { data: BffDashboard; refreshing: boolean }) {
  const { can } = useSession();
  const today = data.widgets.filter((widget) => widget.scope === 'today');
  const range = data.widgets.filter((widget) => widget.scope === 'range');
  const allEmpty = data.widgets.every(isEmptyWidget);
  return (
    <Box aria-busy={refreshing}>
      {allEmpty && (
        <Box sx={{ mb: 3 }}>
          <UiState
            kind="empty"
            title="Aún no hay datos para calcular indicadores"
            description="Cuando registres vehículos, conductores, documentos o mantenimientos, los indicadores aparecerán aquí."
          />
          {can('create') && (
            <Box sx={{ display: 'flex', justifyContent: 'center' }}>
              <RouterButton to="/flota/vehiculos/nuevo" variant="contained">
                Registrar un vehículo
              </RouterButton>
            </Box>
          )}
        </Box>
      )}
      <Typography
        variant="caption"
        color="text.secondary"
        role="status"
        sx={{ display: 'block', mb: 2 }}
      >
        {refreshing
          ? 'Actualizando indicadores…'
          : `Cifras al ${formatDateTime(data.asOf, data.timeZone)} (hora de la empresa, ${data.timeZone}); pueden tener hasta 5 minutos de antigüedad.`}
      </Typography>
      {today.length > 0 && (
        <Section title={`Situación de hoy, ${formatDay(data.today)}`}>
          {today.map((widget) => (
            <WidgetView key={widget.id} widget={widget} />
          ))}
        </Section>
      )}
      {range.length > 0 && (
        <Section
          title={`Indicadores del periodo, ${formatDay(data.range.from)} al ${formatDay(data.range.to)}`}
        >
          {range.map((widget) => (
            <WidgetView key={widget.id} widget={widget} />
          ))}
        </Section>
      )}
    </Box>
  );
}
