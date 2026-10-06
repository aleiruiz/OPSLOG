import { mountApp } from './bootstrap';

// The in-memory API and the fake identity provider are development tools: they are imported only
// when the bundler reports a development build, so a production bundle cannot contain them.
// `mock` (default) runs the shell against the in-memory API; `bff` talks to the same-origin BFF, but
// cannot sign in yet because no server accepts the fake provider's `fake-code:` codes.
const container = document.getElementById('root');
if (container) {
  if (import.meta.env?.DEV === true) {
    const mode = document.querySelector('meta[name="opslog-api"]')?.getAttribute('content');
    void Promise.all([import('../api/ports'), import('../api/fakeOidc'), import('./mockApi')]).then(
      ([{ createHttpApi }, { createFakeOidc }, { createMockApi }]) =>
        mountApp(container, mode === 'bff' ? createHttpApi(createFakeOidc()) : createMockApi()),
    );
  } else {
    // No production identity provider exists yet (redirecting OIDC is pending): fail closed.
    container.textContent = 'El inicio de sesión no está disponible en esta compilación.';
  }
}
