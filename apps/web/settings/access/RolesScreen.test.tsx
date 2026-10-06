import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  deferred,
  fireEvent,
  renderWithSession,
  screen,
  type,
  waitFor,
} from '../../app/test/utils';
import { RolesScreen } from './RolesScreen';

describe('RolesScreen', () => {
  it('lists the eight system templates as read-only and the permissions in plain Spanish', async () => {
    const slow = createMockApi();
    const real = slow.roles.listRoles;
    const gate = deferred();
    slow.roles.listRoles = async () => {
      await gate.promise;
      return real();
    };
    await renderWithSession(<RolesScreen />, { api: slow });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => gate.resolve());
    const table = await screen.findByRole('table', { name: 'Roles de la empresa' });
    expect(table).toHaveTextContent('Administrador de empresa');
    expect(table).toHaveTextContent('Despachador');
    expect(screen.getAllByText('Plantilla del sistema')).toHaveLength(8);
    click('Ver Consulta');
    const list = await screen.findByRole('list', { name: 'Permisos de Consulta' });
    expect(list).toHaveTextContent('Consultar información');
    expect(list).not.toHaveTextContent('view');
  });

  it('creates a custom copy from the detail tab and shows it as custom', async () => {
    const { api } = await renderWithSession(<RolesScreen />);
    await screen.findByRole('table');
    click('Ver Consulta');
    fireTab('Crear copia');
    type('Nombre del nuevo rol', 'Auditor externo');
    click('Crear copia');
    expect(await screen.findByText('Rol "Auditor externo" creado.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Personalizado')).toBeInTheDocument());
    expect(api.controls.storedDrafts()['role-copy:role-viewer']).toBeUndefined();
  });

  it('shows the server error for a duplicated name', async () => {
    await renderWithSession(<RolesScreen />);
    await screen.findByRole('table');
    click('Ver Consulta');
    fireTab('Crear copia');
    type('Nombre del nuevo rol', 'Despachador');
    click('Crear copia');
    expect(await screen.findAllByText('Ya existe un rol con ese nombre.')).not.toHaveLength(0);
  });

  it('asks for a name and reports other server failures without field detail', async () => {
    const { api } = await renderWithSession(<RolesScreen />);
    await screen.findByRole('table');
    click('Ver Consulta');
    fireTab('Crear copia');
    click('Crear copia');
    expect(await screen.findByText('Escribe un nombre.')).toBeInTheDocument();
    type('Nombre del nuevo rol', 'Auditor externo');
    expect(screen.queryByText('Escribe un nombre.')).toBeNull();
    api.controls.failNext('copyRole', 500);
    click('Crear copia');
    expect(
      await screen.findByText('No pudimos crear la copia. Intenta nuevamente.'),
    ).toBeInTheDocument();
  });

  it('does not stay stuck when the copy call rejects or the draft cannot be cleared', async () => {
    const { api } = await renderWithSession(<RolesScreen />);
    await screen.findByRole('table');
    click('Ver Consulta');
    fireTab('Crear copia');
    type('Nombre del nuevo rol', 'Auditor externo');
    const real = api.roles.copyRole;
    api.roles.copyRole = async () => {
      throw new Error('red');
    };
    click('Crear copia');
    expect(
      await screen.findByText('No pudimos crear la copia. Intenta nuevamente.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Crear copia' })).toBeEnabled();
    api.roles.copyRole = real;
    api.drafts.discard = async () => {
      throw new Error('red');
    };
    click('Crear copia');
    expect(await screen.findByText('Rol "Auditor externo" creado.')).toBeInTheDocument();
  });

  it('shows an empty state, a recoverable error and the forbidden state', async () => {
    const empty = createMockApi();
    empty.roles.listRoles = async () => ({ ok: true, value: [] });
    const first = await renderWithSession(<RolesScreen />, { api: empty });
    expect(await screen.findByRole('heading', { name: 'Aún no hay roles' })).toBeInTheDocument();
    first.unmount();

    const failing = createMockApi();
    failing.controls.failNext('listRoles');
    const second = await renderWithSession(<RolesScreen />, { api: failing });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('table');
    second.unmount();

    await renderWithSession(<RolesScreen />, { account: 'viewer' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});

function fireTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}
