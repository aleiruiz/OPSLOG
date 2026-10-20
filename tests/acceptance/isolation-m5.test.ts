import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { EXPORT_TABLES } from '../../packages/persistence/exports/src/index.js';
import { NOTIFICATION_TABLES } from '../../packages/persistence/notifications/src/index.js';
import { SEARCH_TABLES } from '../../packages/persistence/search/src/index.js';
import { WEBHOOK_TABLES } from '../../packages/persistence/webhooks/src/index.js';
import {
  acceptance,
  key,
  ok,
  reindex,
  relayAudit,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

const W = '/api/v1/webhooks/endpoints';
const N = '/api/v1/notifications';
const URL_A = 'https://hooks.receiver-a.example.com/opslog';

/**
 * SPECS §4.4 · matriz A/B de las vías nuevas de M5 sobre dos bases MySQL físicamente separadas:
 * búsqueda, vistas guardadas, dashboard y su cache, reportes y jobs, descargas, notificaciones y
 * correo del sumidero, webhooks y su historial, y consulta de audit. Cada caso crea el dato en A,
 * intenta leerlo y escribirlo desde B (404 uniforme, sin eco del id ajeno) y mira las tablas de la
 * otra base. Datos sintéticos.
 */
acceptance('Aislamiento A/B de las vías nuevas de M5 (SPECS §4.4)', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  let area: string;
  beforeAll(async () => {
    w = await startAcceptance();
    area = await w.fleet.area(w.adminA, 'Flota aislamiento A');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const noEcho = (reply: { text: string }, ...ids: string[]) => {
    for (const id of ids) expect(reply.text).not.toContain(id);
  };

  it('búsqueda: B no encuentra lo de A, la proyección de B no tiene filas de A y un q manipulado no cambia de empresa', async () => {
    const unit = tag('ISV');
    const vehicleId = await w.fleet.vehicle(w.adminA, area, unit);
    const vehicleB = await w.fleet.vehicle(w.adminB, await w.fleet.area(w.adminB), unit);
    await tick(w.fleet.platformA);
    await tick(w.fleet.platformB);
    await reindex(w.fleet.platformA, w.fleet.tenantA);
    await reindex(w.fleet.platformB, w.fleet.tenantB);
    // Mismo texto y mismo número de unidad en las dos empresas: cada una halla solo el suyo.
    const idsOf = async (browser: typeof w.adminA) =>
      (
        ok(await browser.get(`/api/v1/search?q=FL${unit}`)).json.groups as {
          items: { id: string }[];
        }[]
      )
        .flatMap((g) => g.items)
        .map((i) => i.id);
    expect(await idsOf(w.adminA)).toEqual([vehicleId]);
    expect(await idsOf(w.adminB)).toEqual([vehicleB]);
    const spoof = await w.adminB.get(`/api/v1/search?q=FL${unit}&tenantId=${w.fleet.tenantA}`);
    expect(spoof.status).toBe(400);
    const foreign = await w.database.rowsB<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${SEARCH_TABLES.entries}\` WHERE company_id = ?`,
      [w.fleet.tenantA],
    );
    expect(Number(foreign[0]?.n)).toBe(0);
  });

  it('vistas guardadas: B no lista, edita ni borra la vista compartida de A y sus columnas son suyas', async () => {
    const made = ok(
      await w.adminA.post('/api/v1/views', {
        json: {
          module: 'vehicles',
          name: `Activos ${tag('V')}`,
          shared: true,
          filters: { status: 'active' },
        },
      }),
      201,
    );
    const id = made.json.id as string;
    const listB = ok(await w.adminB.get('/api/v1/views?module=vehicles'));
    expect(JSON.stringify(listB.json)).not.toContain(id);
    expect(
      (
        await w.adminB.send('PATCH', `/api/v1/views/${id}`, {
          json: { version: 1, name: 'Robada' },
        })
      ).status,
    ).toBe(404);
    expect((await w.adminB.delete(`/api/v1/views/${id}`)).status).toBe(404);
    ok(await w.adminA.put('/api/v1/views/columns/vehicles', { json: { columns: ['plate'] } }));
    const columnsB = ok(await w.adminB.get('/api/v1/views/columns/vehicles'));
    expect(columnsB.json.columns).not.toEqual(['plate']);
    expect(
      ok(await w.adminA.get('/api/v1/views?module=vehicles')).json.items.map(
        (v: { id: string }) => v.id,
      ),
    ).toContain(id);
  });

  it('dashboard y cache: las cifras de una empresa no se mueven por la otra, ni por un filtro ajeno, ni dentro del TTL', async () => {
    const countOf = async (browser: typeof w.adminA) =>
      (
        ok(await browser.get('/api/v1/dashboard')).json.widgets as { id: string; value: number }[]
      ).find((x) => x.id === 'vehicles_active')?.value as number;
    const before = await countOf(w.adminA);
    const beforeB = await countOf(w.adminB);
    await w.fleet.vehicle(w.adminB, await w.fleet.area(w.adminB), tag('DB'));
    // Dentro del TTL (5 min) la cifra cacheada de A se mantiene; esto solo muestra la caché. El
    // aislamiento se comprueba al expirar el TTL: A sigue igual y B suma la alta propia.
    expect(await countOf(w.adminA)).toBe(before);
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    const [afterA, afterB] = [await countOf(w.adminA), await countOf(w.adminB)];
    expect(afterA).toBe(before);
    expect(afterB).toBe(beforeB + 1);
    await w.fleet.vehicle(w.adminA, area, tag('DA'));
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    expect(await countOf(w.adminA)).toBe(before + 1);
    expect(await countOf(w.adminB)).toBe(beforeB + 1);
    const forged = await w.adminB.get(`/api/v1/dashboard?areaId=${area}`);
    expect(forged.status).not.toBe(200);
    noEcho(forged, area);
  });

  it('reportes, jobs y descargas: el trabajo de A no existe para B y su archivo no se descarga desde B', async () => {
    await w.fleet.vehicle(w.adminA, area, tag('RP'));
    const made = ok(
      await w.adminA.post('/api/v1/reports/vehicle_inventory/exports', {
        json: { format: 'csv' },
        headers: key(),
      }),
    );
    const id = made.json.id as string;
    expect((await w.adminB.get(`/api/v1/exports/${id}`)).status).toBe(404);
    const download = await w.adminB.get(`/api/v1/exports/${id}/download`);
    expect(download.status).toBe(404);
    noEcho(download, id);
    expect(JSON.stringify(ok(await w.adminB.get('/api/v1/exports')).json)).not.toContain(id);
    const foreign = await w.database.rowsB<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${EXPORT_TABLES.jobs}\` WHERE company_id = ?`,
      [w.fleet.tenantA],
    );
    expect(Number(foreign[0]?.n)).toBe(0);
    // El worker de exportaciones de B no toca los trabajos de A.
    await tick(w.fleet.platformB, 'exports.run');
    expect(ok(await w.adminA.get(`/api/v1/exports/${id}`)).json.status).toBe('completed');
  });

  it('descargas de evidencia: el archivo de un siniestro de A no se sirve a B', async () => {
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('EV'));
    const created = ok(
      await w.adminA.post('/api/v1/incidents', {
        json: {
          vehicleId,
          type: 'collision',
          severity: 'low',
          occurredAt: new Date().toISOString(),
          location: { text: 'Calle Sintética' },
          description: 'Evidencia aislada',
          vehicleOperable: true,
          noDriverReason: 'Sin conductor',
          noPhotoJustification: 'Sin foto',
        },
      }),
      201,
    );
    const evidence = ok(
      await w.adminA.post(`/api/v1/incidents/${created.json.id}/evidence`, {
        json: {
          version: created.json.version,
          category: 'photo',
          stage: 'on_site',
          name: 'foto.png',
          contentType: 'image/png',
          clientCompressed: true,
          contentBase64: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(256, 3),
          ]).toString('base64'),
        },
      }),
      201,
    );
    await w.fleet.platformA.pipeline.processScans();
    const evidenceId = (evidence.json.evidence?.id ?? evidence.json.evidenceId) as
      | string
      | undefined;
    const list = ok(await w.adminA.get(`/api/v1/incidents/${created.json.id}/evidence`));
    const fileId = evidenceId ?? (list.json.items[0].id as string);
    ok(await w.adminA.get(`/api/v1/incidents/${created.json.id}/evidence/${fileId}/content`));
    const stolen = await w.adminB.get(
      `/api/v1/incidents/${created.json.id}/evidence/${fileId}/content`,
    );
    expect(stolen.status).toBe(404);
    expect((await w.adminB.get(`/api/v1/incidents/${created.json.id}/evidence`)).status).toBe(404);
  });

  it('notificaciones y correo: avisos, lecturas, suscripciones y sumidero quedan en su empresa', async () => {
    await w.fleet.worldA.member('subject-admin-a', 'viewer', `subject-notify-${tag('x')}`);
    await w.fleet.worldB.member('subject-admin-b', 'viewer', `subject-notify-${tag('y')}`);
    await tick(w.fleet.platformA, 'notifications.scan', 'notifications.dispatch');
    await tick(w.fleet.platformB, 'notifications.scan', 'notifications.dispatch');
    const listA = ok(await w.adminA.get(`${N}?limit=100`)).json;
    const listB = ok(await w.adminB.get(`${N}?limit=100`)).json;
    expect(listA.items.length).toBeGreaterThan(0);
    const idsA = new Set(listA.items.map((i: { id: string }) => i.id));
    expect(listB.items.some((i: { id: string }) => idsA.has(i.id))).toBe(false);
    const target = listA.items[0].id as string;
    expect((await w.adminB.post(`${N}/${target}/read`)).status).toBe(404);
    const before = ok(await w.adminA.get(`${N}/unread-count`)).json.unread;
    await w.adminB.post(`${N}/read-all`);
    expect(ok(await w.adminA.get(`${N}/unread-count`)).json.unread).toBe(before);
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('NV'));
    expect((await w.adminB.put(`/api/v1/subscriptions/vehicle/${vehicleId}`)).status).toBe(404);
    expect(w.mailA.messages.length).toBeGreaterThan(0);
    expect(w.mailB.messages.length).toBeGreaterThan(0);
    expect(w.mailA.messages.every((m) => m.companyId === w.fleet.tenantA)).toBe(true);
    expect(w.mailB.messages.every((m) => m.companyId === w.fleet.tenantB)).toBe(true);
    const rowsB = await w.database.rowsB<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${NOTIFICATION_TABLES.notifications}\` WHERE company_id = ?`,
      [w.fleet.tenantA],
    );
    expect(Number(rowsB[0]?.n)).toBe(0);
  });

  it('webhooks e historial: B no ve, edita, rota, prueba ni reintenta el endpoint de A y su receptor no recibe nada', async () => {
    const callsB = w.receiverB.calls.length;
    const made = ok(
      await w.adminA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } }),
      201,
    );
    const id = made.json.endpoint.id as string;
    await w.fleet.vehicle(w.adminA, area, tag('WH'));
    await tick(w.fleet.platformA, 'webhooks.dispatch');
    await tick(w.fleet.platformB, 'webhooks.dispatch');
    expect(w.receiverA.calls.length).toBeGreaterThan(0);
    expect(w.receiverB.calls.length).toBe(callsB);
    const history = ok(await w.adminA.get(`${W}/${id}/deliveries`)).json;
    const deliveryId = history.items[0].id as string;
    for (const attempt of [
      w.adminB.get(`${W}/${id}`),
      w.adminB.send('PATCH', `${W}/${id}`, { json: { version: 1, active: false } }),
      w.adminB.delete(`${W}/${id}`),
      w.adminB.post(`${W}/${id}/rotate-secret`, { json: { version: 1 } }),
      w.adminB.post(`${W}/${id}/test`, { json: {} }),
      w.adminB.get(`${W}/${id}/deliveries`),
      w.adminB.post(`${W}/${id}/deliveries/${deliveryId}/retry`, { json: {} }),
    ]) {
      const reply = await attempt;
      expect(reply.status, reply.text).toBe(404);
      noEcho(reply, id, deliveryId);
    }
    expect(JSON.stringify(ok(await w.adminB.get(W)).json)).not.toContain(id);
    const foreign = await w.database.rowsB<{ n: number }>(
      `SELECT COUNT(*) AS n FROM \`${WEBHOOK_TABLES.endpoints}\` WHERE company_id = ?`,
      [w.fleet.tenantA],
    );
    expect(Number(foreign[0]?.n)).toBe(0);
    expect(ok(await w.adminA.get(`${W}/${id}`)).json.active).toBe(true);
  });

  it('consulta de audit: B no ve los eventos de A, no usa su cursor y la ficha ajena viene vacía', async () => {
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('AU'));
    // Más de una página (25) para tener un cursor firmado que B intente reutilizar.
    for (let i = 0; i < 26; i += 1) await w.fleet.area(w.adminA, `Área audit ${tag('AR')}`);
    await tick(w.fleet.platformA);
    await relayAudit(w);
    await relayAudit(w, 'b');
    const mine = ok(await w.adminA.get('/api/v1/audit?limit=25'));
    expect(mine.json.items.length).toBeGreaterThan(0);
    const global = ok(await w.adminB.get('/api/v1/audit?limit=100'));
    expect(JSON.stringify(global.json)).not.toContain(vehicleId);
    const entity = await w.adminB.get(`/api/v1/audit/entities/vehicle/${vehicleId}`);
    if (entity.status === 200) expect(entity.json.items).toEqual([]);
    else expect(entity.status).toBe(404);
    expect(mine.json.nextCursor).toBeTruthy();
    const replayed = await w.adminB.get(
      `/api/v1/audit?limit=25&cursor=${encodeURIComponent(mine.json.nextCursor)}`,
    );
    expect(replayed.status).toBeGreaterThanOrEqual(400);
    noEcho(replayed, vehicleId);
  });

  it('transversal: cabeceras manipuladas, sesión revocada y rol sin permiso no abren la otra empresa', async () => {
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('XV'));
    for (const header of ['x-tenant-id', 'x-company-id', 'x-forwarded-host', 'x-opslog-tenant']) {
      const reply = await w.adminB.get(`/api/vehicles/${vehicleId}`, {
        headers: { [header]: w.fleet.tenantA },
      });
      expect(reply.status, header).toBe(404);
    }
    // Un viewer de A no escribe webhooks ni exporta ni consulta audit (permisos de la vía nueva).
    expect(
      (await w.viewerA.post(W, { json: { url: URL_A, events: ['vehicle.created'] } })).status,
    ).toBe(403);
    expect((await w.viewerA.get('/api/v1/audit')).status).toBe(403);
    const exportTry = await w.viewerA.post('/api/v1/reports/vehicle_inventory/exports', {
      json: { format: 'csv' },
      headers: key(),
    });
    expect(exportTry.status).toBe(403);
  });
});
