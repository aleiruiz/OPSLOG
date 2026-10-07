import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, demoSubjects } from '../app/mockApi';
import { click, fireEvent, renderApp, screen, type, waitFor, within } from '../app/test/utils';
import type { ApiError, AlertSettings, Result } from '../app/types';
import { describeFailure } from './AlertSettingsScreen';

const apiError = (status: ApiError['status'], code: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
});
const fail = (status: ApiError['status'], code: string): Result<AlertSettings> => ({
  ok: false,
  error: apiError(status, code),
});

const role = (name: string) => screen.getByRole('checkbox', { name });
const toggle = (name: string) => fireEvent.click(role(name));

async function open(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await renderApp({ path: '/configuracion/alertas', ...options });
  await screen.findByRole('heading', { name: 'Ajustes de alertas', level: 1 });
  return view;
}
async function openForm(options: Parameters<typeof renderApp>[0] = {}) {
  const view = await open(options);
  await screen.findByRole('form', { name: 'Ajustes de alertas' });
  return view;
}

describe('alert settings: editing with manage_config', () => {
  it('shows the defaults of a company that never saved, with the recipients checked', async () => {
    await openForm();
    expect(screen.getByLabelText(/^Días de anticipación/)).toHaveValue(30);
    expect(role('Administración de la empresa')).toBeChecked();
    expect(role('Responsable de flotilla')).toBeChecked();
    for (const name of ['Consulta', 'Auditoría', 'Lectura de datos personales'])
      expect(role(name)).not.toBeChecked();
    expect(
      screen.getByText('Aún no se han guardado ajustes: se usan los valores por defecto.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/todavía no se envía ningún aviso/)).toBeInTheDocument();
  });

  it('saves a full replacement with the version of the last read, then the next save carries the new version', async () => {
    const api = createMockApi();
    const save = vi.spyOn(api.alerts, 'saveSettings');
    await openForm({ api });
    type('Días de anticipación', '7');
    toggle('Consulta');
    click('Guardar ajustes');
    expect(await screen.findByText('Ajustes guardados.')).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith({
      version: 0,
      expiryWindowDays: 7,
      recipientRoles: ['admin', 'editor', 'viewer'],
    });
    expect(screen.getByText(/^Última actualización: /)).toBeInTheDocument();
    expect(screen.queryByText(/Aún no se han guardado/)).toBeNull();
    type('Días de anticipación', '14');
    expect(screen.queryByText('Ajustes guardados.')).toBeNull();
    click('Guardar ajustes');
    await screen.findByText('Ajustes guardados.');
    expect(save).toHaveBeenLastCalledWith({
      version: 1,
      expiryWindowDays: 14,
      recipientRoles: ['admin', 'editor', 'viewer'],
    });
    expect(api.controls.alertSettings()).toMatchObject({ expiryWindowDays: 14, version: 2 });
  });

  it('locks the settings fields until an in-flight save finishes', async () => {
    const api = createMockApi();
    let resolveSave!: (result: Result<AlertSettings>) => void;
    const pendingSave = new Promise<Result<AlertSettings>>((resolve) => {
      resolveSave = resolve;
    });
    const save = vi.spyOn(api.alerts, 'saveSettings').mockReturnValue(pendingSave);
    await openForm({ api });

    type('Días de anticipación', '7');
    toggle('Consulta');
    click('Guardar ajustes');

    const expiryWindow = screen.getByLabelText(/^Días de anticipación/);
    await waitFor(() => {
      expect(expiryWindow).toBeDisabled();
      expect(role('Consulta')).toBeDisabled();
    });
    expect(save).toHaveBeenCalledWith({
      version: 0,
      expiryWindowDays: 7,
      recipientRoles: ['admin', 'editor', 'viewer'],
    });

    resolveSave({
      ok: true,
      value: {
        ...api.controls.alertSettings(),
        expiryWindowDays: 7,
        recipientRoles: ['admin', 'editor', 'viewer'],
        version: 1,
        updatedBy: 'user-admin',
        updatedAt: '2026-10-07T12:00:00.000Z',
      },
    });

    expect(await screen.findByText('Ajustes guardados.')).toBeInTheDocument();
    expect(expiryWindow).toHaveValue(7);
    expect(role('Consulta')).toBeChecked();
    expect(expiryWindow).toBeEnabled();
    expect(role('Consulta')).toBeEnabled();
  });

  it('keeps the recipients in the canonical order whatever order they were checked in', async () => {
    const api = createMockApi();
    const save = vi.spyOn(api.alerts, 'saveSettings');
    await openForm({ api });
    toggle('Lectura de datos personales');
    toggle('Auditoría');
    toggle('Administración de la empresa');
    click('Guardar ajustes');
    await screen.findByText('Ajustes guardados.');
    expect(save).toHaveBeenLastCalledWith({
      version: 0,
      expiryWindowDays: 30,
      recipientRoles: ['editor', 'auditor', 'pii_reader'],
    });
  });

  it('explains an invalid window and an empty recipient list, focuses the first one and does not call the API', async () => {
    const api = createMockApi();
    const save = vi.spyOn(api.alerts, 'saveSettings');
    await openForm({ api });
    type('Días de anticipación', '45');
    toggle('Administración de la empresa');
    toggle('Responsable de flotilla');
    click('Guardar ajustes');
    expect(await screen.findByText('Escribe un número entero entre 1 y 30.')).toBeInTheDocument();
    expect(screen.getByText('Elige al menos un rol que reciba las alertas.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Días de anticipación/)).toHaveFocus();
    expect(screen.getByLabelText(/^Días de anticipación/)).toHaveAttribute('aria-invalid', 'true');
    expect(role('Administración de la empresa')).toHaveAttribute('aria-invalid', 'true');
    // Correcting a field clears its message.
    type('Días de anticipación', '10');
    expect(screen.queryByText('Escribe un número entero entre 1 y 30.')).toBeNull();
    click('Guardar ajustes');
    expect(screen.getByText('Elige al menos un rol que reciba las alertas.')).toBeInTheDocument();
    expect(role('Administración de la empresa')).toHaveFocus();
    toggle('Consulta');
    expect(screen.queryByText('Elige al menos un rol que reciba las alertas.')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('says there is nothing to save when nothing changed', async () => {
    const api = createMockApi();
    const save = vi.spyOn(api.alerts, 'saveSettings');
    await openForm({ api });
    click('Guardar ajustes');
    expect(await screen.findByText('No hay cambios que guardar.')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('tells the person when someone else saved first, and loads the current data on request', async () => {
    const { api } = await openForm();
    api.controls.changeAlertSettingsExternally({ expiryWindowDays: 21 });
    type('Días de anticipación', '7');
    click('Guardar ajustes');
    expect(
      await screen.findByRole('heading', { name: 'Otra persona cambió los ajustes' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tus cambios no se guardaron/)).toBeInTheDocument();
    expect(api.controls.alertSettings().expiryWindowDays).toBe(21);
    click('Cargar datos actuales');
    await waitFor(() => expect(screen.getByLabelText(/^Días de anticipación/)).toHaveValue(21));
    expect(screen.queryByRole('heading', { name: 'Otra persona cambió los ajustes' })).toBeNull();
    type('Días de anticipación', '7');
    click('Guardar ajustes');
    await screen.findByText('Ajustes guardados.');
    expect(api.controls.alertSettings()).toMatchObject({ expiryWindowDays: 7, version: 2 });
  });

  it.each([
    [400, 'bad_request', 'El servidor rechazó los datos'],
    [403, 'forbidden', 'No tienes permiso'],
    [500, 'internal_error', 'No pudimos guardar los ajustes'],
  ] as const)('shows a %s answer as "%s" and keeps what was typed', async (status, code, title) => {
    const api = createMockApi();
    api.alerts.saveSettings = async () => fail(status, code);
    await openForm({ api });
    type('Días de anticipación', '9');
    click('Guardar ajustes');
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Días de anticipación/)).toHaveValue(9);
  });

  it('keeps unsaved edits through an expired session, unless the settings changed meanwhile', async () => {
    const { api } = await openForm();
    type('Días de anticipación', '12');
    api.controls.expireSession();
    click('Guardar ajustes');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() => expect(screen.getByLabelText(/^Días de anticipación/)).toHaveValue(12));
    expect(screen.queryByText(/Los ajustes cambiaron desde que empezaste/)).toBeNull();
    api.controls.expireSession();
    click('Guardar ajustes');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    api.controls.changeAlertSettingsExternally({ expiryWindowDays: 21 });
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    expect(
      await screen.findByText(/Los ajustes cambiaron desde que empezaste/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Días de anticipación/)).toHaveValue(21);
  });

  it('retries a failed load, and shows a 403 as no permission', async () => {
    const api = createMockApi();
    api.controls.failNext('getAlertSettings');
    await open({ api });
    expect(
      await screen.findByRole('heading', { name: 'No pudimos cargar la información' }),
    ).toBeInTheDocument();
    click('Reintentar');
    await screen.findByRole('form', { name: 'Ajustes de alertas' });
    const forbidden = createMockApi();
    forbidden.controls.failNext('getAlertSettings', 403);
    await open({ api: forbidden });
    expect(await screen.findByRole('heading', { name: 'No tienes acceso' })).toBeInTheDocument();
  });

  it('is reached from the navigation under "Configuración" and highlights it', async () => {
    await renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    within(nav).getByRole('link', { name: 'Ajustes de alertas' }).click();
    await screen.findByRole('heading', { name: 'Ajustes de alertas', level: 1 });
    expect(
      within(screen.getByRole('navigation', { name: 'Principal' })).getByRole('link', {
        name: 'Ajustes de alertas',
      }),
    ).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Ajustes de alertas · Transportes Demo SA · OPSLOG');
  });
});

describe('alert settings: read-only without manage_config', () => {
  it.each(['viewer', 'dispatch', 'mechanic'] as const)(
    'shows the window and the recipients without a form to %s',
    async (account) => {
      await open({ account });
      const values = await screen.findByLabelText('Ajustes de alertas', { selector: 'dl' });
      expect(values).toHaveTextContent('30 días');
      expect(values).toHaveTextContent('Administración de la empresa, Responsable de flotilla');
      expect(screen.queryByRole('form', { name: 'Ajustes de alertas' })).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Guardar ajustes' })).toBeNull();
      expect(
        screen.getByText(/Solo quien administra la configuración de la empresa puede cambiar/),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Ver alertas' })).toHaveAttribute(
        'href',
        '/flota/alertas',
      );
    },
  );

  it('shows what was saved, singular days and the last update', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    await api.alerts.saveSettings({ version: 0, expiryWindowDays: 1, recipientRoles: ['auditor'] });
    await open({ api, account: 'viewer' });
    const values = await screen.findByLabelText('Ajustes de alertas', { selector: 'dl' });
    expect(values).toHaveTextContent('1 día');
    expect(values).toHaveTextContent('Auditoría');
    expect(screen.getByText(/^Última actualización: /)).toBeInTheDocument();
  });

  it('never sends a save (the server would answer 403 anyway)', async () => {
    const api = createMockApi();
    const save = vi.spyOn(api.alerts, 'saveSettings');
    await open({ api, account: 'viewer' });
    await screen.findByLabelText('Ajustes de alertas', { selector: 'dl' });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('describeFailure', () => {
  it('maps every failure to a message, and a 401 to none (the session panel takes over)', () => {
    expect(describeFailure(apiError(401, 'unauthorized'))).toBeNull();
    expect(describeFailure(apiError(409, 'stale_version'))).toMatchObject({
      title: 'Otra persona cambió los ajustes',
      actionLabel: 'Cargar datos actuales',
    });
    expect(describeFailure(apiError(400, 'bad_request'))?.title).toBe(
      'El servidor rechazó los datos',
    );
    expect(describeFailure(apiError(403, 'forbidden'))?.message).toMatch(
      /administrar la configuración/,
    );
    expect(describeFailure(apiError(500, 'internal_error'))?.title).toBe(
      'No pudimos guardar los ajustes',
    );
  });
});
