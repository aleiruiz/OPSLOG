import Box from '@mui/material/Box';
import React from 'react';
import { NextStepPanel, PageHeader } from '@opslog/ui';
import { AlertsSummary } from '../alerts/AlertsSummary';
import type { Permission, SessionInfo } from './types';

/** Landing screen: what the person can do next, derived from their permissions only. */
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
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 2fr) minmax(280px, 1fr)' },
          alignItems: 'start',
          gap: 2,
          // The cards of the grid are spaced by the gap, not by their own margin.
          '& > *': { mb: 0 },
        }}
      >
        {can('view') && <AlertsSummary />}
        <NextStepPanel title="Siguiente paso" steps={steps} />
      </Box>
    </>
  );
}
