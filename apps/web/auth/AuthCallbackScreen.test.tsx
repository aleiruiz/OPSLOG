import { describe, expect, it, vi } from 'vitest';
import { createMockApi, demoCredentials, demoInvitations } from '../app/mockApi';
import type { OidcCompletion, OidcPort, Result } from '../app/types';
import { click, renderApp, screen, waitFor } from '../app/test/utils';

const providerAnswering = (answer: Result<OidcCompletion>): OidcPort => ({
  redirects: true,
  authorize: () => new Promise<never>(() => undefined),
  complete: () => answer,
});
const fail: Result<never> = {
  ok: false,
  error: { code: 'unauthorized', status: 401, message: 'x', correlationId: 'c' },
};
const withOidc = (oidc: OidcPort) => ({ ...createMockApi(), oidc });
const completion = (context = {}): Result<OidcCompletion> => ({
  ok: true,
  value: { credentials: demoCredentials.admin, context },
});

describe('identity provider callback', () => {
  it('redeems the answer once, signs in and goes to where the person was headed', async () => {
    const complete = vi.fn(() => completion({ next: '/configuracion/usuarios' }));
    const api = withOidc({ ...providerAnswering(completion()), complete });
    const login = vi.spyOn(api.auth, 'login');
    await renderApp({ api, account: null, path: '/auth/callback?code=c&state=s' });
    await screen.findByRole('heading', { name: 'Usuarios', level: 1 });
    expect(window.location.pathname).toBe('/configuracion/usuarios');
    expect(login).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('accepts the invitation the person was activating before leaving', async () => {
    const api = withOidc(
      providerAnswering({
        ok: true,
        value: {
          credentials: { code: 'fake-code:cuenta-nueva', nonce: 'n' },
          context: { invitationToken: demoInvitations.valid },
        },
      }),
    );
    const accept = vi.spyOn(api.auth, 'acceptInvitation');
    await renderApp({ api, account: null, path: '/auth/callback?code=c&state=s' });
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    expect(accept.mock.calls[0]?.[0]).toBe(demoInvitations.valid);
  });

  it('shows a retry path when the provider answer is rejected or the session cannot open', async () => {
    const api = withOidc(providerAnswering(fail));
    await renderApp({ api, account: null, path: '/auth/callback?error=access_denied' });
    await screen.findByText('No pudimos iniciar sesión');
    click('Ir a iniciar sesión');
    await screen.findByRole('heading', { name: 'Iniciar sesión', level: 1 });

    const rejecting = withOidc(providerAnswering(completion()));
    rejecting.auth.login = async () => fail;
    await renderApp({ api: rejecting, account: null, path: '/auth/callback?code=c&state=s' });
    await screen.findByText('No pudimos iniciar sesión');
  });

  it('fails closed when the provider cannot complete (fake provider)', async () => {
    await renderApp({ account: null, path: '/auth/callback?code=c&state=s' });
    await screen.findByText('No pudimos iniciar sesión');
  });

  it('sends a signed-in person home instead of redeeming again', async () => {
    await renderApp({ path: '/auth/callback?code=c&state=s' });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });
});
