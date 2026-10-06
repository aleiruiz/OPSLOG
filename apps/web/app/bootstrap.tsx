import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { opslogTheme } from '@opslog/ui';
import { App } from './App';
import type { ApiPorts } from './types';

/** Mounts the shell. The caller chooses the port implementation (mock or the BFF client). */
export function mountApp(
  container: HTMLElement,
  ports: ApiPorts,
  options: { basename?: string } = {},
): Root {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ThemeProvider theme={opslogTheme}>
        <CssBaseline />
        <App ports={ports} basename={options.basename ?? ''} />
      </ThemeProvider>
    </React.StrictMode>,
  );
  return root;
}
