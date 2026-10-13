import React from 'react';
import axe from 'axe-core';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { opslogTheme } from '@opslog/ui';
import { RouterProvider, useRouter } from '../../app/router';
import { DirectoryProvider } from '../maintenance/directory';
import { IncidentEnvProvider, type IncidentEnv } from './context';
import { IncidentDetail } from './IncidentDetail';
import { createFakeIncidentPorts, type FakeIncidentOptions } from './fakePorts';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

export const ADMIN = [
  'view',
  'create',
  'manage_config',
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
];
/** Fleet editor of the old roles: generic grants plus the right to see incidents, nothing of their own. */
export const FLEET_EDITOR = ['view', 'create', 'edit', 'incidents:view'];
export const VIEWER = ['incidents:view'];
export const REPORTER = ['incidents:view', 'incidents:report'];
export const MANAGER = [
  'view',
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:close',
  'incidents:view_costs',
];
export const APPROVER = ['incidents:view', 'incidents:approve'];

export const VEHICLES = [
  { id: 'veh-001', label: 'ECO-001 · Toyota Hilux' },
  { id: 'veh-002', label: 'ECO-002 · Nissan NP300' },
] as const;

export type Rendered = RenderResult & {
  readonly fake: ReturnType<typeof createFakeIncidentPorts>;
  readonly onExpired: ReturnType<typeof vi.fn>;
  readonly env: IncidentEnv;
};

export interface View {
  readonly permissions?: readonly string[];
  readonly path?: string;
  readonly options?: Omit<FakeIncidentOptions, 'permissions'>;
  readonly env?: Partial<IncidentEnv>;
  readonly vehicles?: typeof VEHICLES | null;
  /** Runs before the first render, for example to make the first request fail. */
  readonly prepare?: (fake: ReturnType<typeof createFakeIncidentPorts>) => void;
}

/** Renders an incident view with the theme, router, directory and env, against the in-memory ports. */
export function renderIncident(node: React.ReactElement, view: View = {}): Rendered {
  const permissions = view.permissions ?? ADMIN;
  window.history.replaceState(null, '', view.path ?? '/incidents');
  const fake = createFakeIncidentPorts({
    ...view.options,
    permissions,
    vehicles: [
      { id: 'veh-001', economicNumber: 'ECO-001', plate: 'ABC-123' },
      { id: 'veh-002', economicNumber: 'ECO-002', plate: 'XYZ-987' },
    ],
  });
  view.prepare?.(fake);
  const onExpired = vi.fn();
  const env: IncidentEnv = {
    ports: fake.ports,
    permissions,
    userId: 'user-me',
    zone: 'America/Mexico_City',
    members: [
      { id: 'user-me', label: 'Tú' },
      { id: 'user-2', label: 'Responsable de flotilla 1' },
    ],
    drivers: [{ id: 'emp-2', label: 'Luis Gómez · EMP-2' }],
    mayChangeVehicles: permissions.includes('edit'),
    photoRequired: false,
    approvalThreshold: null,
    onExpired,
    ...view.env,
  };
  const utils: RenderResult = render(
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      <RouterProvider>
        <DirectoryProvider
          value={{
            vehicles: view.vehicles === null ? null : (view.vehicles ?? VEHICLES),
            vehiclesTruncated: false,
            members: [],
            membersTruncated: false,
          }}
        >
          <IncidentEnvProvider value={env}>{node}</IncidentEnvProvider>
        </DirectoryProvider>
      </RouterProvider>
    </ThemeProvider>,
  );
  return { ...utils, fake, onExpired, env };
}

/** Rules that need layout (contrast) run in the browser suite (e2e/incidents-real.spec.ts). */
export async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      'heading-order': { enabled: false },
      'landmark-complementary-is-top-level': { enabled: false },
    },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

/** The detail as the shell mounts it: the case and the tab come from the address. */
export function RoutedDetail() {
  const { path } = useRouter();
  const [, , id = '', tab] = path.split('/');
  return <IncidentDetail id={id} tab={tab} />;
}
