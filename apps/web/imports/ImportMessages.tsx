import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;
export const importsPath = '/flota/importaciones';
export const importPath = (id: string) => `${importsPath}/${encodeURIComponent(id)}`;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function ImportNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Importación no encontrada"
        description="Revisa la dirección o vuelve al historial."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={importsPath} sx={link}>
          Volver a importaciones
        </RouterLink>
      </Box>
    </>
  );
}
