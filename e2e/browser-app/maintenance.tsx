// Mounts the maintenance feature with in-memory ports shaped like the accepted MNT-PLANS/MNT-ORDERS
// routes. `?as=admin|editor|mechanic|viewer` picks the session grants the fake server applies.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { opslogTheme } from '@opslog/ui';
import { MaintenanceArea } from '../../apps/web/features/maintenance/MaintenanceArea';
import {
  baseOrder,
  createFakeMaintenancePorts,
} from '../../apps/web/features/maintenance/fakePorts';

const as = new URLSearchParams(window.location.search).get('as') ?? 'admin';
const grants: Record<string, string[]> = {
  admin: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
  editor: ['view', 'create', 'edit'],
  mechanic: ['view'],
  viewer: ['view'],
};
const at = '2026-10-12T12:00:00.000Z';
const fake = createFakeMaintenancePorts({
  viewCosts: as === 'admin',
  ...(as === 'mechanic' ? { scopedTo: ['mec-1'] } : {}),
  orders: [
    baseOrder({
      id: 'wo-1',
      description: 'Frenos rechinan',
      status: 'assigned',
      version: 2,
      mechanicId: 'mec-1',
      workshopId: 'ws-1',
      scheduledDate: '2026-10-14',
      responsibleId: 'u-fleet',
    }),
    baseOrder({ id: 'wo-2', description: 'Ruido en suspensión', vehicleId: 'veh-002' }),
    baseOrder({
      id: 'wo-3',
      kind: 'preventive',
      planId: 'plan-1',
      occurrenceId: 'occ-1',
      description: 'Servicio de 10 000 km',
      status: 'completed',
      version: 6,
      mechanicId: 'mec-2',
      scheduledDate: '2026-10-10',
      actualDate: '2026-10-11',
      actualKm: 10400,
      tasks: [{ id: 't1', description: 'Cambio de aceite y filtro' }],
      parts: [
        {
          id: 'p1',
          name: 'Filtro de aceite',
          quantity: '1',
          unitCost: { amountMinor: '45050', currency: 'MXN' },
        },
      ],
      costs: [{ id: 'c1', category: 'labor', amount: { amountMinor: '125000', currency: 'MXN' } }],
    }),
  ],
  plans: [
    {
      id: 'plan-1',
      vehicleId: 'veh-001',
      state: 'active',
      intervalDays: 30,
      intervalKm: 10000,
      lastServiceDate: '2026-09-11',
      lastServiceKm: 400,
      defaultWorkshopId: 'ws-1',
      defaultMechanicId: null,
      version: 3,
      createdAt: at,
      updatedAt: at,
    },
  ],
  workshops: [
    {
      id: 'ws-1',
      name: 'Taller Centro',
      specialties: ['frenos', 'motor'],
      contact: '555-0100',
      active: true,
      createdAt: at,
      updatedAt: at,
    },
  ],
  mechanics: [
    {
      id: 'mec-1',
      name: 'Ana Mecánica',
      specialties: ['frenos'],
      contact: null,
      kind: 'internal',
      workshopId: 'ws-1',
      memberId: 'u-mech',
      active: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'mec-2',
      name: 'Luis Externo',
      specialties: ['motor'],
      contact: null,
      kind: 'external',
      workshopId: null,
      memberId: null,
      active: true,
      createdAt: at,
      updatedAt: at,
    },
  ],
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      <MaintenanceArea
        ports={fake.ports}
        permissions={grants[as] ?? []}
        userId={as === 'mechanic' ? 'u-mech' : 'u-fleet'}
        members={[{ id: 'u-mech', label: 'Ana Mecánica (usuario)' }]}
        initialView={as === 'mechanic' ? 'mine' : 'orders'}
        onExpired={() => undefined}
      />
    </ThemeProvider>
  </React.StrictMode>,
);
