import { mountApp } from './bootstrap';

// The in-memory API and the fake identity provider are development tools: they are imported only
// when the bundler reports a development build, so a production bundle cannot contain them.
// `mock` (default) runs the shell against the in-memory API; `bff` talks to the same-origin BFF with the
// fake provider, which no real server accepts.
// A production build talks to the same-origin BFF and signs in through the identity provider's hosted
// page; its public settings (hosted domain and client id, no secret) are baked in at build time.
const container = document.getElementById('root');
if (container) {
  const domain = import.meta.env?.VITE_OIDC_DOMAIN;
  const clientId = import.meta.env?.VITE_OIDC_CLIENT_ID;
  const logoutUri = import.meta.env?.VITE_OIDC_LOGOUT_URI;
  if (import.meta.env?.DEV === true) {
    const mode = document.querySelector('meta[name="opslog-api"]')?.getAttribute('content');
    void Promise.all([import('../api/ports'), import('../api/fakeOidc'), import('./mockApi')]).then(
      ([{ createHttpApi }, { createFakeOidc }, { createMockApi }]) =>
        mountApp(container, mode === 'bff' ? createHttpApi(createFakeOidc()) : createMockApi()),
    );
  } else if (domain && clientId) {
    void Promise.all([import('../api/ports'), import('../api/redirectOidc')]).then(
      ([{ createHttpApi }, { createRedirectOidc }]) =>
        mountApp(
          container,
          createHttpApi(
            createRedirectOidc({
              domain,
              clientId,
              redirectUri: `${window.location.origin}/auth/callback`,
              ...(logoutUri ? { logoutUri } : {}),
            }),
          ),
        ),
    );
  } else {
    // No identity provider configured for this build: fail closed.
    container.textContent = 'El inicio de sesión no está disponible en esta compilación.';
  }
}
