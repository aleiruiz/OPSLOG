import React from 'react';
import axe from 'axe-core';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { afterEach } from 'vitest';
import { opslogTheme } from '@opslog/ui';

afterEach(cleanup);

/** Renders a maintenance view with the design system theme (no app shell). */
export function renderView(node: React.ReactElement): RenderResult {
  return render(
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      {node}
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

export const ADMIN = ['view', 'create', 'edit', 'view_costs', 'approve', 'reopen'];
export const EDITOR = ['view', 'create', 'edit'];
export const VIEWER = ['view'];
