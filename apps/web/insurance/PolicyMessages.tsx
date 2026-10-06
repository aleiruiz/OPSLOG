import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;
export const policiesPath = '/flota/seguros';
export const policyPath = (id: string) => `${policiesPath}/${encodeURIComponent(id)}`;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function PolicyNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Póliza no encontrada"
        description="Revisa la dirección o vuelve al listado."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={policiesPath} sx={link}>
          Volver a seguros
        </RouterLink>
      </Box>
    </>
  );
}

/** Archived policies are read-only; changing them explains why instead of showing a form. */
export function PolicyNotEditable({ policyId }: { policyId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Esta póliza no se puede cambiar"
        description="Está archivada: es un registro histórico de solo lectura."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={policyPath(policyId)} sx={link}>
          Volver a la póliza
        </RouterLink>
      </Box>
    </>
  );
}
