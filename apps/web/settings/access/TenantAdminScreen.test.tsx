import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../app/mockApi';
import {
  click,
  fireEvent,
  getField,
  renderWithSession,
  screen,
  type,
  waitFor,
} from '../../app/test/utils';
import { TenantAdminScreen } from './TenantAdminScreen';

describe('TenantAdminScreen', () => {
  it('loads the company settings with the status label', async () => {
    const slow = createMockApi();
    const real = slow.tenant.getCompanySettings;
    let release: () => void = () => undefined;
    slow.tenant.getCompanySettings = () =>
      new Promise((resolve) => (release = () => resolve(real())));
    await renderWithSession(<TenantAdminScreen />, { api: slow });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByDisplayValue('Transportes Demo SA')).toBeInTheDocument();
    expect(screen.getByLabelText(/Estado: Activa/)).toBeInTheDocument();
    expect(getField('Cierre de sesión por inactividad')).toHaveValue(8);
  });

  it('saves a non-security change directly, then clears the draft', async () => {
    const { api } = await renderWithSession(<TenantAdminScreen />);
    await screen.findByDisplayValue('Transportes Demo SA');
    type('Nombre de la empresa', 'Transportes Nuevos SA');
    click('Guardar cambios');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(api.controls.storedDrafts()['company-settings']).toBeUndefined();
    expect(getField('Nombre de la empresa')).toHaveValue('Transportes Nuevos SA');
  });

  it('asks for a reason before saving a security change and can cancel', async () => {
    const { api } = await renderWithSession(<TenantAdminScreen />);
    await screen.findByDisplayValue('Transportes Demo SA');
    fireEvent.change(getField('Verificación en dos pasos'), { target: { value: 'required' } });
    click('Guardar cambios');
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    click('Cancelar');
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeInTheDocument();
    click('Guardar cambios');
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo del cambio/ }), {
      target: { value: 'Política interna' },
    });
    click('Confirmar');
    expect(await screen.findByText('Cambios guardados.')).toBeInTheDocument();
    const settings = await api.tenant.getCompanySettings();
    expect(settings.ok && settings.value.mfa).toBe('required');
  });

  it('shows field errors from the server', async () => {
    await renderWithSession(<TenantAdminScreen />);
    await screen.findByDisplayValue('Transportes Demo SA');
    type('Nombre de la empresa', ' ');
    click('Guardar cambios');
    expect(await screen.findByText('Escribe el nombre.')).toBeInTheDocument();
    expect(screen.getByText('No pudimos guardar los cambios')).toBeInTheDocument();
  });

  it('keeps the form and shows the expired state when saving gets a 401', async () => {
    const { api } = await renderWithSession(<TenantAdminScreen />);
    await screen.findByDisplayValue('Transportes Demo SA');
    type('Nombre de la empresa', 'Cambio');
    api.controls.expireSession();
    click('Guardar cambios');
    await waitFor(() => expect(screen.getByText('Sesión expirada')).toBeInTheDocument());
    expect(getField('Nombre de la empresa')).toHaveValue('Cambio');
  });

  it('shows error and forbidden states', async () => {
    const api = createMockApi();
    api.controls.failNext('getCompanySettings');
    const first = await renderWithSession(<TenantAdminScreen />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByDisplayValue('Transportes Demo SA');
    first.unmount();
    await renderWithSession(<TenantAdminScreen />, { account: 'viewer' });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });
});
