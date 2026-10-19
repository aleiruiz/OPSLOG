import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
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
import { createFakeNotifications, type FakeNotifications } from './fakePorts';
import { FollowButton } from './FollowButton';
import { NotificationsScreen } from './NotificationsScreen';
import { PreferencesScreen } from './PreferencesScreen';

const withFake = (options: Parameters<typeof createFakeNotifications>[0] = {}) => {
  const notifications = createFakeNotifications(options);
  return { notifications, api: Object.assign(createMockApi(), { notifications }) };
};
const names = (fake: FakeNotifications) => fake.calls.map((call) => call.name);

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'heading-order': { enabled: false } },
  });
  return results.violations.map((item) => item.id);
}

describe('bell', () => {
  it('names the unread count for assistive technology and opens the center', async () => {
    const { api } = withFake();
    await renderApp({ api, path: '/' });
    const bell = await screen.findByRole('link', { name: 'Notificaciones, 2 sin leer' });
    expect(bell).toHaveAttribute('href', '/notificaciones');
    fireEvent.click(bell);
    expect(
      await screen.findByRole('heading', { name: 'Notificaciones', level: 1 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/notificaciones');
  });

  it('shows no number when everything is read and refreshes after reading', async () => {
    const { api, notifications } = withFake();
    await renderApp({ api, path: '/notificaciones' });
    await screen.findByRole('heading', { name: 'Hoy' });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como leídas' }));
    await waitFor(() => expect(notifications.items.every((n) => n.readAt !== null)).toBe(true));
    fireEvent.click(screen.getByRole('link', { name: 'Preferencias' }));
    expect(
      await screen.findByRole('link', { name: 'Notificaciones, sin avisos nuevos' }),
    ).toBeInTheDocument();
  });

  it('keeps working when the count fails', async () => {
    const { api, notifications } = withFake();
    notifications.failNext('count', 500);
    await renderApp({ api, path: '/' });
    expect(
      await screen.findByRole('link', { name: 'Notificaciones, sin avisos nuevos' }),
    ).toBeInTheDocument();
  });
});

describe('center', () => {
  it('groups by day, marks one as read and is accessible', async () => {
    const { api, notifications } = withFake();
    const { container } = await renderWithSession(<NotificationsScreen today="2026-10-19" />, {
      api,
    });
    expect(await screen.findByRole('heading', { name: 'Hoy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ayer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /SIN-0001/ })).toHaveAttribute(
      'href',
      '/incidents/inc-1',
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /Marcar como leída: La verificación del vehículo ECO-001/,
      }),
    );
    await waitFor(() => expect(notifications.items[1]?.readAt).not.toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('filters by unread and by kind, and shows empty and error states', async () => {
    const { api, notifications } = withFake();
    await renderWithSession(<NotificationsScreen today="2026-10-19" />, { api });
    await screen.findByRole('heading', { name: 'Hoy' });
    fireEvent.click(screen.getByLabelText('Solo sin leer'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ayer' })).toBeNull());
    fireEvent.change(screen.getByLabelText('Tipo de aviso'), {
      target: { value: 'export_failed' },
    });
    expect(await screen.findByText('No tienes notificaciones sin leer.')).toBeInTheDocument();
    notifications.failNext('list', 500);
    fireEvent.change(screen.getByLabelText('Tipo de aviso'), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: /Reintentar/ }));
    expect(await screen.findByRole('heading', { name: 'Hoy' })).toBeInTheDocument();
  });

  it('pages with «Ver más» and tells when marking fails', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m-${i}`,
      eventKind: 'document_expiring' as const,
      entityType: 'vehicle' as const,
      entityId: 'veh-1',
      title: `Aviso ${i}`,
      link: '/flota/vehiculos/veh-1',
      severity: 'info' as const,
      createdAt: '2026-10-19T10:00:00.000Z',
      readAt: null,
    }));
    const { api, notifications } = withFake({ items: many });
    await renderWithSession(<NotificationsScreen today="2026-10-19" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Ver más' }));
    await screen.findByText('Aviso 29');
    expect(screen.queryByRole('button', { name: 'Ver más' })).toBeNull();
    notifications.failNext('markRead', 500);
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como leída: Aviso 0' }));
    expect(await screen.findByText('No pudimos cargar tus notificaciones.')).toBeInTheDocument();
  });
});

describe('preferences', () => {
  it('fixes the mandatory kinds, saves a choice and is accessible', async () => {
    const { api, notifications } = withFake();
    const { container } = await renderWithSession(<PreferencesScreen />, { api });
    const table = await screen.findByRole('table', { name: /Preferencias por tipo/ });
    expect(within(table).getByLabelText('En la aplicación: Exportación lista')).toBeDisabled();
    expect(screen.getAllByText(/Es obligatorio/).length).toBeGreaterThan(0);
    fireEvent.click(within(table).getByLabelText('En la aplicación: Documento por vencer'));
    click('Guardar preferencias');
    expect(await screen.findByText('Preferencias guardadas.')).toBeInTheDocument();
    expect(names(notifications)).toContain('savePreferences');
    expect(await violations(container)).toEqual([]);
  });

  it('shows the company panel only to who manages the configuration and saves its rules', async () => {
    const { api, notifications } = withFake();
    await renderWithSession(<PreferencesScreen />, { api });
    fireEvent.click(
      await screen.findByLabelText('Horario de silencio (22:00 a 07:00) para el correo'),
    );
    click('Guardar reglas');
    expect(await screen.findByText('Reglas guardadas.')).toBeInTheDocument();
    expect(notifications.rules.quietHours).toBe(true);
    expect(screen.getByText('No hay envíos fallidos.')).toBeInTheDocument();
  });

  it('hides the panel from a reader and reports a failed save', async () => {
    const { api, notifications } = withFake();
    await renderWithSession(<PreferencesScreen />, { api, account: 'viewer' });
    await screen.findByRole('table', { name: /Preferencias por tipo/ });
    expect(screen.queryByText('Reglas de la empresa')).toBeNull();
    notifications.failNext('savePreferences', 500);
    click('Guardar preferencias');
    expect(await screen.findByText(/No pudimos guardar/)).toBeInTheDocument();
  });
});

describe('follow button', () => {
  it('follows and unfollows a record, and reports a failure', async () => {
    const { api, notifications } = withFake();
    await renderWithSession(<FollowButton type="vehicle" entityId="veh-1" />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Seguir' }));
    expect(await screen.findByRole('button', { name: 'Siguiendo' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(notifications.followed).toHaveLength(1);
    notifications.failNext('unsubscribe', 500);
    fireEvent.click(screen.getByRole('button', { name: 'Siguiendo' }));
    expect(await screen.findByText(/No pudimos cambiar el seguimiento/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiendo' }));
    await screen.findByRole('button', { name: 'Seguir' });
    expect(notifications.followed).toHaveLength(0);
  });
});
