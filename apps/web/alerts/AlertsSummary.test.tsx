import { render } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import { opslogTheme } from '@opslog/ui';
import type { ResourceState } from '../app/resource';
import { createMockApi } from '../app/mockApi';
import { RouterProvider } from '../app/router';
import { click, renderApp, screen, within } from '../app/test/utils';
import { makeDocument } from '../documents/fixtures';
import { AlertsSummaryView, type AlertsSummaryData } from './AlertsSummary';

const summary = () => screen.findByRole('region', { name: 'Vencimientos' });

describe('home alerts summary', () => {
  it('counts the expired and the expiring documents and policies, and links to the list', async () => {
    const api = createMockApi();
    const list = vi.spyOn(api.alerts, 'list');
    await renderApp({ api });
    const region = await summary();
    expect(await within(region).findByText('12 vencidos')).toBeInTheDocument();
    expect(within(region).getByText('22 por vencer en 30 días')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Ver alertas' })).toHaveAttribute(
      'href',
      '/flota/alertas',
    );
    expect(list).toHaveBeenCalledWith({ limit: 25, severity: 'expired' });
    expect(list).toHaveBeenCalledWith({ limit: 25, severity: 'expiring' });
  });

  it('is shown to read-only roles as well', async () => {
    await renderApp({ account: 'viewer' });
    const region = await summary();
    expect(await within(region).findByText('12 vencidos')).toBeInTheDocument();
  });

  it('uses the singular for one record and says so when nothing is pending', async () => {
    const one = await renderApp({
      api: createMockApi({
        documents: [makeDocument({ expiresOn: '2026-10-05' })],
        policies: [],
      }),
    });
    const region = await summary();
    expect(await within(region).findByText('1 vencido')).toBeInTheDocument();
    expect(within(region).getByText('0 por vencer en 30 días')).toBeInTheDocument();
    one.unmount();
    await renderApp({ api: createMockApi({ documents: [], policies: [] }) });
    expect(
      await screen.findByText('Ningún documento ni seguro vence en los próximos 30 días.'),
    ).toBeInTheDocument();
  });

  it('offers a retry when it cannot be loaded, without blocking the rest of the page', async () => {
    const api = createMockApi();
    api.controls.failNext('listAlerts');
    await renderApp({ api });
    expect(
      await screen.findByText('No pudimos cargar el resumen de vencimientos.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Inicio', level: 1 })).toBeInTheDocument();
    click('Reintentar');
    expect(await screen.findByText('12 vencidos')).toBeInTheDocument();
  });

  it('shows nothing when the role cannot read alerts or the session expired', async () => {
    const api = createMockApi();
    api.controls.failNext('listAlerts', 403);
    await renderApp({ api });
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    await screen.findByText(/Revisa los datos y la política de acceso/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: 'Vencimientos' })).toBeNull();
  });

  it('renders the loading and the zero states of the view', () => {
    const { unmount } = renderView({ status: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Cargando vencimientos');
    unmount();
    renderView({ status: 'expired' });
    expect(screen.queryByRole('region')).toBeNull();
  });
});

function renderView(state: ResourceState<AlertsSummaryData>) {
  return render(
    <ThemeProvider theme={opslogTheme}>
      <RouterProvider>
        <AlertsSummaryView state={state} onRetry={() => undefined} />
      </RouterProvider>
    </ThemeProvider>,
  );
}
