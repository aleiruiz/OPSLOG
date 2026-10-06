import { createHttpApi } from '../api/ports';
import { createFakeOidc } from '../api/fakeOidc';
import { mountApp } from './bootstrap';
import { createMockApi } from './mockApi';

// `mock` (default) runs the shell against the in-memory API; `bff` talks to the same-origin BFF.
// The identity provider is still the local fake: a redirecting OIDC provider replaces it per deployment.
const mode = document.querySelector('meta[name="opslog-api"]')?.getAttribute('content');
const container = document.getElementById('root');
if (container)
  mountApp(container, mode === 'bff' ? createHttpApi(createFakeOidc()) : createMockApi());
