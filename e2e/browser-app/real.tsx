// The real web shell over the HTTP ports: requests go to `/api`, which the harness proxies to the
// composed BFF backed by a disposable synthetic MySQL database (e2e/real-api/harness.ts).
import { mountApp } from '../../apps/web/app/bootstrap';
import { createFakeOidc } from '../../apps/web/api/fakeOidc';
import { createHttpApi } from '../../apps/web/api/ports';

mountApp(document.getElementById('root') as HTMLElement, createHttpApi(createFakeOidc()), {
  basename: '/real',
});
