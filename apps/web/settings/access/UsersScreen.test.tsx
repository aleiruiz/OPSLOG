import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  getField,
  renderWithSession,
  screen,
  type,
  waitFor,
} from '../../app/test/utils';
import { UsersScreen } from './UsersScreen';

describe('UsersScreen', () => {
  it('shows a loading state, then the users with labelled statuses and no technical ids', async () => {
    const slow = createMockApi();
    const real = slow.users.listUsers;
    const gate = deferred();
    slow.users.listUsers = async (query) => {
      await gate.promise;
      return real(query);
    };
    await renderWithSession(<UsersScreen />, { api: slow });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => gate.resolve());
    const table = await screen.findByRole('table', { name: 'Usuarios (27)' });
    expect(table).toHaveTextContent('Ana Prueba');
    expect(table).toHaveTextContent('Administrador de empresa');
    expect(table).not.toHaveTextContent('manage_users');
    expect(table).toHaveTextContent('Activo');
  });

  it('loads further pages on request and keeps them until the filter changes', async () => {
    await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('row')).toHaveLength(26);
    click('Cargar más usuarios');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(28));
    expect(screen.queryByRole('button', { name: 'Cargar más usuarios' })).toBeNull();
  });

  it('reports an error when loading more fails', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    api.controls.failNext('listUsers');
    click('Cargar más usuarios');
    expect(await screen.findByText('No pudimos cargar más usuarios.')).toBeInTheDocument();
  });

  it('shows a no-results state for a search and the table again after clearing the filter', async () => {
    await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    type('Buscar por nombre o correo', 'zzz');
    expect(await screen.findByRole('heading', { name: 'Sin resultados' })).toBeInTheDocument();
    click('Limpiar filtros');
    await screen.findByRole('table', { name: 'Usuarios (27)' });
  });

  it('does not submit the search form when pressing Enter', async () => {
    await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    const form = screen.getByRole('search', { name: 'Filtros' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows an empty state when the directory returns no users', async () => {
    const api = createMockApi();
    const original = api.users.listUsers;
    api.users.listUsers = async (query) => {
      const result = await original(query);
      return result.ok
        ? { ok: true, value: { ...result.value, items: [], total: 0, nextCursor: null } }
        : result;
    };
    await renderWithSession(<UsersScreen />, { api });
    expect(await screen.findByRole('heading', { name: 'Aún no hay usuarios' })).toBeInTheDocument();
  });

  it('shows a recoverable error and retries', async () => {
    const api = createMockApi();
    api.controls.failNext('listUsers');
    await renderWithSession(<UsersScreen />, { api });
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar la información');
    click('Reintentar');
    await screen.findByRole('table');
  });

  it('shows the forbidden state when the server denies access', async () => {
    await renderWithSession(<UsersScreen />, { account: 'viewer' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('asks for a reason before deactivating, and cannot deactivate yourself', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Desactivar a Ana Prueba' })).toBeNull();
    click('Desactivar a Diana Despacho');
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo de la desactivación/ }), {
      target: { value: 'Ya no trabaja aquí' },
    });
    click('Confirmar');
    expect(await screen.findByText('Diana Despacho fue desactivado.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Desactivado').length).toBeGreaterThan(0));
    const list = await api.users.listUsers({ search: 'Diana' });
    expect(list.ok && list.value.items[0]?.status).toBe('inactive');
  });

  it('can cancel a deactivation and reports server rejections', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    click('Desactivar a Diana Despacho');
    click('Cancelar');
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
    click('Desactivar a Diana Despacho');
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo de la desactivación/ }), {
      target: { value: 'x' },
    });
    api.controls.failNext('deactivateUser', 422);
    click('Confirmar');
    expect(
      await screen.findByText('No pudimos desactivar a la persona. Intenta nuevamente.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/simulada/)).toBeNull();
  });

  it('invites a person, clears the form and the server draft', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    type('Correo de la persona', 'nuevo@demo.opslog.test');
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    click('Enviar invitación');
    expect(
      await screen.findByText('Invitación enviada a nuevo@demo.opslog.test.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(getField('Correo de la persona')).toHaveValue(''));
    expect(api.controls.storedDrafts()['invite-user']).toBeUndefined();
  });

  it('shows server field errors for an invalid invitation', async () => {
    await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    type('Correo de la persona', 'mal');
    click('Enviar invitación');
    expect(await screen.findByText('Escribe un correo válido.')).toBeInTheDocument();
    type('Correo de la persona', 'bien@demo.opslog.test');
    click('Enviar invitación');
    expect(await screen.findByText('Elige un rol de la lista.')).toBeInTheDocument();
  });

  it('ignores a further page that arrives after the search changed', async () => {
    const api = createMockApi();
    const real = api.users.listUsers;
    const gate = deferred();
    api.users.listUsers = async (query) => {
      if (query.cursor) await gate.promise;
      return real(query);
    };
    await renderWithSession(<UsersScreen />, { api });
    await screen.findByRole('table');
    click('Cargar más usuarios');
    type('Buscar por nombre o correo', 'Prueba');
    await screen.findByRole('table', { name: 'Usuarios (1)' });
    await act(async () => gate.resolve());
    await act(async () => undefined);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByText('Persona sintética 25')).toBeNull();
  });
});
