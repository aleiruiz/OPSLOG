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
const bump = document.createElement('button');
bump.textContent = 'Simular que otra persona edita ECO-001 (arnés)';
bump.addEventListener('click', () =>
  api.controls.changeVehicleExternally('veh-001', { odometerKm: 90000 }),
);
const bumpDocument = document.createElement('button');
bumpDocument.textContent = 'Simular cambio ajeno en el documento doc-001 (arnés)';
bumpDocument.addEventListener('click', () =>
  api.controls.changeDocumentExternally('doc-001', { title: 'Cambiado por otra persona' }),
);
const bumpPolicy = document.createElement('button');
bumpPolicy.textContent = 'Simular cambio ajeno en la póliza pol-001 (arnés)';
bumpPolicy.addEventListener('click', () =>
  api.controls.changePolicyExternally('pol-001', { insurer: 'Cambiada por otra persona' }),
);
harness.append(expire, bump, bumpDocument, bumpPolicy);
root.append(app, harness);
mountApp(app, api, { basename: '/web' });
