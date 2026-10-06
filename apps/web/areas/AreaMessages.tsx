import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function AreaNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Área no encontrada"
        description="Revisa la dirección o vuelve a la estructura de áreas."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to="/plantilla/areas" sx={link}>
          Volver a áreas
        </RouterLink>
      </Box>
    </>
  );
}

/** An inactive area is read-only: editing or moving it explains why instead of showing a form. */
export function AreaNotEditable({ areaId }: { areaId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Esta área no se puede modificar"
        description="Está inactiva y es de solo lectura. Actívala para poder editarla o moverla."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={`/plantilla/areas/${encodeURIComponent(areaId)}`} sx={link}>
          Volver al área
        </RouterLink>
      </Box>
    </>
  );
}
