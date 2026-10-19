import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  fireEvent,
  renderApp,
  renderWithSession,
  screen,
  waitFor,
  within,
} from '../../app/test/utils';
import {
  createFakeIntegrations,
  demoDelivery,
  demoEndpoint,
  type FakeIntegrations,
} from './fakePorts';
import { errorLabel } from './labels';
import { IntegrationsScreen } from './IntegrationsScreen';
import { createIntegrationsPorts } from './ports';

const withFake = (options: Parameters<typeof createFakeIntegrations>[0] = {}) => {
  const integrations = createFakeIntegrations(options);
  return { integrations, api: Object.assign(createMockApi(), { integrations }) };
};
const names = (fake: FakeIntegrations) => fake.calls.map((call) => call.name);
const URL = 'https://hooks.ejemplo.com/opslog';

async function openForm() {
  const add = await screen.findByRole('button', { name: 'Agregar endpoint' });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
}

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map((item) => item.id);
}

describe('routing', () => {
  it('serves /configuracion/integraciones to the administrator and lists the endpoints', async () => {
    await renderApp({ path: '/configuracion/integraciones' });
    expect(
      await screen.findByRole('heading', { name: 'Integraciones', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(URL)).toBeInTheDocument();
  });

  it('does not offer the screen to someone without the permission', async () => {
    await renderApp({ path: '/configuracion/integraciones', account: 'viewer' });
    expect(screen.queryByRole('heading', { name: 'Integraciones', level: 1 })).toBeNull();
  });

  it('serves the demo endpoint and history through the mock port to the administrator', async () => {
    const api = createMockApi();
    await api.auth.login((await import('../../app/mockApi')).demoCredentials.admin);
    const list = await api.integrations.list();
    expect(list).toMatchObject({ ok: true, value: { max: 5, items: [{ id: 'wh-1' }] } });
    expect(await api.integrations.deliveries('wh-1')).toMatchObject({
      ok: true,
      value: { total: 2 },
    });
    const created = await api.integrations.create({ url: URL, events: ['vehicle.created'] });
    expect(created.ok).toBe(true);
    expect(await api.integrations.test('wh-1')).toMatchObject({ ok: true });
    expect(await api.integrations.update('wh-1', { version: 1, active: false })).toMatchObject({
      ok: true,
    });
    expect(await api.integrations.rotate('wh-1', 2)).toMatchObject({ ok: true });
    expect(await api.integrations.retry('wh-1', 'del-2')).toMatchObject({ ok: true });
    expect(await api.integrations.remove('wh-1')).toEqual({ ok: true, value: undefined });
  });

  it('answers 403 from the mock port without the permission', async () => {
    const api = createMockApi();
    await api.auth.login((await import('../../app/mockApi')).demoCredentials.viewer);
    expect(await api.integrations.list()).toMatchObject({ ok: false, error: { status: 403 } });
  });
});

describe('list', () => {
  it('shows state, events and the empty and error states, accessibly', async () => {
    const { api } = withFake({
      endpoints: [
        demoEndpoint(),
        demoEndpoint({ id: 'wh-2', url: 'https://b.ejemplo.com/x', active: false, disabled: true }),
      ],
    });
    const { container } = await renderWithSession(<IntegrationsScreen />, { api });
    expect(
      await screen.findAllByText('Vehículo creado, Cambio de aptitud de conductor'),
    ).toHaveLength(2);
    expect(screen.getAllByText(/Desactivado por fallas/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Falló 20 veces seguidas/)).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('shows the empty state and recovers from a failed load', async () => {
    const { api, integrations } = withFake();
    integrations.failNext('list', 500);
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByText('Aún no hay endpoints')).toBeInTheDocument();
  });
});

describe('create', () => {
  it('registers an endpoint and shows the secret once, with copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { api, integrations } = withFake();
    await renderWithSession(<IntegrationsScreen />, { api });
    await openForm();
    fireEvent.change(await screen.findByLabelText(/Dirección HTTPS/), { target: { value: URL } });
    fireEvent.click(screen.getByLabelText('Vehículo creado'));
    click('Guardar');
    expect(await screen.findByText('Guarda este secreto ahora')).toBeInTheDocument();
    const secret = integrations.issued[0] as string;
    expect(screen.getByLabelText('Secreto de firma')).toHaveTextContent(secret);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar secreto' }));
    expect(await screen.findByText('Secreto copiado')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(secret);
    click('Ya lo guardé');
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
    // The list read never carries it.
    expect(JSON.stringify(await integrations.list())).not.toContain(secret);
  });

  it('survives a failing clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const { api } = withFake();
    await renderWithSession(<IntegrationsScreen />, { api });
    await openForm();
    fireEvent.change(await screen.findByLabelText(/Dirección HTTPS/), { target: { value: URL } });
    fireEvent.click(screen.getByLabelText('Vehículo creado'));
    click('Guardar');
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar secreto' }));
    expect(screen.queryByText('Secreto copiado')).toBeNull();
  });

  it('asks for at least one event and explains a rejected address', async () => {
    const { api } = withFake();
    await renderWithSession(<IntegrationsScreen />, { api });
    await openForm();
    fireEvent.change(await screen.findByLabelText(/Dirección HTTPS/), { target: { value: URL } });
    click('Guardar');
    expect(await screen.findByText('Elige al menos un evento.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Dirección HTTPS/), {
      target: { value: 'https://private.ejemplo.com/x' },
    });
    fireEvent.click(screen.getByLabelText('Vehículo creado'));
    click('Guardar');
    expect(await screen.findByText(/no es válida o no es pública/)).toBeInTheDocument();
  });

  it('blocks the sixth endpoint', async () => {
    const endpoints = Array.from({ length: 5 }, (_, i) =>
      demoEndpoint({ id: `wh-${i}`, url: `https://h${i}.ejemplo.com/x` }),
    );
    const { api } = withFake({ endpoints });
    await renderWithSession(<IntegrationsScreen />, { api });
    expect(await screen.findByText(/Llegaste al máximo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar endpoint' })).toBeDisabled();
  });

  it('reports a failed save and a conflict, and lets go of the form', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Editar ${URL}` }));
    integrations.failNext('update', 500);
    click('Guardar');
    expect(await screen.findByText(/No se pudo guardar/)).toBeInTheDocument();
    integrations.failNext('update', 409);
    click('Guardar');
    expect(await screen.findByText(/Alguien más cambió/)).toBeInTheDocument();
    click('Cancelar');
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
  });
});

describe('edit, rotate, test and delete', () => {
  it('edits the events and the active flag with the version', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Editar ${URL}` }));
    fireEvent.click(await screen.findByLabelText('Siniestro creado'));
    fireEvent.click(screen.getByLabelText('Activo'));
    click('Guardar');
    await waitFor(() =>
      expect(integrations.endpoints[0]).toMatchObject({ active: false, version: 2 }),
    );
    expect(integrations.endpoints[0]?.events).toContain('incident.created');
    expect(await screen.findByText('Inactivo')).toBeInTheDocument();
  });

  it('rotates after confirming and shows the new secret and the grace period', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Rotar secreto ${URL}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('¿Rotar el secreto?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotar secreto' }));
    expect(await screen.findByText('Guarda este secreto ahora')).toBeInTheDocument();
    expect(integrations.issued).toHaveLength(1);
    expect(
      await screen.findByText(/El secreto anterior sigue válido hasta 2026-10-20 16:00/),
    ).toBeInTheDocument();
  });

  it('keeps the dialog result honest when rotating fails', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Rotar secreto ${URL}` }));
    integrations.failNext('rotate', 409);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rotar secreto' }),
    );
    expect(await screen.findByText(/Alguien más cambió/)).toBeInTheDocument();
    expect(screen.queryByText('Guarda este secreto ahora')).toBeNull();
  });

  it('sends a test and shows it in the history; an inactive endpoint cannot be tested', async () => {
    const { api, integrations } = withFake({
      endpoints: [
        demoEndpoint(),
        demoEndpoint({ id: 'wh-2', url: 'https://b.ejemplo.com/x', active: false }),
      ],
    });
    await renderWithSession(<IntegrationsScreen />, { api });
    expect(
      await screen.findByRole('button', { name: 'Enviar prueba https://b.ejemplo.com/x' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: `Enviar prueba ${URL}` }));
    expect(await screen.findByText(/Prueba enviada/)).toBeInTheDocument();
    expect(await screen.findByText('Prueba')).toBeInTheDocument();
    expect(names(integrations)).toContain('test');
  });

  it('reports a failed test', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    integrations.failNext('test', 500);
    fireEvent.click(await screen.findByRole('button', { name: `Enviar prueba ${URL}` }));
    expect(await screen.findByText(/No se pudo guardar/)).toBeInTheDocument();
  });

  it('deletes after confirming, and cancels without deleting', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Eliminar ${URL}` }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancelar' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(integrations.endpoints).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: `Eliminar ${URL}` }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Eliminar' }),
    );
    expect(await screen.findByText('Aún no hay endpoints')).toBeInTheDocument();
    expect(integrations.endpoints).toHaveLength(0);
  });

  it('keeps the endpoint when deleting fails', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Eliminar ${URL}` }));
    integrations.failNext('remove', 500);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Eliminar' }),
    );
    expect(await screen.findByText(/No se pudo guardar/)).toBeInTheDocument();
    expect(screen.getByText(URL)).toBeInTheDocument();
  });
});

describe('delivery history', () => {
  const deliveries = {
    'wh-1': [
      demoDelivery(),
      demoDelivery({
        id: 'del-2',
        eventType: 'driver.created',
        status: 'failed',
        attempts: 2,
        lastStatusCode: 500,
        lastDurationMs: 910,
        lastError: 'http_500',
      }),
      demoDelivery({
        id: 'del-3',
        eventType: 'incident.closed',
        status: 'dead_letter',
        attempts: 6,
        lastStatusCode: null,
        lastDurationMs: 10_000,
        lastError: 'timeout',
      }),
      demoDelivery({
        id: 'del-4',
        eventType: 'vehicle.updated',
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastDurationMs: null,
        lastAttemptAt: null,
      }),
    ],
  };

  it('shows code, duration, attempt and state, never a receiver body, and retries a failed one', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()], deliveries });
    const { container } = await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Entregas ${URL}` }));
    const table = await screen.findByRole('table', { name: 'Entregas' });
    expect(within(table).getByText('Entregada')).toBeInTheDocument();
    expect(within(table).getByText('Descartada')).toBeInTheDocument();
    expect(within(table).getByText('84 ms')).toBeInTheDocument();
    expect(within(table).getByText('El receptor respondió con error 500')).toBeInTheDocument();
    expect(within(table).getByText('El receptor no respondió a tiempo')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    fireEvent.click(within(table).getByRole('button', { name: 'Reintentar Siniestro cerrado' }));
    expect(await screen.findByText('Reintento programado.')).toBeInTheDocument();
    expect(integrations.deliveriesOf['wh-1']?.find((item) => item.id === 'del-3')?.status).toBe(
      'pending',
    );
  });

  it('tells when there are no deliveries, when loading fails and when a retry fails', async () => {
    const { api, integrations } = withFake({ endpoints: [demoEndpoint()], deliveries });
    await renderWithSession(<IntegrationsScreen />, { api });
    integrations.failNext('deliveries', 500);
    const open = await screen.findByRole('button', { name: `Entregas ${URL}` });
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar$/ }));
    await screen.findByRole('table', { name: 'Entregas' });
    integrations.failNext('retry', 500);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar Siniestro cerrado' }));
    expect(await screen.findByText('No se pudieron cargar las entregas.')).toBeInTheDocument();
    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Entregas' })).toBeNull());
  });

  it('shows an empty history', async () => {
    const { api } = withFake({ endpoints: [demoEndpoint()] });
    await renderWithSession(<IntegrationsScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: `Entregas ${URL}` }));
    expect(await screen.findByText('Todavía no hay entregas.')).toBeInTheDocument();
  });
});

describe('error codes', () => {
  it('explains each code and never echoes an unknown one', () => {
    expect(errorLabel(null)).toBe('');
    expect(errorLabel('http_503')).toBe('El receptor respondió con error 503');
    expect(errorLabel('tls')).toMatch(/segura/);
    expect(errorLabel('<script>')).toBe('Falla desconocida');
  });
});

describe('BFF ports', () => {
  it('maps each operation to its route with params, query and body', async () => {
    const calls: { id: string; input: unknown }[] = [];
    const client = {
      call: async (id: string, input?: unknown) => {
        calls.push({ id, input });
        return { ok: true as const, value: undefined };
      },
    } as unknown as Parameters<typeof createIntegrationsPorts>[0];
    const ports = createIntegrationsPorts(client);
    await ports.list();
    await ports.create({ url: URL, events: ['vehicle.created'] });
    await ports.update('e1', { version: 1, active: false });
    await ports.remove('e1');
    await ports.rotate('e1', 2);
    await ports.test('e1');
    await ports.deliveries('e1');
    await ports.deliveries('e1', { limit: 5 });
    await ports.retry('e1', 'd1');
    expect(calls.map((call) => call.id)).toEqual([
      'webhooks.list',
      'webhooks.create',
      'webhooks.update',
      'webhooks.delete',
      'webhooks.rotate',
      'webhooks.test',
      'webhooks.deliveries',
      'webhooks.deliveries',
      'webhooks.retry',
    ]);
    expect(calls[4]?.input).toEqual({ params: { endpointId: 'e1' }, body: { version: 2 } });
    expect(calls[6]?.input).toEqual({ params: { endpointId: 'e1' } });
    expect(calls[7]?.input).toEqual({ params: { endpointId: 'e1' }, query: { limit: 5 } });
    expect(calls[8]?.input).toEqual({ params: { endpointId: 'e1', deliveryId: 'd1' } });
  });
});
