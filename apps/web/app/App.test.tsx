import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, demoInvitations, demoSubjects } from './mockApi';
import { fireEvent } from '@testing-library/react';
import {
  click,
  deferred,
  findField,
  getField,
  renderApp,
  screen,
  type,
  waitFor,
} from './test/utils';

const accept = () => {
  type('Cuenta de prueba', 'cuenta-nueva');
  click('Activar cuenta');
};

describe('shell: session, company and user', () => {
  it('shows a loading state while the session is being resolved', async () => {
    const api = createMockApi();
    const gate = deferred();
    api.auth.getSession = async () => {
      await gate.promise;
      return { ok: false, error: { code: 'x', status: 401, message: 'x', correlationId: 'c' } };
    };
    await renderApp({ api, account: 'admin' });
    expect(await screen.findByRole('heading', { name: 'Cargando' })).toBeInTheDocument();
    await act(async () => gate.resolve());
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
    await findField('Cuenta de prueba');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Iniciar sesión');
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    expect(screen.getByTestId('shell-company')).toHaveTextContent('Transportes Demo SA');
    expect(screen.getByTestId('shell-user')).toHaveTextContent('Administrador de empresa');
    expect(window.location.pathname).toBe('/configuracion/usuarios');
    expect(document.title).toBe('Usuarios · Transportes Demo SA · OPSLOG');
  });

  it('shows incomplete and rejected login states without revealing which field failed', async () => {
    await renderApp({ account: null });
    await findField('Cuenta de prueba');
    click('Iniciar sesión');
    expect(await screen.findByText('Indica la cuenta de prueba para continuar.')).toBeVisible();
    type('Cuenta de prueba', 'cuenta-que-no-existe');
    click('Iniciar sesión');
    expect(await screen.findByText('No pudimos verificar tu identidad.')).toBeVisible();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows an unavailable state when login fails for a non-credential reason', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null });
    await findField('Cuenta de prueba');
    api.controls.failNext('login', 500);
    type('Cuenta de prueba', demoSubjects.admin);
    click('Iniciar sesión');
    expect(await screen.findByText('Servicio no disponible')).toBeVisible();
  });

  it('ignores an unsafe post-login destination', async () => {
    await renderApp({ account: null, path: '/iniciar-sesion?siguiente=//evil.example' });
    await findField('Cuenta de prueba');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Iniciar sesión');
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(window.location.pathname).toBe('/');
  });

  it('keeps the query string of the requested route through login', async () => {
    await renderApp({ account: null, path: '/configuracion/usuarios?pagina=2' });
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
    expect(window.location.search).toBe('?siguiente=%2Fconfiguracion%2Fusuarios%3Fpagina%3D2');
    await findField('Cuenta de prueba');
    type('Cuenta de prueba', demoSubjects.admin);
    click('Iniciar sesión');
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    expect(window.location.pathname + window.location.search).toBe(
      '/configuracion/usuarios?pagina=2',
    );
  });

  it('stays on the current screen when the History API refuses a navigation', async () => {
    await renderApp();
    const link = await screen.findByRole('link', { name: 'Roles' });
    const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => link.click()).not.toThrow();
    push.mockRestore();
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { name: 'Inicio', level: 1 })).toBeInTheDocument();
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

  it('stays signed in and says so when the sign-out call fails', async () => {
    const { api } = await renderApp();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    api.controls.failNext('logout');
    click('Cerrar sesión');
    expect(await screen.findByText('No pudimos cerrar sesión')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Inicio', level: 1 })).toBeInTheDocument();
    expect(api.controls.isSignedIn()).toBe(true);
    click('Cerrar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
    expect(api.controls.isSignedIn()).toBe(false);
  });

  it('treats a 401 on sign-out as an expired session', async () => {
    const { api } = await renderApp();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    api.controls.failNext('logout', 401);
    click('Cerrar sesión');
    await screen.findByRole('group', { name: 'Sesión expirada' });
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
  it('activates the account with the identity provider and enters the shell', async () => {
    await renderApp({ account: null, path });
    await screen.findByText(
      'Te invitaron a Transportes Demo SA con el rol Responsable de flotilla.',
    );
    accept();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    expect(screen.getByTestId('shell-user')).toHaveTextContent('Responsable de flotilla');
  });

  it('asks for the account before calling the API', async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api.auth, 'acceptInvitation');
    await renderApp({ api, account: null, path });
    await findField('Cuenta de prueba');
    click('Activar cuenta');
    expect(await screen.findByText('Indica la cuenta de prueba para continuar.')).toBeVisible();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows a rejection when the identity cannot be verified, and nothing about fields', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null, path });
    await findField('Cuenta de prueba');
    api.auth.acceptInvitation = async () => ({
      ok: false,
      error: { code: 'unauthorized', status: 401, message: 'x', correlationId: 'c' },
    });
    accept();
    expect(
      await screen.findByText('No pudimos verificar tu identidad. Intenta nuevamente.'),
    ).toBeVisible();
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
    await findField('Cuenta de prueba');
  });

  it('turns an invitation consumed in the meantime into the unavailable state', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null, path });
    await findField('Cuenta de prueba');
    api.auth.acceptInvitation = async () => ({
      ok: false,
      error: { code: 'not_found', status: 404, message: 'x', correlationId: 'c' },
    });
    accept();
    await screen.findByRole('heading', { name: 'Invitación no disponible' });
  });

  it('tells a signed-in person to sign out first instead of showing the acceptance form', async () => {
    await renderApp({ path });
    await screen.findByRole('heading', { name: 'Ya tienes una sesión activa' });
    expect(screen.queryByLabelText(/^Cuenta de prueba/)).toBeNull();
  });

  it('keeps the token in memory only: it leaves the address bar but the form still works', async () => {
    const api = createMockApi();
    const inspect = vi.spyOn(api.auth, 'inspectInvitation');
    await renderApp({ api, account: null, path });
    await findField('Cuenta de prueba');
    expect(window.location.pathname).toBe('/invitacion');
    expect(window.location.href).not.toContain(demoInvitations.valid);
    expect(inspect).toHaveBeenCalledWith(demoInvitations.valid);
  });

  it('shows a generic unavailable state when the server fails', async () => {
    const api = createMockApi();
    await renderApp({ api, account: null, path });
    await findField('Cuenta de prueba');
    type('Cuenta de prueba', 'cuenta-nueva');
    api.controls.failNext('acceptInvitation', 500);
    click('Activar cuenta');
    expect(await screen.findByText('Servicio no disponible')).toBeVisible();
  });
});

describe('expired session', () => {
  it('keeps the screen, restores the server draft and resumes after signing in again', async () => {
    const { api } = await renderApp({ path: '/configuracion/usuarios' });
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    await findField('Rol');
    type('Rol', 'role-fleet');
    await waitFor(() => expect(api.controls.storedDrafts()['invite-user']).toBeDefined(), {
      timeout: 2000,
    });

    api.controls.expireSession();
    type('Rol', 'role-viewer');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Sesión expirada' })).toHaveFocus(),
    );
    expect(screen.getByText(/Mantenemos estos cambios en esta pantalla/)).toBeInTheDocument();
    // The screen below the panel is inert while the session is expired.
    expect(getField('Rol').closest('[inert]')).not.toBeNull();

    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sesión expirada' })).toBeNull(),
    );
    expect(getField('Rol')).toHaveValue('role-viewer');
    await waitFor(() =>
      expect(api.controls.storedDrafts()['invite-user']).toMatchObject({
        roleId: 'role-viewer',
      }),
    );
  });

  it('expires the session when an API call answers 401 and reloads the data after signing in again', async () => {
    const { api } = await renderApp({ path: '/configuracion/usuarios' });
    await screen.findByRole('table', { name: /Usuarios/ });
    api.controls.expireSession();
    type('Buscar por identificador, rol o estado', 'admin');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(
      await screen.findByRole('heading', { name: 'Datos no disponibles' }),
    ).toBeInTheDocument();
    type('Cuenta de prueba', demoSubjects.admin);
    click('Continuar');
    const table = await screen.findByRole('table', { name: 'Usuarios (1)' });
    expect(table).toHaveTextContent('user-admin');
  });

  it('shows the panel with the previous screen and signs in again with the same account', async () => {
    const { api } = await renderApp({ path: '/configuracion/empresa' });
    await findField('Nombre de la empresa');
    api.controls.expireSession();
    type('Nombre de la empresa', 'Otra razón social');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    type('Cuenta de prueba', 'cuenta-que-no-existe');
    click('Continuar');
    expect(
      await screen.findByText(
        'No pudimos verificar tu identidad o el servicio no está disponible.',
      ),
    ).toBeVisible();
    type('Cuenta de prueba', demoSubjects.admin);
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

  it('locks navigation and sign-out while expired, so no screen (and its draft) can be left', async () => {
    const { api } = await renderApp({ path: '/configuracion/empresa' });
    await findField('Nombre de la empresa');
    api.controls.expireSession();
    type('Nombre de la empresa', 'Pendiente de enviar');
    await screen.findByRole('group', { name: 'Sesión expirada' });
    expect(screen.getByRole('navigation', { name: 'Principal', hidden: true })).toHaveAttribute(
      'inert',
    );
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeDisabled();
    expect(window.location.pathname).toBe('/configuracion/empresa');
    expect(getField('Nombre de la empresa')).toHaveValue('Pendiente de enviar');
  });

  it('forgets a spent invitation token so a later bare /invitacion cannot reuse it', async () => {
    const api = createMockApi();
    const inspect = vi.spyOn(api.auth, 'inspectInvitation');
    await renderApp({ api, account: null, path: `/invitacion/${demoInvitations.valid}` });
    await findField('Cuenta de prueba');
    accept();
    await screen.findByRole('heading', { name: 'Inicio', level: 1 });
    click('Cerrar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });
    act(() => {
      window.history.pushState(null, '', '/invitacion');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Invitación no disponible' });
    expect(inspect).toHaveBeenLastCalledWith('');
  });
});
