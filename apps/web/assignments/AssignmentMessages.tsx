import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;
export const assignmentsPath = '/flota/asignaciones';
export const assignmentPath = (id: string) => `${assignmentsPath}/${encodeURIComponent(id)}`;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function AssignmentNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Asignación no encontrada"
        description="Revisa la dirección o vuelve al listado."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={assignmentsPath} sx={link}>
          Volver a asignaciones
        </RouterLink>
      </Box>
    </>
  );
}

/** A closed assignment is read-only; closing it again explains why instead of showing a form. */
export function AssignmentNotEndable({ assignmentId }: { assignmentId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Esta asignación ya está cerrada"
        description="Una asignación cerrada es un registro histórico de solo lectura. Para corregirla, asigna de nuevo."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={assignmentPath(assignmentId)} sx={link}>
          Volver a la asignación
        </RouterLink>
      </Box>
    </>
  );
}
