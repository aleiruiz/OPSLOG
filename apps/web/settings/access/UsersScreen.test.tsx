import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  getField,
  renderApp,
  renderWithSession,
  screen,
  type,
  waitFor,
} from '../../app/test/utils';
import { UsersScreen } from './UsersScreen';

describe('UsersScreen', () => {
  it('shows a loading state, then the users with labelled statuses and no permission codes', async () => {
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
    expect(table).toHaveTextContent('user-admin');
    expect(table).not.toHaveTextContent('@');
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
    type('Buscar por identificador, rol o estado', 'zzz');
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
    expect(screen.queryByRole('button', { name: 'Desactivar a user-admin' })).toBeNull();
    click('Desactivar a user-dispatch');
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo de la desactivación/ }), {
      target: { value: 'Ya no trabaja aquí' },
    });
    click('Confirmar');
    expect(await screen.findByText('La cuenta user-dispatch fue desactivada.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Desactivado').length).toBeGreaterThan(0));
    const list = await api.users.listUsers({ search: 'user-dispatch' });
    expect(list.ok && list.value.items[0]?.status).toBe('inactive');
  });

  it('can cancel a deactivation and reports server rejections', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('table');
    click('Desactivar a user-dispatch');
    click('Cancelar');
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
    click('Desactivar a user-dispatch');
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

  it('invites by role, shows the one-time link and clears the form and the server draft', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    click('Crear invitación');
    expect(await screen.findByText('Invitación creada.')).toBeInTheDocument();
    const link = (await screen.findByLabelText('Enlace de invitación')) as HTMLInputElement;
    expect(link.value).toMatch(/\/invitacion\/invitacion-emitida-\d+$/);
    await waitFor(() => expect(getField('Rol')).toHaveValue(''));
    expect(api.controls.storedDrafts()['invite-user']).toBeUndefined();
  });

  it('does not stay stuck when the invite call rejects, and drops the old token on a new invite', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    click('Crear invitación');
    await screen.findByLabelText('Enlace de invitación');
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    api.users.inviteUser = async () => {
      throw new Error('red');
    };
    click('Crear invitación');
    expect(
      await screen.findByText('No pudimos crear la invitación. Intenta nuevamente.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Enlace de invitación')).toBeNull();
    expect(screen.getByRole('button', { name: 'Crear invitación' })).toBeEnabled();
  });

  it('keeps the invitation when clearing the draft fails', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    api.drafts.discard = async () => {
      throw new Error('red');
    };
    click('Crear invitación');
    expect(await screen.findByLabelText('Enlace de invitación')).toBeInTheDocument();
  });

  it('forgets the one-time link when the session expires', async () => {
    const { api } = await renderApp({ path: '/configuracion/usuarios' });
    await screen.findByRole('form', { name: 'Invitar usuario' });
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    click('Crear invitación');
    await screen.findByLabelText('Enlace de invitación');
    api.controls.expireSession();
    type('Buscar por identificador, rol o estado', 'x');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    await waitFor(() => expect(screen.queryByLabelText('Enlace de invitación')).toBeNull());
  });

  it('asks for a role before inviting and reports a server failure without field detail', async () => {
    const { api } = await renderWithSession(<UsersScreen />);
    await screen.findByRole('form', { name: 'Invitar usuario' });
    click('Crear invitación');
    expect(await screen.findByText('Elige un rol de la lista.')).toBeInTheDocument();
    fireEvent.change(getField('Rol'), { target: { value: 'role-fleet' } });
    api.controls.failNext('inviteUser', 500);
    click('Crear invitación');
    expect(
      await screen.findByText('No pudimos crear la invitación. Intenta nuevamente.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Enlace de invitación')).toBeNull();
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
    type('Buscar por identificador, rol o estado', 'admin');
    await screen.findByRole('table', { name: 'Usuarios (1)' });
    await act(async () => gate.resolve());
    await act(async () => undefined);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByText('user-viewer')).toBeNull();
  });
});
