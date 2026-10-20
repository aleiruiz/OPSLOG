import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  acceptance,
  key,
  ok,
  relayAudit,
  startAcceptance,
  tag,
  tick,
  zipEntry,
  type AcceptanceWorld,
} from './support.js';

const R = '/api/v1/reports';
const E = '/api/v1/exports';

/**
 * STRIDE corto de la exportación (MVP-REPORTS, SPECS §7, BRD §13 y §16.2): un caso negativo por
 * amenaza, por la API real sobre MySQL. Cada caso intenta el ataque y comprueba que la defensa
 * responde, no solo que la ruta feliz funciona. Mapa en `stride.md`.
 */
acceptance('STRIDE · exportación de reportes', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  let area: string;
  const FORMULA = '=HYPERLINK("http://evil.example/x","clic")';
  beforeAll(async () => {
    w = await startAcceptance();
    const made = await w.adminA.post('/api/areas', {
      json: { name: FORMULA, code: null, parentId: null, responsibleIds: [] },
    });
    area = ok(made, 201).json.id as string;
    await w.fleet.vehicle(w.adminA, area, tag('EX'));
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const exportOf = async (format: 'csv' | 'xlsx' | 'pdf') =>
    ok(await w.adminA.post(`${R}/vehicle_inventory/exports`, { json: { format }, headers: key() }))
      .json;

  it('S · sin sesión, con cookie falsa o sin prueba CSRF no se crea ni se descarga nada', async () => {
    const job = await exportOf('csv');
    const anonymous = w.fleet.worldA.browser();
    expect((await anonymous.get(`${E}/${job.id}/download`)).status).toBe(401);
    const forged = w.fleet.worldA.browser();
    forged.jar.set('opslog_session', 'sesion-falsa-0123456789abcdef');
    expect((await forged.get(`${E}/${job.id}/download`)).status).toBe(401);
    // Con sesión válida pero sin el token CSRF, o desde otro origen, la creación se rechaza.
    const noCsrf = await w.adminA.post(`${R}/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      csrf: null,
      headers: key(),
    });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await w.adminA.post(`${R}/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      origin: 'https://evil.test',
      headers: key(),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('T · la fórmula del dato se neutraliza en CSV y XLSX, y las columnas o formatos inventados se rechazan', async () => {
    const csv = await exportOf('csv');
    const text = Buffer.from(
      ok(await w.adminA.get(`${E}/${csv.id}/download`)).bytes ?? '',
    ).toString('utf8');
    // Ninguna celda empieza con un disparador de fórmula: el dato viaja como texto.
    const cells = text.split(/\r?\n/).flatMap((line) => line.split(','));
    expect(cells.some((cell) => /^"?[=+\-@]/.test(cell) && cell.includes('HYPERLINK'))).toBe(false);
    expect(text).toContain("'=HYPERLINK");
    const xlsx = await exportOf('xlsx');
    const file = ok(await w.adminA.get(`${E}/${xlsx.id}/download`));
    const sheet = zipEntry(file.bytes ?? new Uint8Array(), 'xl/worksheets/sheet1.xml') ?? '';
    expect(sheet.length).toBeGreaterThan(0);
    expect(sheet).not.toMatch(/<f[ >]/);
    // Entradas manipuladas: formato fuera de la lista, columna inexistente o de PII, filtro enorme.
    for (const json of [
      { format: 'exe' },
      { format: 'csv', columns: ['nationalId'] },
      { format: 'csv', columns: ['plate', '../../etc/passwd'] },
      { format: 'csv', filters: { x: 'a'.repeat(5000) } },
      { format: 'csv', sort: 'nationalId' },
    ]) {
      const reply = await w.adminA.post(`${R}/vehicle_inventory/exports`, { json, headers: key() });
      expect(reply.status, JSON.stringify(json)).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
    }
    // La misma clave con otro informe es un conflicto, no una sustitución silenciosa.
    const headers = key();
    ok(await w.adminA.post(`${R}/vehicle_inventory/exports`, { json: { format: 'csv' }, headers }));
    const clash = await w.adminA.post(`${R}/areas/exports`, { json: { format: 'csv' }, headers });
    expect(clash.status).toBe(409);
  });

  it('R · la creación y cada descarga quedan en audit con el actor, sin el contenido', async () => {
    const job = await exportOf('csv');
    ok(await w.adminA.get(`${E}/${job.id}/download`));
    await tick(w.fleet.platformA);
    await relayAudit(w);
    const audit = ok(await w.adminA.get('/api/v1/audit?limit=100')).json.items as {
      action: string;
    }[];
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('export.completed:vehicle_inventory:csv');
    expect(actions).toContain('export.downloaded:vehicle_inventory:csv');
    // Las entradas del export no llevan el contenido de las filas (solo informe, formato y actor).
    const mine = audit.filter((entry) => entry.action.startsWith('export.'));
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain('HYPERLINK');
  });

  it('I · sin URL firmada, sin PII ni costos en el informe y sin eco del id ajeno', async () => {
    const job = await exportOf('csv');
    expect(JSON.stringify(job)).not.toMatch(/X-Amz|https?:\/\//);
    const download = ok(await w.adminA.get(`${E}/${job.id}/download`));
    expect(String(download.headers['content-disposition'])).toContain('attachment');
    expect(String(download.headers['cache-control'])).toContain('no-store');
    expect(String(download.headers['x-content-type-options'])).toBe('nosniff');
    // El informe de conductores no ofrece la identificación personal como columna.
    const catalog = ok(await w.adminA.get(R)).json.reports as {
      id: string;
      columns: { id: string }[];
    }[];
    const drivers = catalog.find((r) => r.id === 'drivers');
    expect(drivers?.columns.map((c) => c.id)).not.toEqual(expect.arrayContaining(['nationalId']));
    // Un id ajeno o con forma de ruta es un 404/400 uniforme.
    for (const id of ['00000000-0000-4000-8000-000000000000', '..%2F..%2Fetc%2Fpasswd'])
      expect((await w.adminB.get(`${E}/${id}/download`)).status).toBeGreaterThanOrEqual(400);
  });

  it('D · los parámetros desmedidos se rechazan antes de generar nada', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `col${i}`);
    for (const json of [
      { format: 'csv', columns: many },
      { format: 'csv', columns: [] },
    ]) {
      expect(
        (await w.adminA.post(`${R}/vehicle_inventory/exports`, { json, headers: key() })).status,
      ).toBe(400);
    }
    expect((await w.adminA.get(`${R}/vehicle_inventory/preview?limit=1000000`)).status).toBe(400);
    expect((await w.adminA.get(`${E}?limit=abc`)).status).toBe(400);
    const badKey = await w.adminA.post(`${R}/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      headers: { 'idempotency-key': 'corta' },
    });
    expect(badKey.status).toBe(400);
  });

  it('E · quien no tiene permiso de exportar no crea ni descarga, ni siquiera el trabajo de otro', async () => {
    const job = await exportOf('csv');
    const attempt = await w.viewerA.post(`${R}/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      headers: key(),
    });
    expect(attempt.status).toBe(403);
    const download = await w.viewerA.get(`${E}/${job.id}/download`);
    expect([403, 404]).toContain(download.status);
    // El informe de bitácora exige view_audit: el editor no lo exporta.
    const audit = await w.editorA.post(`${R}/audit_log/exports`, {
      json: { format: 'csv' },
      headers: key(),
    });
    expect(audit.status).toBe(403);
  });
});
