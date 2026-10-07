import Box from '@mui/material/Box';
import React from 'react';
import { StatusBadge } from '@opslog/ui';
import { RouterLink } from '../app/router';
import type { Area, Employee } from '../app/types';
import { areaPath } from '../areas/AreaTreeView';
import { Mono, Rows, linkSx } from './EmployeeDetailShared';
import {
  fitnessPresentation,
  formatDate,
  formatDateTime,
  fullName,
  kindLabels,
  statusPresentation,
} from './labels';

export function Detail({ employee, areas }: { employee: Employee; areas: readonly Area[] }) {
  const status = statusPresentation[employee.status];
  const area = areas.find((item) => item.id === employee.areaId);
  const fitness = employee.fitness ? fitnessPresentation(employee.fitness) : null;
  const rows: [string, React.ReactNode][] = [
    ['Nombre', fullName(employee)],
    ['Tipo', kindLabels[employee.kind]],
    [
      'Número de empleado',
      employee.employeeNumber ? <Mono>{employee.employeeNumber}</Mono> : 'Sin número',
    ],
    ['Puesto', employee.position ?? 'Sin puesto'],
    ['Fecha de ingreso', employee.hireDate ? formatDate(employee.hireDate) : 'Sin fecha'],
    [
      'Área',
      <RouterLink to={areaPath(employee.areaId)} sx={linkSx}>
        {area ? area.name : employee.areaId}
      </RouterLink>,
    ],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Motivo del estado', employee.statusReason],
    ...(fitness && employee.fitness
      ? ([
          [
            'Aptitud para operar',
            <>
              <StatusBadge label={fitness.label} tone={fitness.tone} />
              {fitness.reasons.length > 0 && (
                <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                  {fitness.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </Box>
              )}
            </>,
          ],
          [
            'Tipo de licencia',
            employee.licenseType ? <Mono>{employee.licenseType}</Mono> : 'Sin tipo',
          ],
          [
            'Vigencia de la licencia',
            employee.licenseExpiresOn ? formatDate(employee.licenseExpiresOn) : 'Sin vigencia',
          ],
        ] as [string, React.ReactNode][])
      : []),
    ['Registrado', formatDateTime(employee.createdAt)],
    ['Última actualización', formatDateTime(employee.updatedAt)],
    ...(employee.archivedAt === null
      ? []
      : ([['Archivado', formatDateTime(employee.archivedAt)]] as [string, React.ReactNode][])),
  ];
  return <Rows rows={rows} />;
}
