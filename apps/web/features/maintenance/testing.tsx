import React from 'react';
import axe from 'axe-core';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { afterEach } from 'vitest';
import { opslogTheme } from '@opslog/ui';
import { DirectoryProvider, type MaintenanceDirectory } from './directory';

afterEach(cleanup);

export const VEHICLES = [
  { id: 'veh-001', label: 'ECO-001 · Toyota Hilux' },
  { id: 'veh-002', label: 'ECO-002 · Nissan NP300' },
] as const;
export const MEMBERS = [
  { id: 'u-fleet', label: 'Responsable de flotilla 1' },
  { id: 'u-admin', label: 'Administración 1' },
] as const;
export const TEST_DIRECTORY: MaintenanceDirectory = {
  vehicles: VEHICLES,
  vehiclesTruncated: false,
  members: MEMBERS,
  membersTruncated: false,
};

/** Renders a maintenance view with the design system theme (no app shell) and a people/vehicles directory. */
export function renderView(
  node: React.ReactElement,
  directory: MaintenanceDirectory = TEST_DIRECTORY,
): RenderResult {
  return render(
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      <DirectoryProvider value={directory}>{node}</DirectoryProvider>
    </ThemeProvider>,
  );
}

/** Rules that need layout (contrast) run in the browser suite (e2e/maintenance.spec.ts). */
export async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      'heading-order': { enabled: false },
      // Best practice, not WCAG: the design system's NextStepPanel is an <aside> that sits inside
      // the shell's <main>. The browser suite checks the WCAG tags with contrast.
      'landmark-complementary-is-top-level': { enabled: false },
    },
  });
  return results.violations.map(
    (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(' ')}`,
  );
}

export const ADMIN = ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'];
export const EDITOR = ['view', 'create', 'edit'];
export const VIEWER = ['view'];
