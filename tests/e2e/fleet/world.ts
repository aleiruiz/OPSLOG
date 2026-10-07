import { InMemoryTenantStore } from '../../../apps/api/composition/src/index.js';
import {
  createBffWorld,
  type BffWorld,
  type Browser,
} from '../../../apps/api/bff/src/test-support.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../packages/platform/pii/src/index.js';
import type { FleetDatabase } from './mysql.js';

export interface FleetWorld {
  readonly world: BffWorld;
  readonly adminA: Browser;
  readonly adminA2: Browser;
  readonly adminB: Browser;
  readonly viewerA: Browser;
  readonly editorA: Browser;
  readonly tenantA: string;
  readonly tenantB: string;
  area(browser: Browser, name?: string): Promise<string>;
  vehicle(browser: Browser, areaId: string, tag?: string): Promise<string>;
  driver(browser: Browser, areaId: string, tag?: string, expiresOn?: string): Promise<string>;
}

let sequence = 0;

export async function startFleetWorld(database: FleetDatabase): Promise<FleetWorld> {
  const world = createBffWorld({
    adapters: {
      tenants: new InMemoryTenantStore(),
      ...database.runtime.adapters,
      pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('test')),
    },
  });
  const tenantA = (await world.tenant('Empresa Sintética A', 'subject-admin-a')).tenantId;
  const tenantB = (await world.tenant('Empresa Sintética B', 'subject-admin-b')).tenantId;
  await world.member('subject-admin-a', 'viewer', 'subject-viewer-a');
  await world.member('subject-admin-a', 'editor', 'subject-editor-a');
  const [adminA, adminA2, adminB, viewerA, editorA] = await Promise.all([
    world.loginAs('subject-admin-a'),
    world.loginAs('subject-admin-a'),
    world.loginAs('subject-admin-b'),
    world.loginAs('subject-viewer-a'),
    world.loginAs('subject-editor-a'),
  ]);

  return {
    world,
    adminA,
    adminA2,
    adminB,
    viewerA,
    editorA,
    tenantA,
    tenantB,
    async area(browser, name) {
      sequence += 1;
      const reply = await browser.post('/api/areas', {
        json: {
          name: name ?? `Flota ${sequence}`,
          code: null,
          parentId: null,
          responsibleIds: [],
        },
      });
      if (reply.status !== 201)
        throw new Error(`area create failed: ${reply.status} ${reply.text}`);
      return reply.json.id as string;
    },
    async vehicle(browser, areaId, tag) {
      sequence += 1;
      const unit = tag ?? String(sequence).padStart(5, '0');
      const reply = await browser.post('/api/vehicles', {
        json: {
          economicNumber: `FLT-${unit}`,
          plate: `FL${unit}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId,
          odometerKm: 10,
        },
      });
      if (reply.status !== 201)
        throw new Error(`vehicle create failed: ${reply.status} ${reply.text}`);
      return reply.json.id as string;
    },
    async driver(browser, areaId, tag, expiresOn = '2099-12-31') {
      sequence += 1;
      const reply = await browser.post('/api/employees', {
        json: {
          kind: 'driver',
          firstName: 'Ana',
          lastName: 'Perez',
          areaId,
          employeeNumber: `FLT-EMP-${tag ?? sequence}`,
          idType: 'ine',
          nationalId: `SYNTH-ID-${sequence}`,
          phone: `+52 555 100 ${String(sequence).padStart(4, '0')}`,
          email: `driver-${sequence}@synthetic.example`,
          licenseNumber: `LIC-${sequence}`,
          licenseType: 'c',
          licenseExpiresOn: expiresOn,
        },
      });
      if (reply.status !== 201)
        throw new Error(`driver create failed: ${reply.status} ${reply.text}`);
      return reply.json.id as string;
    },
  };
}
