// Mounts the real web shell against the contract-typed mock API. The mock keeps the "cookie" in its own
// closure; the harness only exposes a button to simulate the server expiring that session.
import { mountApp } from '../../apps/web/app/bootstrap';
import { createMockApi } from '../../apps/web/app/mockApi';

const api = createMockApi();
const root = document.getElementById('root') as HTMLElement;
const app = document.createElement('div');
const harness = document.createElement('div');
const expire = document.createElement('button');
expire.textContent = 'Simular expiración de sesión (arnés)';
expire.addEventListener('click', () => api.controls.expireSession());
harness.append(expire);
root.append(app, harness);
mountApp(app, api, { basename: '/web' });
