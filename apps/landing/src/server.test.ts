import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LandingConfig } from './config.js';
import { startLanding } from './server.js';
import { createFileLeadStore, type LeadStore } from './store.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const lead = {
  nombre: 'Ana',
  empresa: 'Transportes del Norte',
  correo: 'ana@example.mx',
  flotilla: '21-50',
  acepto: true,
};
const auth = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  if (dir) await rm(dir, { recursive: true, force: true });
  server = undefined;
  dir = undefined;
});

async function start(
  options: Partial<LandingConfig> = {},
  extra: { store?: LeadStore; fetch?: typeof fetch; now?: () => number } = {},
) {
  dir = await mkdtemp(join(tmpdir(), 'landing-'));
  const lines: string[] = [];
  const store = extra.store ?? createFileLeadStore(join(dir, 'leads.jsonl'));
  server = await startLanding({
    config: {
      host: '127.0.0.1',
      port: 0,
      publicDir,
      leadsFile: join(dir, 'leads.jsonl'),
      ...options,
    },
    store,
    log: (line) => lines.push(line),
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, store, lines };
}

const postJson = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('landing server', () => {
  it('serves the page with security headers, and the health check', async () => {
    const { base } = await start({ contactEmail: 'ventas@example.mx' });
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Solicitar demo');
    const css = await fetch(`${base}/styles.css`);
    expect(css.headers.get('cache-control')).toContain('max-age');
    const privacy = await (await fetch(`${base}/privacidad.html`)).text();
    expect(privacy).toContain('mailto:ventas@example.mx');
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
  });

  it('falls back to the form as contact without an email, and answers 404 pages', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/privacidad.html`)).text()).toContain(
      'el formulario de contacto',
    );
    for (const path of [
      '/nope.html',
      '/../package.json',
      '/%2e%2e/package.json',
      '/%E0%A4%A',
      '/x.exe',
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
    }
    expect(await (await fetch(`${base}/nope.html`)).text()).toContain('No encontramos');
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${base}/api/leads`)).status).toBe(405);
  });

  it('answers 404 in plain text when the 404 page is missing', async () => {
    const { base } = await start({ publicDir: '/nonexistent-landing-dir' });
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('No encontrado');
  });

  it('stores a JSON request and notifies the webhook', async () => {
    const hook = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));
    const { base, store, lines } = await start(
      { notifyUrl: 'https://hooks.example.com/x' },
      { fetch: hook },
    );
    const response = await postJson(base, { ...lead, empresa: '<!channel> @everyone & Co' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(await store.list()).toMatchObject([{ nombre: 'Ana', flotilla: '21-50' }]);
    expect(lines).toContain('lead_saved');
    expect(hook).toHaveBeenCalledOnce();
    const body = JSON.parse(String(hook.mock.calls[0]?.[1]?.body)) as {
      text: string;
      allowed_mentions: unknown;
    };
    expect(body.text).toContain('&lt;!channel&gt; @\u200beveryone &amp; Co');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    await vi.waitFor(() => expect(lines).toContain('notify_failed status 500'));
  });

  it('logs a webhook network failure without failing the request', async () => {
    const hook = vi.fn<typeof fetch>(async () => Promise.reject(new Error('down')));
    const { base, lines } = await start(
      { notifyUrl: 'https://hooks.example.com/x' },
      { fetch: hook },
    );
    expect((await postJson(base, lead)).status).toBe(201);
    await vi.waitFor(() => expect(lines).toContain('notify_failed network'));
  });

  it('accepts the no-JavaScript form post and redirects', async () => {
    const { base, store } = await start();
    const form = new URLSearchParams({ ...lead, acepto: 'on' });
    const ok = await fetch(`${base}/api/leads`, { method: 'POST', body: form, redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/gracias.html');
    const bad = await fetch(`${base}/api/leads`, {
      method: 'POST',
      body: new URLSearchParams({ nombre: 'x' }),
      redirect: 'manual',
    });
    expect(bad.headers.get('location')).toBe('/?error=campos#contacto');
    expect(await store.list()).toHaveLength(1);
  });

  it('rejects invalid, malformed, oversized and unsupported requests', async () => {
    const { base, store } = await start();
    const invalid = await postJson(base, { ...lead, correo: 'x' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: 'campos', fields: ['correo'] });
    const malformed = await fetch(`${base}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect((await postJson(base, [lead])).status).toBe(400);
    expect((await postJson(base, null)).status).toBe(400);
    expect((await postJson(base, { ...lead, mensaje: 'x'.repeat(20_000) })).status).toBe(413);
    const text = await fetch(`${base}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hola',
      redirect: 'manual',
    });
    expect(text.headers.get('location')).toBe('/?error=formato#contacto');
    expect(await store.list()).toEqual([]);
  });

  it('pretends to accept a bot without storing it', async () => {
    const { base, store } = await start();
    expect((await postJson(base, { ...lead, sitio: 'spam' })).status).toBe(201);
    expect(await store.list()).toEqual([]);
  });

  it('limits requests per client address', async () => {
    const { base, store } = await start();
    for (let i = 0; i < 5; i += 1)
      expect((await postJson(base, lead, { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' })).status).toBe(
        201,
      );
    const limited = await postJson(base, lead, { 'x-forwarded-for': '2.2.2.2, 9.9.9.9' });
    expect(limited.status).toBe(429);
    expect((await postJson(base, lead, { 'x-forwarded-for': '9.9.9.8' })).status).toBe(201);
    expect(await store.list()).toHaveLength(6);
  });

  it('caps all visitors together and frees the window over time', async () => {
    let now = 0;
    const { base } = await start({}, { now: () => now });
    for (let i = 0; i < 200; i += 1)
      expect(
        (await postJson(base, lead, { 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` })).status,
      ).toBe(201);
    expect((await postJson(base, lead, { 'x-forwarded-for': '10.9.9.9' })).status).toBe(429);
    now = 16 * 60 * 1000;
    expect((await postJson(base, lead, { 'x-forwarded-for': '10.9.9.9' })).status).toBe(201);
  });

  it('answers 500 when the store fails', async () => {
    const store: LeadStore = {
      save: () => Promise.reject(new Error('disk full')),
      list: () => Promise.resolve([]),
    };
    const { base, lines } = await start({}, { store });
    const response = await postJson(base, lead);
    expect(response.status).toBe(500);
    expect(lines).toContain('request_failed');
  });

  it('hides the admin pages without a password', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/admin/leads`)).status).toBe(404);
  });

  it('protects the admin list and CSV with basic auth', async () => {
    const password = 'una-clave-larga-123';
    const { base } = await start({ adminPassword: password });
    expect((await postJson(base, { ...lead, nombre: '<b>Ana</b>' })).status).toBe(201);
    const anonymous = await fetch(`${base}/admin/leads`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Basic');
    expect(
      (
        await fetch(`${base}/admin/leads`, {
          headers: { authorization: auth('mala-clave-123456') },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/admin/leads`, { headers: { authorization: 'Bearer x' } })).status,
    ).toBe(401);
    const page = await fetch(`${base}/admin/leads`, { headers: { authorization: auth(password) } });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(html).toContain('21 a 50');
    expect(html).toContain('1 solicitud');
    const csv = await fetch(`${base}/admin/leads.csv`, {
      headers: { authorization: auth(password) },
    });
    expect(csv.headers.get('content-disposition')).toContain('solicitudes-opslog.csv');
    expect(await csv.text()).toContain('ana@example.mx');
  });

  it('shows an empty admin list', async () => {
    const password = 'una-clave-larga-123';
    const { base } = await start({ adminPassword: password });
    const html = await (
      await fetch(`${base}/admin/leads`, { headers: { authorization: auth(password) } })
    ).text();
    expect(html).toContain('Todavía no hay solicitudes');
  });
});
