import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DataTable, StatusBadge } from '@opslog/ui';
import { RouterLink } from '../app/router';
import type { Area } from '../app/types';
import { Mono, linkSx } from './AreaDetailParts';
import { areaPath } from './AreaTreeView';
import { areaStatus, formatDateTime } from './labels';
import type { AreaContext } from './loadAreas';
import { MAX_AREA_DEPTH } from './rules';

export function Detail({ context }: { context: AreaContext }) {
  const { area, areas } = context;
  const status = areaStatus(area);
  const parent = areas.find((item) => item.id === area.parentId);
  const rows: [string, React.ReactNode][] = [
    ['Nombre', area.name],
    ['Código', area.code ? <Mono>{area.code}</Mono> : 'Sin código'],
    ['Estado', <StatusBadge label={status.label} tone={status.tone} />],
    ['Nivel', `${area.depth} de ${MAX_AREA_DEPTH}`],
    [
      'Área superior',
      area.parentId === null ? (
        'Ninguna: es un área raíz'
      ) : (
        <RouterLink to={areaPath(area.parentId)} sx={linkSx}>
          {parent?.name ?? 'Ver área superior'}
        </RouterLink>
      ),
    ],
    [
      'Responsables',
      area.responsibleIds.length === 0 ? (
        'Sin responsables'
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {area.responsibleIds.map((id) => (
            <li key={id}>
              <Mono>{id}</Mono>
            </li>
          ))}
        </Box>
      ),
    ],
    ['Vehículos activos', String(area.resourceCounts.vehicles)],
    ['Personas activas', String(area.resourceCounts.people)],
    ['Creada', formatDateTime(area.createdAt)],
    ['Última actualización', formatDateTime(area.updatedAt)],
    ...(area.deactivatedAt === null
      ? []
      : ([['Desactivada', formatDateTime(area.deactivatedAt)]] as [string, React.ReactNode][])),
  ];
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1.5 },
        m: 0,
        maxWidth: 720,
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body1"
            sx={{ m: 0, mb: { xs: 1.5, sm: 0 }, overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}

export function SubAreas({ children }: { children: readonly Area[] }) {
  return (
    <Box component="section" aria-labelledby="sub-areas-title" sx={{ mt: 4 }}>
      <Typography id="sub-areas-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Sub-áreas
      </Typography>
      {children.length === 0 ? (
        <Typography color="text.secondary">Esta área no tiene sub-áreas.</Typography>
      ) : (
        <Box sx={{ overflowX: 'auto', maxWidth: '100%' }}>
          <DataTable<Area>
            caption={`Sub-áreas (${children.length})`}
            columns={[
              {
                key: 'name',
                label: 'Nombre',
                render: (_, row) => (
                  <RouterLink to={areaPath(row.id)} sx={linkSx}>
                    {row.name}
                  </RouterLink>
                ),
              },
              {
                key: 'code',
                label: 'Código',
                render: (value) => (value ? <Mono>{String(value)}</Mono> : '—'),
              },
              {
                key: 'active',
                label: 'Estado',
                render: (_, row) => {
                  const status = areaStatus(row);
                  return <StatusBadge label={status.label} tone={status.tone} />;
                },
              },
              {
                key: 'responsibleIds',
                label: 'Responsables',
                render: (_, row) => String(row.responsibleIds.length),
              },
            ]}
            rows={[...children]}
          />
        </Box>
      )}
    </Box>
  );
}
