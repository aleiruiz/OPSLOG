import { afterAll, beforeAll, expect, it } from 'vitest';
import { acceptance, ok, startAcceptance, type AcceptanceWorld } from './support.js';

/**
 * Parte automatizable del checklist ASVS L2 (`asvs-l2.md`): lo que se puede afirmar por HTTP sobre la
 * pila real. Cada caso nombra los requisitos ASVS 4.0.3 que cubre. Lo que no se puede comprobar aquí
 * (TLS real, KMS, SES, WAF, pruebas de penetración) queda marcado en el checklist, no se simula.
 */
acceptance('ASVS L2 · controles verificables por HTTP', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  beforeAll(async () => {
    w = await startAcceptance();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  it('V3.4.1-V3.4.3 · la cookie de sesión es Secure, HttpOnly y SameSite', async () => {
    const browser = w.fleet.worldA.browser();
    await w.fleet.worldA.prepare(browser);
    const login = await browser.post('/api/auth/login', {
      json: w.fleet.worldA.credentials('subject-admin-a'),
    });
    expect(login.status).toBe(200);
    const cookie = login.setCookies.find((line) => line.startsWith('opslog_session='));
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=(Lax|Strict)/i);
    expect(login.json.token ?? login.json.sessionToken).toBeUndefined();
  });

  it('V3.2.1 y V3.3.1 · cada inicio de sesión emite un token nuevo y el cierre lo invalida', async () => {
    const first = await w.fleet.worldA.loginAs('subject-admin-a');
    const second = await w.fleet.worldA.loginAs('subject-admin-a');
    expect(first.jar.get('opslog_session')).not.toEqual(second.jar.get('opslog_session'));
    const stale = second.jar.get('opslog_session') as string;
    ok(await second.get('/api/vehicles'));
    ok(await second.post('/api/auth/logout', { json: {} }), [200, 204]);
    // El mismo token, reenviado a mano después del cierre, ya no sirve (V3.3.1).
    const replay = await second.get('/api/vehicles', { cookieHeader: `opslog_session=${stale}` });
    expect(replay.status).toBe(401);
  });

  it('V14.4 · las respuestas del API llevan cabeceras de seguridad y no se cachean', async () => {
    const reply = ok(await w.adminA.get('/api/auth/session'));
    expect(String(reply.headers['x-content-type-options'])).toBe('nosniff');
    expect(String(reply.headers['strict-transport-security'])).toMatch(/max-age=\d{7,}/);
    expect(String(reply.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(reply.headers['x-frame-options'])).toBe('DENY');
    expect(String(reply.headers['referrer-policy'])).toBe('no-referrer');
    expect(String(reply.headers['cache-control'])).toContain('no-store');
    expect(String(reply.headers['content-type'])).toContain('application/json');
  });

  it('V7.4 y V13.1 · los errores son uniformes: código, mensaje genérico y correlación, sin trazas ni rutas', async () => {
    const replies = [
      await w.adminA.get('/api/vehicles/00000000-0000-4000-8000-000000000000'),
      await w.adminA.get('/api/no-existe'),
      await w.adminA.post('/api/vehicles', { json: { nada: true } }),
      await w.adminA.post('/api/vehicles', { raw: '{"roto":', contentType: 'application/json' }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(reply.status).toBeLessThan(500);
      expect(Object.keys(reply.json ?? {}).sort()).toEqual(
        expect.arrayContaining(['code', 'correlationId', 'message', 'status']),
      );
      expect(reply.text).not.toMatch(
        /\bat\s.+\(.+:\d+:\d+\)|node_modules|\/home\/|SELECT |ER_[A-Z_]+/,
      );
    }
  });

  it('V5.1 · el cuerpo con claves desconocidas, tipo de contenido ajeno o tamaño excesivo se rechaza', async () => {
    const unknownKey = await w.adminA.post('/api/areas', {
      json: {
        name: 'Extra',
        code: null,
        parentId: null,
        responsibleIds: [],
        tenantId: w.fleet.tenantB,
      },
    });
    expect(unknownKey.status).toBe(400);
    const wrongType = await w.adminA.post('/api/areas', {
      raw: 'name=Extra',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    const huge = await w.adminA.post('/api/areas', {
      raw: JSON.stringify({ name: 'x'.repeat(5 * 1024 * 1024) }),
    });
    expect([400, 413]).toContain(huge.status);
  });

  it('V4.1 y V4.2 · el control de acceso se evalúa en el servidor: la UI no decide y el id ajeno es 404', async () => {
    // Un viewer no escribe aunque la petición sea válida (V4.1.1) y no distingue "no existe" de "ajeno".
    const denied = await w.viewerA.post('/api/areas', {
      json: { name: 'Sin permiso', code: null, parentId: null, responsibleIds: [] },
    });
    expect(denied.status).toBe(403);
    const unknown = await w.adminB.get('/api/vehicles/00000000-0000-4000-8000-000000000001');
    const foreignArea = await w.fleet.area(w.adminA, 'Área solo de A');
    const foreign = await w.adminB.get(`/api/areas/${foreignArea}`);
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(Object.keys(foreign.json).sort()).toEqual(Object.keys(unknown.json).sort());
  });

  it('V2.2.1 · los fallos repetidos de inicio de sesión no revelan si la identidad existe', async () => {
    const browser = w.fleet.worldA.browser();
    await w.fleet.worldA.prepare(browser);
    const statuses = new Set<number>();
    const bodies = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const reply = await browser.post('/api/auth/login', {
        json: { code: `codigo-invalido-${i}`, nonce: `n-${i}` },
      });
      statuses.add(reply.status);
      bodies.add(`${reply.json?.code}|${reply.json?.message}`);
    }
    expect(Math.min(...statuses)).toBeGreaterThanOrEqual(400);
    expect(bodies.size).toBe(1);
  });
});
