import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from '@testing-library/react';
import React from 'react';
import { afterEach } from 'vitest';
import { ThemeProvider } from '@mui/material/styles';
import { opslogTheme } from '@opslog/ui';
import { App } from '../App';
import { createMockApi, demoCredentials, type MockApi } from '../mockApi';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

export type Account = keyof typeof demoCredentials;

export async function renderApp(
  options: { path?: string; account?: Account | null; api?: MockApi; basename?: string } = {},
): Promise<RenderResult & { api: MockApi }> {
  const api = options.api ?? createMockApi();
  const account = options.account === undefined ? 'admin' : options.account;
  if (account) await api.auth.login(demoCredentials[account]);
  const basename = options.basename ?? '';
  window.history.replaceState(null, '', `${basename}${options.path ?? '/'}`);
  const view = render(
    <ThemeProvider theme={opslogTheme}>
      <App ports={api} basename={basename} />
    </ThemeProvider>,
  );
  return { api, ...view };
}

/** Wraps a screen in the providers it needs, with an already signed-in mock session. */
export async function renderWithSession(
  ui: React.ReactNode,
  options: { api?: MockApi; account?: Account } = {},
): Promise<RenderResult & { api: MockApi }> {
  const { RouterProvider } = await import('../router');
  const { SessionProvider, useSession } = await import('../../auth/session');
  const api = options.api ?? createMockApi();
  await api.auth.login(demoCredentials[options.account ?? 'admin']);
  function Gate({ children }: { children: React.ReactNode }) {
    const { state } = useSession();
    return state.status === 'authenticated' || state.status === 'expired' ? <>{children}</> : null;
  }
  const view = render(
    <ThemeProvider theme={opslogTheme}>
      <RouterProvider>
        <SessionProvider ports={api}>
          <Gate>{ui}</Gate>
        </SessionProvider>
      </RouterProvider>
    </ThemeProvider>,
  );
  return { api, ...view };
}

/** Required fields append " *" to their label, so labels match by prefix. */
export const labelStartingWith = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&')}`);
export const getField = (label: string) => screen.getByLabelText(labelStartingWith(label));
export const findField = (label: string) => screen.findByLabelText(labelStartingWith(label));
export const type = (label: string, value: string) =>
  fireEvent.change(getField(label), { target: { value } });

export const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

export { screen, waitFor, fireEvent };
