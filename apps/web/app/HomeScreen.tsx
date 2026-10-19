import Box from '@mui/material/Box';
import React from 'react';
import { NextStepPanel, PageHeader } from '@opslog/ui';
import { AlertsSummary } from '../alerts/AlertsSummary';
import { DashboardScreen } from '../features/dashboard/DashboardScreen';
import type { Permission, SessionInfo } from './types';

/**
 * Landing screen (S02): the dashboard (the server sends only the widgets the reader may see), then what the
 * person can do next, derived from their permissions only.
 */
export function HomeScreen({
  session,
  can,
}: {
  session: SessionInfo;
  can: (permission: Permission) => boolean;
}) {
  const steps: string[] = [];
  if (can('manage_config')) steps.push('Revisa los datos y la política de acceso de la empresa.');
  if (can('manage_users')) steps.push('Invita a tu equipo y revisa sus roles.');
  if (steps.length === 0)
    steps.push('Tu rol permite consultar información. Pronto verás aquí tus módulos.');
  return (
    <>
      <PageHeader
        eyebrow={session.company.name}
        title="Inicio"
        description={`Esta es la cuenta de ${session.company.name} con el rol ${session.roleLabel}.`}
      />
      <DashboardScreen />
      <Box
        sx={{
          display: 'grid',
          mt: 3,
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 2fr) minmax(280px, 1fr)' },
          alignItems: 'start',
          gap: 2,
          // The cards of the grid are spaced by the gap, not by their own margin.
          '& > *': { mb: 0 },
          // Without the summary (no permission or an expired session) the next step stays narrow.
          '&:has(> :only-child)': { gridTemplateColumns: 'minmax(0, 720px)' },
        }}
      >
        {can('view') && <AlertsSummary />}
        <NextStepPanel title="Siguiente paso" steps={steps} />
      </Box>
    </>
  );
}
