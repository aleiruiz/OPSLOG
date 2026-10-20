import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  acceptance,
  dayFrom,
  ok,
  reindex,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

const S = '/api/v1/search';

/**
 * STRIDE corto de la búsqueda global (MVP-SEARCH, FR-160, SPECS §2.3 D23 y §4.3): un caso negativo
 * por amenaza sobre la proyección MySQL real. Mapa en `stride.md`.
 */
acceptance('STRIDE · búsqueda global', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  let vehicleId: string;
  let driverId: string;
  const unit = tag('SX');
  const license = `LIC-STR-${tag('L')}`;
  const nationalId = `SYNTH-NID-${tag('N')}`;

  const find = async (browser: typeof w.adminA, q: string, extra = '') =>
    browser.get(`${S}?q=${encodeURIComponent(q)}${extra}`);
  const idsOf = (reply: { json: any }, type: string): string[] =>
    ((reply.json?.groups ?? []) as { type: string; items: { id: string }[] }[])
      .find((g) => g.type === type)
      ?.items.map((i) => i.id) ?? [];

  beforeAll(async () => {
    w = await startAcceptance();
    const area = await w.fleet.area(w.adminA, 'Flota búsqueda');
    vehicleId = await w.fleet.vehicle(w.adminA, area, unit);
    // Otros vehículos con el mismo prefijo «FL»: si un comodín o un operador se filtrara, listaría
    // a todos y la comprobación de la prueba T fallaría.
    for (let i = 0; i < 3; i += 1) await w.fleet.vehicle(w.adminA, area, tag('SY'));
    driverId = ok(
      await w.adminA.post('/api/employees', {
        json: {
          kind: 'driver',
          firstName: 'Beatriz',
          lastName: 'Buscada',
          areaId: area,
          employeeNumber: `EMP-${unit}`,
          idType: 'ine',
          nationalId,
          licenseNumber: license,
          licenseType: 'c',
          licenseExpiresOn: dayFrom(400),
        },
      }),
      201,
    ).json.id as string;
    await tick(w.fleet.platformA);
    await reindex(w.fleet.platformA, w.fleet.tenantA);
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  it('S · sin sesión o con cookie falsa la búsqueda no responde datos', async () => {
    const anonymous = w.fleet.worldA.browser();
    expect((await find(anonymous, `FL${unit}`)).status).toBe(401);
    const forged = w.fleet.worldA.browser();
    forged.jar.set('opslog_session', 'sesion-falsa-0123456789abcdef');
    expect((await find(forged, `FL${unit}`)).status).toBe(401);
  });

  it('T · metacaracteres SQL, comodines y operadores FULLTEXT se tratan como texto y no amplían el resultado', async () => {
    const baseline = idsOf(await find(w.adminA, `FL${unit}`), 'vehicle');
    expect(baseline).toEqual([vehicleId]);
    // Control: el prefijo «FL» sí alcanza a todos los vehículos sembrados, así que un comodín filtrado se vería.
    expect(idsOf(await find(w.adminA, 'FL'), 'vehicle').length).toBeGreaterThanOrEqual(4);
    for (const q of [
      "' OR '1'='1",
      `${unit}'; DROP TABLE opslog_search_entries; --`,
      '%',
      '_',
      '%%%%',
      '+FL* -zzz',
      '"FL" >x <y ~z',
      '\\',
    ]) {
      const reply = await find(w.adminA, q);
      expect(reply.status, q).toBeLessThan(500);
      // Nunca devuelve más que lo que el texto literal permite: un comodín no lista la flota sembrada.
      const vehicles = idsOf(reply, 'vehicle');
      expect(
        vehicles.filter((id) => id !== vehicleId),
        q,
      ).toEqual([]);
    }
    // Los paréntesis se descartan al normalizar: «(FL)» equivale al texto «FL», ni más ni menos.
    const plain = idsOf(await find(w.adminA, 'FL'), 'vehicle').sort();
    expect(idsOf(await find(w.adminA, '(FL)'), 'vehicle').sort()).toEqual(plain);
    // La tabla sigue ahí y la búsqueda normal sigue funcionando.
    expect(idsOf(await find(w.adminA, `FL${unit}`), 'vehicle')).toEqual([vehicleId]);
  });

  it('R · la búsqueda no escribe ni cambia datos: leerla no deja filas nuevas en el negocio', async () => {
    const before = await w.database.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM opslog_vehicles',
    );
    for (let i = 0; i < 3; i += 1) await find(w.adminA, `FL${unit}`);
    const after = await w.database.rows<{ n: number }>('SELECT COUNT(*) AS n FROM opslog_vehicles');
    expect(after).toEqual(before);
    // Los parámetros extra (incluida una empresa) son un 400, no una escritura ni un cambio de alcance.
    expect((await find(w.adminA, `FL${unit}`, `&tenantId=${w.fleet.tenantA}`)).status).toBe(400);
    expect((await find(w.adminA, `FL${unit}`, '&types=vehicle,vehicle')).status).toBe(400);
    expect((await find(w.adminA, `FL${unit}`, '&types=nope')).status).toBe(400);
  });

  it('I · la PII solo aparece por coincidencia exacta con view_pii, nunca en la respuesta ni en el índice', async () => {
    expect(idsOf(await find(w.adminA, license), 'driver')).toEqual([driverId]);
    expect(idsOf(await find(w.adminA, license.slice(0, 10)), 'driver')).toEqual([]);
    expect(idsOf(await find(w.adminA, nationalId), 'driver')).toEqual([driverId]);
    // Sin view_pii la licencia exacta no halla nada, ni el conductor ni un rastro.
    const blind = await find(w.viewerA, license);
    expect(idsOf(blind, 'driver')).toEqual([]);
    const exact = await find(w.adminA, license);
    expect(exact.text).not.toContain(license);
    expect(exact.text).not.toContain(nationalId);
    const stored = JSON.stringify(await w.database.rows('SELECT * FROM opslog_search_entries'));
    expect(stored).not.toContain(license);
    expect(stored).not.toContain(nationalId);
    // Otra empresa no halla nada, ni por la licencia exacta.
    expect((await find(w.adminB, license)).json.groups.flatMap((g: any) => g.items)).toEqual([]);
  });

  it('D · un término desmedido, vacío o repetido se rechaza antes de tocar el índice', async () => {
    for (const q of ['', '   ', 'a'.repeat(5000)]) {
      const reply = await find(w.adminA, q);
      expect(reply.status, q.slice(0, 10)).toBe(400);
    }
    const repeated = await w.adminA.get(`${S}?q=a&q=b`);
    expect(repeated.status).toBe(400);
    // El reloj de la prueba está congelado (`vi.setSystemTime`): se mide con `performance.now()`.
    const started = performance.now();
    const wide = await find(w.adminA, '%'.repeat(200));
    expect(wide.status).toBeLessThan(500);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('E · quien no ve un tipo no recibe sus resultados, ni su conteo, aunque lo pida por nombre', async () => {
    // El auditor ve la flota pero no tiene incidents:view: el grupo de siniestros ni se devuelve.
    const named = await find(w.auditorA, `FL${unit}`, '&types=incident');
    expect(named.status).toBe(200);
    expect(named.json.groups).toEqual([]);
    const all = await find(w.auditorA, `FL${unit}`);
    expect(all.status).toBe(200);
    expect((all.json.groups as { type: string }[]).map((g) => g.type)).not.toContain('incident');
    // Quien solo consulta no ve conductores por PII exacta aunque conozca el dato.
    expect(idsOf(await find(w.viewerA, nationalId), 'driver')).toEqual([]);
  });
});
