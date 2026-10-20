import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type RoleName } from '../../../apps/api/composition/src/access.js';
import { adminUrl } from '../../e2e/fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from '../../e2e/mvp/world.js';

/**
 * Sin costos ni datos personales (MVP-INTEGRATE, aceptación 4). Un despachador de la empresa A puede ver
 * y exportar, pero no tiene `view_costs`, `incidents:view_costs` ni `view_pii`: ni el archivo exportado,
 * ni el catálogo de reportes, ni el aviso, ni el correo del sumidero, ni el payload del webhook llevan
 * importes o el número de licencia. El administrador del mismo dato sí los ve, para que la prueba no
 * pase por un archivo vacío. La plantilla de rol existe solo mientras corre esta carpeta. Datos sintéticos.
 */
const suite = adminUrl ? describe : describe.skip;

const DISPATCHER = 'dispatcher_nocost';
const HOOKS = `${API}/webhooks/endpoints`;

suite(
  'Despachador sin costos ni PII: nada de importes o datos personales',
  { timeout: 180_000 },
  () => {
    let w: MvpWorld;
    let dispatcher: MvpWorld['adminA'];
    let license: string;
    let driverId: string;
    let vehicleId: string;
    let secret: string;
    const templates = ROLE_PERMISSIONS as Record<string, readonly string[]>;
    beforeAll(async () => {
      templates[DISPATCHER] = ['view', 'export', 'incidents:view'];
      w = await startMvpWorld();
      await w.worldA.member('subject-admin-a', DISPATCHER as RoleName, 'subject-dispatcher-a');
      dispatcher = await w.worldA.loginAs('subject-dispatcher-a');
      const area = await w.area(w.adminA, 'Flota despacho');
      driverId = await w.driver(w.adminA, area, 'DSP');
      vehicleId = await w.vehicle(w.adminA, area, 'DSP');
      const found = await w.adminA.get(`/api/employees/${driverId}`);
      license = found.json.pii?.licenseNumber as string;
      expect(license, 'the administrator reads the license').toBeTruthy();
      const hook = await w.adminA.post(HOOKS, {
        json: {
          url: 'https://hooks.receiver-a.example.com/dsp',
          events: ['vehicle.status_changed'],
        },
      });
      expect(hook.status, hook.text).toBe(201);
      secret = hook.json.secret as string;
      const followed = await dispatcher.put(`${API}/subscriptions/vehicle/${vehicleId}`);
      expect(followed.status, followed.text).toBeLessThan(300);
      // The search projection follows through the periodic reconcile, as the api process does.
      await w.platformA.runtime.periodic.tick('search.reconcile');
      await tick(w.platformA);
      w.mailA.messages.length = 0;
      w.receiverA.received.length = 0;
      const current = await w.adminA.get(`/api/vehicles/${vehicleId}`);
      const moved = await w.adminA.post(`/api/vehicles/${vehicleId}/status`, {
        json: { version: current.json.version, status: 'out_of_service', reason: 'Importe 99999' },
      });
      expect(moved.status, moved.text).toBe(200);
      await tick(w.platformA);
      await tick(w.platformA);
    }, 180_000);
    afterAll(async () => {
      delete templates[DISPATCHER];
      await w?.stop();
    }, 60_000);

    const exported = async (browser: MvpWorld['adminA'], report: string, key: string) => {
      const made = await browser.post(`${API}/reports/${report}/exports`, {
        json: { format: 'csv' },
        headers: { 'idempotency-key': `dsp-${report}-${key}-0000000` },
      });
      if (made.status >= 300) return { status: made.status, text: '' };
      const file = await browser.get(`${API}/exports/${made.json.id}/download`);
      return {
        status: file.status,
        text: Buffer.from(file.bytes ?? file.text).toString('utf8'),
      };
    };

    it('exporta la plantilla de conductores sin el número de licencia, que el administrador sí recibe', async () => {
      const own = await exported(dispatcher, 'drivers', 'a');
      expect(own.status).toBe(200);
      // A header and at least one data row.
      expect(own.text.split(/\r?\n/).filter((line) => line.trim() !== '').length).toBeGreaterThan(
        1,
      );
      expect(own.text).toContain('Perez');
      expect(own.text).not.toContain(license);
      const admin = await exported(w.adminA, 'drivers', 'b');
      expect(admin.status).toBe(200);
      expect(admin.text).toContain(license);
    });

    it('no ofrece ni genera los reportes de costos', async () => {
      const catalog = await dispatcher.get(`${API}/reports`);
      expect(catalog.status, catalog.text).toBe(200);
      for (const report of ['maintenance_costs', 'incident_costs']) {
        expect(catalog.text).not.toContain(report);
        const attempt = await exported(dispatcher, report, 'c');
        expect([403, 404]).toContain(attempt.status);
      }
      expect((await w.adminA.get(`${API}/reports`)).text).toContain('maintenance_costs');
    });

    it('no halla al conductor por su licencia ni ve el número en la ficha', async () => {
      const query = `${API}/search?q=${encodeURIComponent(license)}`;
      // Positive control: whoever may read personal data finds the driver by the license.
      const found = await w.adminA.get(query);
      expect(found.status, found.text).toBe(200);
      expect(found.text).toContain(driverId);
      const search = await dispatcher.get(query);
      expect(search.status).toBe(200);
      expect(search.text).not.toContain(driverId);
      const detail = await dispatcher.get(`/api/employees/${driverId}`);
      expect(detail.status, detail.text).toBe(200);
      expect(detail.text).not.toContain(license);
    });

    it('recibe el aviso y el correo sin importes, texto libre ni datos personales', async () => {
      const notices = await dispatcher.get(`${API}/notifications?limit=100`);
      expect(notices.text).toContain(vehicleId);
      expect(notices.text).not.toMatch(/99999|amountMinor/);
      const mail = JSON.stringify(w.mailA.messages);
      expect(mail.length).toBeGreaterThan(2);
      expect(mail).not.toContain(license);
      expect(mail).not.toContain('99999');
    });

    it('el payload firmado del webhook lleva la identidad del vehículo y nada más sensible', () => {
      expect(w.receiverA.received).toHaveLength(1);
      expect(w.receiverA.verify(0, secret)).toMatchObject({ ok: true });
      const body = w.receiverA.bodyOf(0);
      expect(body).toContain(vehicleId);
      expect(body).not.toContain(license);
      expect(body).not.toMatch(/99999|amountMinor|cost/i);
    });
  },
);
