import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import { click, fireEvent, renderWithSession, screen, type, waitFor } from '../../app/test/utils';
import { RolesScreen } from './RolesScreen';

describe('RolesScreen', () => {
  it('lists the seven system templates as read-only and the permissions in plain Spanish', async () => {
    const slow = createMockApi();
    const real = slow.roles.listRoles;
    let release: () => void = () => undefined;
    slow.roles.listRoles = () => new Promise((resolve) => (release = () => resolve(real())));
    await renderWithSession(<RolesScreen />, { api: slow });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => release());
    const table = await screen.findByRole('table', { name: 'Roles de la empresa' });
    expect(table).toHaveTextContent('Administrador de empresa');
    expect(table).toHaveTextContent('Despachador');
    expect(screen.getAllByText('Plantilla del sistema')).toHaveLength(7);
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
