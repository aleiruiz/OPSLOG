import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  SafeWebhookClient,
  verifyWebhook,
  type Resolver,
  type Transport,
  type TransportRequest,
} from '../../packages/platform/webhooks/src/index.js';
import {
  acceptance,
  ok,
  relayAudit,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

const W = '/api/v1/webhooks/endpoints';

/**
 * STRIDE corto de los webhooks salientes (MVP-WEBHOOKS, SPECS §4.3 y §7): un caso negativo por
 * amenaza. El cliente es el `SafeWebhookClient` real (guardia SSRF, firma, sin redirecciones) con DNS
 * y transporte sintéticos; el receptor verifica la firma como lo documenta el producto. Mapa en
 * `stride.md`.
 */
acceptance('STRIDE · webhooks salientes', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  let area: string;
  const dns = new Map<string, string>();
  const connections: TransportRequest[] = [];
  let answer = 200;
  const resolve: Resolver = async (host) => [
    { address: dns.get(host) ?? '93.184.216.34', family: 4 },
  ];
  const transport: Transport = async (request) => {
    connections.push(request);
    return { status: answer };
  };

  beforeAll(async () => {
    w = await startAcceptance({
      webhookClientA: new SafeWebhookClient({ resolve, transport }),
      webhookResolverA: resolve,
    });
    area = await w.fleet.area(w.adminA, 'Flota webhooks');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  // Cada caso parte sin endpoints para no depender del orden ni del límite de cinco por empresa.
  afterEach(async () => {
    const list = await w.adminA.get(W);
    for (const item of (list.json?.items ?? []) as { id: string }[])
      await w.adminA.delete(`${W}/${item.id}`);
    dns.clear();
    answer = 200;
  });

  const create = async (url: string, events = ['vehicle.created']) =>
    w.adminA.post(W, { json: { url, events } });
  const deliver = async () => {
    await tick(w.fleet.platformA, 'webhooks.dispatch');
  };

  it('S · sin sesión no se registra nada y un emisor sin el secreto no pasa la verificación del receptor', async () => {
    expect(
      (
        await w.fleet.worldA
          .browser()
          .post(W, { json: { url: 'https://h.example.com/x', events: ['vehicle.created'] } })
      ).status,
    ).toBe(401);
    const made = ok(await create('https://hooks.spoof.example.com/in'), 201);
    const secret = made.json.secret as string;
    connections.length = 0;
    await w.fleet.vehicle(w.adminA, area, tag('SP'));
    await deliver();
    const sent = connections.find((c) => c.hostname === 'hooks.spoof.example.com');
    expect(sent, 'no hubo entrega').toBeTruthy();
    const headers = sent?.headers ?? {};
    const input = { headers, body: sent?.body ?? new Uint8Array(), nowMs: Date.now() };
    expect(verifyWebhook({ ...input, secrets: [secret] })).toMatchObject({ ok: true });
    // Un tercero que no conoce el secreto no puede producir una firma que el receptor acepte.
    expect(verifyWebhook({ ...input, secrets: ['whsec_secreto-equivocado'] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('T · alterar el cuerpo, la marca de tiempo o repetir el evento hace fallar la verificación', async () => {
    const made = ok(await create('https://hooks.tamper.example.com/in'), 201);
    const secret = made.json.secret as string;
    connections.length = 0;
    await w.fleet.vehicle(w.adminA, area, tag('TM'));
    await deliver();
    const sent = connections.find((c) => c.hostname === 'hooks.tamper.example.com');
    expect(sent).toBeTruthy();
    const headers = sent?.headers ?? {};
    const body = Buffer.from(sent?.body ?? []);
    const nowMs = Date.now();
    expect(verifyWebhook({ secrets: [secret], headers, body, nowMs })).toMatchObject({ ok: true });
    const altered = Buffer.from(body.toString('utf8').replace('vehicle', 'vehicLe'));
    expect(verifyWebhook({ secrets: [secret], headers, body: altered, nowMs })).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    // Un mensaje capturado y repetido horas después cae por la ventana de tiempo.
    expect(
      verifyWebhook({ secrets: [secret], headers, body, nowMs: nowMs + 6 * 60_000 }),
    ).toMatchObject({ ok: false, reason: 'stale_timestamp' });
    // Y repetido dentro de la ventana, por el id de evento ya visto.
    expect(
      verifyWebhook({ secrets: [secret], headers, body, nowMs, seen: () => true }),
    ).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('R · alta, rotación y baja del endpoint quedan en audit con el actor', async () => {
    const made = ok(await create('https://hooks.audit.example.com/in'), 201);
    const id = made.json.endpoint.id as string;
    ok(
      await w.adminA.post(`${W}/${id}/rotate-secret`, {
        json: { version: made.json.endpoint.version },
      }),
    );
    expect((await w.adminA.delete(`${W}/${id}`)).status).toBe(204);
    await tick(w.fleet.platformA);
    await relayAudit(w);
    const audit = ok(await w.adminA.get('/api/v1/audit?limit=100')).json.items as {
      action: string;
      entityId: string;
    }[];
    const mine = audit.filter((entry) => entry.entityId === id).map((entry) => entry.action);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine.join(' ')).toMatch(/webhook/);
    expect(JSON.stringify(audit)).not.toContain('whsec_');
  });

  it('I · el secreto se muestra una vez, no se vuelve a leer y el payload no lleva PII, importes ni empresa', async () => {
    const made = ok(await create('https://hooks.leak.example.com/in'), 201);
    const secret = made.json.secret as string;
    const id = made.json.endpoint.id as string;
    expect(secret).toMatch(/^whsec_/);
    const plate = `FL${tag('LK')}`;
    connections.length = 0;
    const vehicle = ok(
      await w.adminA.post('/api/vehicles', {
        json: {
          economicNumber: `ECO-${tag('EC')}`,
          plate,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId: area,
          odometerKm: 5,
        },
      }),
      201,
    );
    await deliver();
    const sent = connections.find((c) => c.hostname === 'hooks.leak.example.com');
    const payload = Buffer.from(sent?.body ?? []).toString('utf8');
    expect(payload).toContain(vehicle.json.id);
    for (const forbidden of [plate, w.fleet.tenantA, '@', 'amount'])
      expect(payload).not.toContain(forbidden);
    for (const read of [
      await w.adminA.get(`${W}/${id}`),
      await w.adminA.get(W),
      await w.adminA.get(`${W}/${id}/deliveries`),
    ])
      expect(read.text).not.toContain(secret);
    const stored = JSON.stringify(await w.database.rows('SELECT * FROM opslog_webhook_endpoints'));
    expect(stored).not.toContain(secret);
  });

  it('D · SSRF: destinos no públicos se rechazan al registrar, el rebinding de DNS al enviar y las redirecciones no se siguen', async () => {
    for (const url of [
      'http://hooks.example.com/in',
      'https://127.0.0.1/in',
      'https://localhost/in',
      'https://10.0.0.5/in',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/in',
      'https://2130706433/in',
      'https://user:pass@hooks.example.com/in',
      'https://hooks.example.com:8443/in',
      'https://service.internal/in',
      'file:///etc/passwd',
    ]) {
      const reply = await create(url);
      expect(reply.status, url).toBeGreaterThanOrEqual(400);
      expect(reply.status, url).toBeLessThan(500);
    }
    // Rebinding: el nombre era público al registrar y ahora resuelve a metadatos de la nube.
    const made = ok(await create('https://rebind.example.com/in'), 201);
    const id = made.json.endpoint.id as string;
    dns.set('rebind.example.com', '169.254.169.254');
    connections.length = 0;
    await w.fleet.vehicle(w.adminA, area, tag('RB'));
    await deliver();
    expect(connections.some((c) => c.hostname === 'rebind.example.com')).toBe(false);
    const history = ok(await w.adminA.get(`${W}/${id}/deliveries`)).json.items[0];
    expect(history.status).not.toBe('delivered');
    // Una redirección es un fallo, no un salto a otro destino.
    dns.delete('rebind.example.com');
    const redirect = ok(await create('https://redirect.example.com/in'), 201);
    answer = 302;
    await w.fleet.vehicle(w.adminA, area, tag('RD'));
    await deliver();
    answer = 200;
    const redirected = ok(await w.adminA.get(`${W}/${redirect.json.endpoint.id}/deliveries`)).json
      .items[0];
    expect(redirected.status).not.toBe('delivered');
    expect(connections.filter((c) => c.hostname === 'redirect.example.com').length).toBeGreaterThan(
      0,
    );
  });

  it('D · el límite de endpoints por empresa corta el abuso', async () => {
    expect(ok(await w.adminA.get(W)).json.items).toHaveLength(0);
    let refused = 0;
    for (let i = 0; i < 8; i += 1) {
      const reply = await create(`https://limit${i}.example.com/in`);
      if (reply.status >= 400) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    const listed = ok(await w.adminA.get(W)).json;
    expect(listed.items.length).toBe(listed.max);
    expect(refused).toBe(8 - listed.max);
  });

  it('E · editor, consulta y auditor no gestionan integraciones; solo quien tiene integrations:manage', async () => {
    const made = ok(await create('https://hooks.elevate.example.com/in'), 201);
    const id = made.json.endpoint.id as string;
    for (const who of [w.editorA, w.viewerA, w.auditorA]) {
      expect((await who.get(W)).status).toBe(403);
      expect(
        (
          await who.post(W, {
            json: { url: 'https://x.example.com/in', events: ['vehicle.created'] },
          })
        ).status,
      ).toBe(403);
      expect((await who.post(`${W}/${id}/test`, { json: {} })).status).toBe(403);
      expect((await who.delete(`${W}/${id}`)).status).toBe(403);
    }
  });
});
