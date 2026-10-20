import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl } from '../../e2e/fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from '../../e2e/mvp/world.js';

/**
 * Matriz de aislamiento consolidada de las vías nuevas de M5 (MVP-INTEGRATE, alcance 4), sentido B → A.
 *
 * `tests/acceptance/isolation-m5.test.ts` (MVP-QA) ya cubre el sentido A → B con ataques sobre cada vía.
 * Aquí se ejecuta lo que le falta: el espejo (los datos nacen en B y A intenta leerlos o tocarlos), con
 * dos sesiones de A de distinto rol, y la lectura directa de las tablas de A para confirmar que nada de
 * B llegó a su base. Cada caso crea sus propios datos con una etiqueta única y no depende de otro caso.
 * Datos sintéticos.
 */
const suite = adminUrl ? describe : describe.skip;

const HOOKS = `${API}/webhooks/endpoints`;
const NOTIFY = `${API}/notifications`;
let counter = 0;
const tag = (prefix: string) =>
  `${prefix}${Date.now().toString(36).slice(-4)}${(counter += 1)}`.slice(0, 10);

suite('Matriz de aislamiento de M5 (sentido B → A)', { timeout: 180_000 }, () => {
  let w: MvpWorld;
  let areaB: string;
  beforeAll(async () => {
    w = await startMvpWorld();
    areaB = await w.area(w.adminB, 'Flota aislamiento B');
  }, 180_000);
  afterAll(async () => w?.stop(), 60_000);

  const noEcho = (reply: { text: string }, ...ids: string[]) => {
    for (const id of ids) expect(reply.text).not.toContain(id);
  };

  it('búsqueda: lo que nace en B no se halla desde A ni con rol amplio', async () => {
    const unit = tag('RS');
    const vehicleId = await w.vehicle(w.adminB, areaB, unit);
    await w.platformB.runtime.periodic.tick('search.reconcile');
    await tick(w.platformB);
    const own = await w.adminB.get(`${API}/search?q=FL${unit}`);
    expect(own.status, own.text).toBe(200);
    expect(own.text).toContain(vehicleId);
    for (const browser of [w.adminA, w.piiA, w.viewerA]) {
      const reply = await browser.get(`${API}/search?q=FL${unit}`);
      expect(reply.status, reply.text).toBe(200);
      noEcho(reply, vehicleId);
      expect((await browser.get(`/api/vehicles/${vehicleId}`)).status).toBe(404);
    }
  });

  it('vistas guardadas: A no lista, edita ni borra la vista compartida de B', async () => {
    const made = await w.adminB.post(`${API}/views`, {
      json: { module: 'vehicles', name: `Vista ${tag('B')}`, shared: true, filters: {} },
    });
    expect(made.status, made.text).toBe(201);
    const id = made.json.id as string;
    const listed = await w.adminA.get(`${API}/views?module=vehicles`);
    expect(listed.status).toBe(200);
    noEcho(listed, id);
    const patch = await w.adminA.send('PATCH', `${API}/views/${id}`, {
      json: { version: 1, name: 'Robada' },
    });
    expect(patch.status).toBe(404);
    noEcho(patch, id);
    expect((await w.adminA.delete(`${API}/views/${id}`)).status).toBe(404);
    expect((await w.adminB.get(`${API}/views?module=vehicles`)).text).toContain(id);
  });

  it('dashboard: las cifras de A no incluyen las altas de B y un área de B es inexistente para A', async () => {
    const countOf = async (browser: MvpWorld['adminA']) => {
      const reply = await browser.get(`${API}/dashboard`);
      expect(reply.status, reply.text).toBe(200);
      return (reply.json.widgets as { id: string; value: number }[]).find(
        (item) => item.id === 'vehicles_active',
      )?.value as number;
    };
    const before = await countOf(w.adminA);
    const foreignArea = await w.area(w.adminB, `Área ${tag('D')}`);
    await w.vehicle(w.adminB, foreignArea, tag('DB'));
    // La cifra de B sube; la de A, con o sin caché, no depende de B.
    expect(await countOf(w.adminB)).toBeGreaterThan(0);
    expect(await countOf(w.adminA)).toBe(before);
    const forged = await w.adminA.get(`${API}/dashboard?areaId=${foreignArea}`);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    noEcho(forged, foreignArea);
  });

  it('reportes, jobs y descargas: el export de B no se consulta ni se descarga desde A', async () => {
    await w.vehicle(w.adminB, areaB, tag('XB'));
    const made = await w.adminB.post(`${API}/reports/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      headers: { 'idempotency-key': `rev-${tag('k')}-0000000000` },
    });
    expect(made.status, made.text).toBeLessThan(300);
    const id = made.json.id as string;
    await tick(w.platformB);
    expect((await w.adminB.get(`${API}/exports/${id}/download`)).status).toBe(200);
    for (const browser of [w.adminA, w.adminA2]) {
      const status = await browser.get(`${API}/exports/${id}`);
      const download = await browser.get(`${API}/exports/${id}/download`);
      expect([status.status, download.status]).toEqual([404, 404]);
      noEcho(download, id);
    }
    expect((await w.adminA.get(`${API}/exports`)).text).not.toContain(id);
  });

  it('notificaciones y correo: los avisos de B no llegan a A y el sumidero de A queda sin correo de B', async () => {
    const vehicleId = await w.vehicle(w.adminB, areaB, tag('NB'));
    const followed = await w.viewerB.put(`${API}/subscriptions/vehicle/${vehicleId}`);
    expect(followed.status, followed.text).toBeLessThan(300);
    const current = await w.adminB.get(`/api/vehicles/${vehicleId}`);
    const moved = await w.adminB.post(`/api/vehicles/${vehicleId}/status`, {
      json: { version: current.json.version, status: 'out_of_service', reason: 'Baja de B' },
    });
    expect(moved.status, moved.text).toBe(200);
    await tick(w.platformB);
    await tick(w.platformB);
    expect((await w.viewerB.get(`${NOTIFY}?limit=100`)).text).toContain(vehicleId);
    for (const browser of [w.adminA, w.viewerA]) {
      const reply = await browser.get(`${NOTIFY}?limit=100`);
      noEcho(reply, vehicleId);
    }
    expect(w.mailA.messages.every((m) => m.companyId === w.tenantA)).toBe(true);
    expect(w.mailB.messages.every((m) => m.companyId === w.tenantB)).toBe(true);
    expect(JSON.stringify(w.mailA.messages)).not.toContain(vehicleId);
    expect((await w.viewerA.put(`${API}/subscriptions/vehicle/${vehicleId}`)).status).toBe(404);
  });

  it('webhooks e historial: A no ve ni toca el endpoint de B y su receptor no recibe nada de B', async () => {
    const made = await w.adminB.post(HOOKS, {
      json: { url: 'https://hooks.receiver-b.example.com/rev', events: ['vehicle.created'] },
    });
    expect(made.status, made.text).toBe(201);
    const id = made.json.endpoint.id as string;
    const before = w.receiverA.received.length;
    await w.vehicle(w.adminB, areaB, tag('WB'));
    await tick(w.platformB);
    await tick(w.platformA);
    expect(w.receiverA.received.length).toBe(before);
    const deliveries = await w.adminB.get(`${HOOKS}/${id}/deliveries`);
    expect(deliveries.status).toBe(200);
    const deliveryId = deliveries.json.items[0]?.id as string;
    expect(deliveryId).toBeTruthy();
    for (const attempt of [
      w.adminA.get(`${HOOKS}/${id}`),
      w.adminA.get(`${HOOKS}/${id}/deliveries`),
      w.adminA.post(`${HOOKS}/${id}/test`, { json: {} }),
      w.adminA.post(`${HOOKS}/${id}/rotate-secret`, { json: { version: 1 } }),
      w.adminA.post(`${HOOKS}/${id}/deliveries/${deliveryId}/retry`, { json: {} }),
      w.adminA.delete(`${HOOKS}/${id}`),
    ]) {
      const reply = await attempt;
      expect(reply.status, reply.text).toBe(404);
      noEcho(reply, id, deliveryId);
    }
    noEcho(await w.adminA.get(HOOKS), id);
  });

  it('consulta de audit: A no ve el rastro de B ni reutiliza su cursor', async () => {
    const vehicleId = await w.vehicle(w.adminB, areaB, tag('AB'));
    for (let i = 0; i < 26; i += 1) await w.area(w.adminB, `Área audit ${tag('AR')}`);
    await tick(w.platformB);
    await tick(w.platformA);
    const page = await w.adminB.get(`${API}/audit?limit=25`);
    expect(page.status, page.text).toBe(200);
    const cursor = page.json.nextCursor as string | null;
    for (const browser of [w.auditorA, w.adminA]) {
      noEcho(await browser.get(`${API}/audit?limit=100`), vehicleId);
      const entity = await browser.get(`${API}/audit/entities/vehicle/${vehicleId}`);
      if (entity.status === 200) expect(entity.json.items).toEqual([]);
      else expect(entity.status).toBe(404);
      if (cursor) {
        const replayed = await browser.get(
          `${API}/audit?limit=25&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(replayed.status).toBeGreaterThanOrEqual(400);
        noEcho(replayed, vehicleId);
      }
    }
  });

  it('la base de A no tiene filas de B en las tablas nuevas', async () => {
    const tables = await w.database.rows<{ table_name: string }>(
      `SELECT table_name AS table_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name = 'company_id'
          AND table_name REGEXP 'search|views|export|notification|webhook'`,
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { table_name: table } of tables) {
      const sql = `SELECT COUNT(*) AS n FROM \`${table}\` WHERE company_id = ?`;
      const inA = await w.database.rows<{ n: number }>(sql, [w.tenantB]);
      const inB = await w.database.rowsB<{ n: number }>(sql, [w.tenantA]);
      expect(Number(inA[0]?.n), `${table} de A no debe tener filas de B`).toBe(0);
      expect(Number(inB[0]?.n), `${table} de B no debe tener filas de A`).toBe(0);
    }
  });
});
