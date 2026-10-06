import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, demoInvitations } from './mockApi';
import { fireEvent } from '@testing-library/react';
import { click, findField, getField, renderApp, screen, type, waitFor } from './test/utils';

const strongPassword = 'una-contraseña-larga-123';

describe('shell: session, company and user', () => {
  it('shows a loading state while the session is being resolved', async () => {
    const api = createMockApi();
    let release: (value: Awaited<ReturnType<typeof api.auth.getSession>>) => void = () => undefined;
    api.auth.getSession = () => new Promise((resolve) => (release = resolve));
    await renderApp({ api, account: 'admin' });
    expect(screen.getByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () =>
      release({ ok: false, error: { code: 'x', status: 401, message: 'x', correlationId: 'c' } }),
    );
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
  });

  it('redirects an anonymous visitor to login and remembers the requested route', async () => {
    await renderApp({ account: null, path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
    expect(window.location.pathname).toBe('/iniciar-sesion');
    expect(window.location.search).toBe('?siguiente=%2Fconfiguracion%2Fusuarios');
  });

  it('logs in, returns to the requested route and shows company and user in the shell', async () => {
    await renderApp({ account: null, path: '/configuracion/usuarios' });
    await findField('Correo electrónico');
    type('Correo electrónico', demoCredentials.admin.email);
    type('Contraseña', demoCredentials.admin.password);
    click('Iniciar sesión');
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    expect(screen.getByTestId('shell-company')).toHaveTextContent('Transportes Demo SA');
    expect(screen.getByTestId('shell-user')).toHaveTextContent(
      'Ana Prueba · Administrador de empresa',
    );
    expect(window.location.pathname).toBe('/configuracion/usuarios');
    expect(document.title).toBe('Usuarios · Transportes Demo SA · OPSLOG');
  });

  it('shows incomplete and rejected login states without revealing which field failed', async () => {
    await renderApp({ account: null });
    await findField('Correo electrónico');
    click('Iniciar sesión');
    expect(
      await screen.findByText('Escribe tu correo y tu contraseña para continuar.'),
    ).toBeVisible();
    type('Correo electrónico', demoCredentials.admin.email);
    type('Contraseña', 'incorrecta');
    click('Iniciar sesión');
    expect(await screen.findByText('El correo o la contraseña no son correctos.')).toBeVisible();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows an unavailable state when login fails for a non-credential reason', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null });
    await findField('Correo electrónico');
    api.controls.failNext('login', 500);
    type('Correo electrónico', demoCredentials.admin.email);
    type('Contraseña', demoCredentials.admin.password);
    click('Iniciar sesión');
    expect(await screen.findByText('Servicio no disponible')).toBeVisible();
  });

  it('ignores an unsafe post-login destination', async () => {
    await renderApp({ account: null, path: '/iniciar-sesion?siguiente=//evil.example' });
    await findField('Correo electrónico');
    type('Correo electrónico', demoCredentials.admin.email);
    type('Contraseña', demoCredentials.admin.password);
    click('Iniciar sesión');
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(window.location.pathname).toBe('/');
  });

  it('redirects a signed-in person away from the login route', async () => {
    await renderApp({ path: '/iniciar-sesion' });
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(window.location.pathname).toBe('/');
  });

  it('shows a recoverable error when the session cannot be resolved, then recovers', async () => {
    const api = createMockApi();
    await api.auth.login(demoCredentials.admin);
    api.controls.failNext('getSession', 500);
    await renderApp({ api, account: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
  });

  it('signs out and returns to login', async () => {
    const { api } = await renderApp();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    click('Cerrar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
    expect(api.controls.isSignedIn()).toBe(false);
  });

  it('keeps going to login even when the sign-out call fails', async () => {
    const { api } = await renderApp();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    api.controls.failNext('logout');
    click('Cerrar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
  });
});

describe('routes respect permissions', () => {
  it('shows the full configuration menu to an administrator', async () => {
    await renderApp();
    const nav = await screen.findByRole('navigation', { name: 'Principal' });
    for (const label of ['Inicio', 'Empresa', 'Usuarios', 'Roles'])
      expect(nav).toHaveTextContent(label);
  });

  it('hides restricted entries and blocks their routes for a read-only role', async () => {
    await renderApp({ account: 'viewer', path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(nav).toHaveTextContent('Inicio');
    expect(nav).not.toHaveTextContent('Usuarios');
    expect(nav).not.toHaveTextContent('Configuración');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('does not call the restricted API for a role without permission', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.users, 'listUsers');
    await renderApp({ api, account: 'viewer', path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'No tienes acceso' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows a not-found state for unknown routes', async () => {
    await renderApp({ path: '/no-existe' });
    await screen.findByRole('heading', { name: 'Página no encontrada' });
  });

  it('navigates with links without reloading and respects modified clicks', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Roles' });
    expect(link).toHaveAttribute('href', '/configuracion/roles');
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe('/');
    link.click();
    await screen.findByRole('heading', { name: 'Roles', level: 1 });
    expect(window.location.pathname).toBe('/configuracion/roles');
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(document.getElementById('contenido')).toHaveFocus());
  });

  it('reacts to browser back navigation', async () => {
    await renderApp();
    (await screen.findByRole('link', { name: 'Empresa' })).click();
    await screen.findByRole('heading', { name: 'Empresa', level: 1 });
    act(() => {
      window.history.replaceState(null, '', '/configuracion/roles');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Roles', level: 1 });
  });

  it('supports a base path', async () => {
    await renderApp({ basename: '/web', path: '/configuracion/roles' });
    await screen.findByRole('heading', { name: 'Roles', level: 1 });
    expect(screen.getByRole('link', { name: 'Usuarios' })).toHaveAttribute(
      'href',
      '/web/configuracion/usuarios',
    );
  });

  it('shows the home next steps according to permissions', async () => {
    await renderApp({ account: 'viewer' });
    await screen.findByText('Tu rol permite consultar información. Pronto verás aquí tus módulos.');
  });
});

describe('invitation acceptance', () => {
  const path = `/invitacion/${demoInvitations.valid}`;

  it('activates the account and enters the shell', async () => {
    await renderApp({ account: null, path });
    await screen.findByText(
      'Te invitaron a Transportes Demo SA con el rol Responsable de flotilla.',
    );
    type('Nombre completo', 'Nueva Persona');
    type('Contraseña', strongPassword);
    type('Confirma la contraseña', strongPassword);
    click('Activar cuenta');
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(screen.getByTestId('shell-user')).toHaveTextContent('Nueva Persona');
  });

  it('validates the form before calling the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.auth, 'acceptInvitation');
    await renderApp({ api, account: null, path });
    await findField('Nombre completo');
    type('Contraseña', 'corta');
    type('Confirma la contraseña', 'otra');
    click('Activar cuenta');
    expect(await screen.findByText('Escribe tu nombre.')).toBeVisible();
    expect(screen.getByText('Usa al menos 12 caracteres.')).toBeVisible();
    expect(screen.getByText('Las contraseñas no coinciden.')).toBeVisible();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows server field errors when the server rejects the password', async () => {
    const api = createMockApi();
    api.auth.acceptInvitation = async () => ({
      ok: false,
      error: {
        code: 'weak_password',
        status: 422,
        message: 'x',
        correlationId: 'c',
        fieldErrors: [
          { field: 'password', code: 'compromised', message: 'Elige otra contraseña.' },
        ],
      },
    });
    await renderApp({ api, account: null, path });
    await findField('Nombre completo');
    type('Nombre completo', 'Nueva Persona');
    type('Contraseña', strongPassword);
    type('Confirma la contraseña', strongPassword);
    click('Activar cuenta');
    expect(await screen.findByText('Elige otra contraseña.')).toBeVisible();
    expect(screen.getByText('No pudimos activar tu cuenta')).toBeVisible();
  });

  it('shows the same unavailable message for unknown and expired links', async () => {
    const texts: string[] = [];
    for (const token of ['token-inexistente', 'invitacion-vencida']) {
      const { unmount } = await renderApp({ account: null, path: `/invitacion/${token}` });
      await screen.findByRole('heading', { name: 'Invitación no disponible' });
      texts.push(document.body.textContent ?? '');
      unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(demoInvitations.expired).toBe('invitacion-vencida');
  });

  it('offers a way back to login from an unavailable invitation', async () => {
    await renderApp({ account: null, path: '/invitacion/otro' });
    await screen.findByRole('heading', { name: 'Invitación no disponible' });
    click('Ir a iniciar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
  });

  it('handles a recoverable error while checking the invitation', async () => {
    const api = createMockApi();
    api.controls.failNext('inspectInvitation', 500);
    await renderApp({ api, account: null, path });
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await findField('Nombre completo');
  });

  it('turns an invitation consumed in the meantime into the unavailable state', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null, path });
    await findField('Nombre completo');
    api.auth.acceptInvitation = async () => ({
      ok: false,
      error: { code: 'invitation_unavailable', status: 404, message: 'x', correlationId: 'c' },
    });
    type('Nombre completo', 'Nueva Persona');
    type('Contraseña', strongPassword);
    type('Confirma la contraseña', strongPassword);
    click('Activar cuenta');
    await screen.findByRole('heading', { name: 'Invitación no disponible' });
  });

  it('is reachable while signed in', async () => {
    await renderApp({ path });
    await findField('Nombre completo');
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument();
  });
});

describe('expired session', () => {
  it('keeps the screen, restores the server draft and resumes after signing in again', async () => {
    const { api } = await renderApp({ path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    await findField('Correo de la persona');
    type('Correo de la persona', 'nueva@demo.opslog.test');
    await waitFor(() => expect(api.controls.storedDrafts()['invite-user']).toBeDefined(), {
      timeout: 2000,
    });

    api.controls.expireSession();
    type('Correo de la persona', 'nueva2@demo.opslog.test');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.getByRole('group', { name: 'Sesión expirada' })).toHaveFocus();
    expect(screen.getByText(/Mantenemos estos cambios en esta pantalla/)).toBeInTheDocument();
    // The screen below the panel is inert while the session is expired.
    expect(getField('Correo de la persona').closest('[inert]')).not.toBeNull();

    type('Contraseña', demoCredentials.admin.password);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(getField('Correo de la persona')).toHaveValue('nueva2@demo.opslog.test');
    await waitFor(() =>
      expect(api.controls.storedDrafts()['invite-user']).toMatchObject({
        email: 'nueva2@demo.opslog.test',
      }),
    );
  });

  it('expires the session when an API call answers 401 and reloads the data after signing in again', async () => {
    const { api } = await renderApp({ path: '/configuracion/usuarios' });
    await screen.findByRole('table', { name: /Usuarios/ });
    api.controls.expireSession();
    type('Buscar por nombre o correo', 'Prueba');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(
      await screen.findByRole('heading', { name: 'Datos no disponibles' }),
    ).toBeInTheDocument();
    type('Contraseña', demoCredentials.admin.password);
    click('Continuar');
    const table = await screen.findByRole('table', { name: 'Usuarios (1)' });
    expect(table).toHaveTextContent('Ana Prueba');
  });

  it('shows the panel with the previous screen and signs in again with the same account', async () => {
    const { api } = await renderApp({ path: '/configuracion/empresa' });
    await findField('Nombre de la empresa');
    api.controls.expireSession();
    type('Nombre de la empresa', 'Otra razón social');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Contraseña', 'incorrecta');
    click('Continuar');
    expect(
      await screen.findByText('La contraseña no es correcta o el servicio no está disponible.'),
    ).toBeVisible();
    type('Contraseña', demoCredentials.admin.password);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    await waitFor(() =>
      expect(api.controls.storedDrafts()['company-settings']).toMatchObject({
        name: 'Otra razón social',
      }),
    );
  });
});
