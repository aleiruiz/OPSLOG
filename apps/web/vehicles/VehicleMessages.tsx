import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function VehicleNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Vehículo no encontrado"
        description="Revisa la dirección o vuelve al listado."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to="/flota/vehiculos" sx={link}>
          Volver a vehículos
        </RouterLink>
      </Box>
    </>
  );
}

/** Archived or decommissioned vehicles are read-only; editing them explains why instead of showing a form. */
export function VehicleNotEditable({ vehicleId }: { vehicleId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Este vehículo no se puede editar"
        description="Está archivado o dado de baja: es un registro histórico de solo lectura."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={`/flota/vehiculos/${encodeURIComponent(vehicleId)}`} sx={link}>
          Volver al vehículo
        </RouterLink>
      </Box>
    </>
  );
}
