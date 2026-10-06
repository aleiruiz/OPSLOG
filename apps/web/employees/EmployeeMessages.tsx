import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;
export const employeesPath = '/plantilla/empleados';
export const employeePath = (id: string) => `${employeesPath}/${encodeURIComponent(id)}`;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function EmployeeNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Empleado no encontrado"
        description="Revisa la dirección o vuelve al listado."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={employeesPath} sx={link}>
          Volver a empleados
        </RouterLink>
      </Box>
    </>
  );
}

/** Archived and terminated employees are read-only; editing them explains why instead of showing a form. */
export function EmployeeNotEditable({ employeeId }: { employeeId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Este empleado no se puede editar"
        description="Está archivado o dado de baja: es un registro histórico de solo lectura."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={employeePath(employeeId)} sx={link}>
          Volver al empleado
        </RouterLink>
      </Box>
    </>
  );
}
