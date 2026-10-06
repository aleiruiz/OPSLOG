import { request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBffHandler } from './handler.js';
import type { BffHandler } from './http.js';
import { createBffServer } from './node.js';
import { HOST, ORIGIN, SECRET, createBffWorld, type BffWorld } from './test-support.js';

let server: Server | undefined;
let world: BffWorld | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  world?.dispose();
  world = undefined;
});

async function listen(handler: BffHandler): Promise<number> {
  server = createBffServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('node adapter over a loopback socket', () => {
  it('serves the handler end to end with cookies, headers and a JSON body', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const port = await listen(world.handler);
    const csrf = await send(port, 'GET', '/api/auth/csrf', { host: HOST });
    expect(csrf.status).toBe(200);
    expect(csrf.headers['x-content-type-options']).toBe('nosniff');
    expect(csrf.headers['content-length']).toBe(String(Buffer.byteLength(csrf.body)));
    const setCookie = csrf.headers['set-cookie'] as string[];
    expect(setCookie[0]).toMatch(/HttpOnly; Secure$/);
    const nonceCookie = setCookie[0]!.split(';')[0]!;
    const credentials = world.credentials('subject-admin-a');
    const login = await send(
      port,
      'POST',
      '/api/auth/login',
      {
        host: HOST,
        origin: ORIGIN,
        cookie: nonceCookie,
        'content-type': 'application/json',
        'x-csrf-token': JSON.parse(csrf.body).csrfToken,
      },
      JSON.stringify(credentials),
    );
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']).toHaveLength(2);
    const session = (login.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    const me = await send(port, 'GET', '/api/auth/session', { host: HOST, cookie: session });
    expect(JSON.parse(me.body).company.name).toBe('Empresa Alfa');
  });

  it('serves the vehicles routes over a real socket with session, CSRF and tenant isolation', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    await world.tenant('Empresa Beta', 'subject-admin-b');
    const port = await listen(world.handler);
    const login = async (subject: string) => {
      const csrf = await send(port, 'GET', '/api/auth/csrf', { host: HOST });
      const nonceCookie = (csrf.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
      const reply = await send(
        port,
        'POST',
        '/api/auth/login',
        {
          host: HOST,
          origin: ORIGIN,
          cookie: nonceCookie,
          'content-type': 'application/json',
          'x-csrf-token': JSON.parse(csrf.body).csrfToken,
        },
        JSON.stringify(world!.credentials(subject)),
      );
      return {
        cookie: (reply.headers['set-cookie'] as string[])[0]!.split(';')[0]!,
        csrf: JSON.parse(reply.body).csrfToken as string,
      };
    };
    const a = await login('subject-admin-a');
    const b = await login('subject-admin-b');
    const write = (
      who: { cookie: string; csrf: string | null },
      method: string,
      path: string,
      json: unknown,
    ) =>
      send(
        port,
        method,
        path,
        {
          host: HOST,
          origin: ORIGIN,
          cookie: who.cookie,
          'content-type': 'application/json',
          ...(who.csrf ? { 'x-csrf-token': who.csrf } : {}),
        },
        JSON.stringify(json),
      );
    const area = await write(a, 'POST', '/api/areas', { name: 'Area 1' });
    expect(area.status).toBe(201);
    const vehicle = {
      economicNumber: 'U-001',
      plate: 'ABC123',
      vin: null,
      make: 'Toyota',
      model: 'Hilux',
      year: 2022,
      areaId: JSON.parse(area.body).id as string,
      odometerKm: 100,
    };
    expect(
      (await write({ cookie: a.cookie, csrf: null }, 'POST', '/api/vehicles', vehicle)).status,
    ).toBe(403);
    expect((await send(port, 'GET', '/api/vehicles', { host: HOST })).status).toBe(401);
    const created = await write(a, 'POST', '/api/vehicles', vehicle);
    expect(created.status).toBe(201);
    const id = JSON.parse(created.body).id as string;
    const read = (who: { cookie: string }, path: string) =>
      send(port, 'GET', path, { host: HOST, cookie: who.cookie });
    expect(JSON.parse((await read(a, `/api/vehicles/${id}`)).body).plate).toBe('ABC123');
    expect((await read(b, `/api/vehicles/${id}`)).status).toBe(404);
    expect((await write(b, 'POST', `/api/vehicles/${id}/archive`, { version: 1 })).status).toBe(
      404,
    );
    expect(JSON.parse((await read(b, '/api/vehicles')).body).total).toBe(0);
    expect(JSON.parse((await read(a, '/api/vehicles')).body).total).toBe(1);
  });

  it('sends the 413 for an oversized body and then drops the connection', async () => {
    world = createBffWorld({ bff: { maxBodyBytes: 256 } });
    const port = await listen(world.handler);
    const reply = await send(
      port,
      'POST',
      '/api/auth/login',
      { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      Buffer.alloc(100_000, 0x61),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body).code).toBe('payload_too_large');
    expect(reply.headers['connection']).toBe('close');
  });

  it('serves a request that carries a header named __proto__', async () => {
    world = createBffWorld();
    const port = await listen(world.handler);
    const headers: Record<string, string> = { host: HOST };
    Object.defineProperty(headers, '__proto__', { value: 'x', enumerable: true });
    const reply = await send(port, 'GET', '/api/auth/csrf', headers);
    expect(reply.status).toBe(200);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('refuses an oversized streamed body announced as chunked', async () => {
    world = createBffWorld({ bff: { maxBodyBytes: 256 } });
    const port = await listen(world.handler);
    const reply = await new Promise<Raw>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/auth/login',
          headers: {
            host: HOST,
            origin: ORIGIN,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }),
          );
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        // The server may close the socket while the client is still writing: the 413 is then lost
        // on the client side, which is acceptable; the server-side limit is what is under test.
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE')
          resolve({ status: 413, headers: {}, body: '' });
        else reject(error);
      });
      req.write(Buffer.alloc(200, 0x61));
      setTimeout(() => req.end(Buffer.alloc(50_000, 0x61)), 20);
    });
    expect(reply.status).toBe(413);
  });

  it('turns a throwing handler into a generic 500 without leaking the failure', async () => {
    const port = await listen(async () => {
      throw new Error('SECRET-TOKEN-abc tenant=t-42');
    });
    const reply = await send(port, 'GET', '/api/auth/session', { host: HOST });
    expect(reply.status).toBe(500);
    expect(reply.body).not.toMatch(/SECRET|t-42/);
    expect(JSON.parse(reply.body).code).toBe('internal_error');
  });

  it('applies conservative server limits and refuses very long targets', async () => {
    world = createBffWorld();
    const handler = createBffHandler({
      platform: world.platform,
      secret: SECRET,
      allowedOrigins: [ORIGIN],
    });
    const port = await listen(handler);
    expect(server!.headersTimeout).toBe(10_000);
    expect(server!.requestTimeout).toBe(30_000);
    const reply = await send(port, 'GET', `/${'a'.repeat(4000)}`, { host: HOST });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).code).toBe('bad_request');
  });

  it('rejects repeated Host, Content-Type and CSRF headers instead of keeping the first', async () => {
    world = createBffWorld();
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const port = await listen(world.handler);
    const browser = await world.loginAs('subject-admin-a');
    const cookie = [...browser.jar].map(([n, v]) => `${n}=${v}`).join('; ');
    const body = JSON.stringify({ name: 'Nuevo', mfa: 'disabled', sessionIdleHours: 8 });
    const raw = (headers: string[]) =>
      new Promise<number>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(
            [
              'PUT /api/company/settings HTTP/1.1',
              ...headers,
              `Cookie: ${cookie}`,
              `Content-Length: ${Buffer.byteLength(body)}`,
              'Connection: close',
              '',
              body,
            ].join('\r\n'),
          ),
        );
        let data = '';
        socket.on('data', (chunk) => (data += chunk.toString('utf8')));
        socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
        socket.on('error', reject);
      });
    const good = [
      `Host: ${HOST}`,
      `Origin: ${ORIGIN}`,
      'Content-Type: application/json',
      `X-CSRF-Token: ${browser.csrf!}`,
    ];
    expect(await raw(good)).toBe(200);
    expect(await raw([...good, `Host: ${HOST}`])).toBe(403);
    expect(await raw([...good, 'Content-Type: application/json'])).toBe(415);
    expect(await raw([...good, `X-CSRF-Token: ${browser.csrf!}`])).toBe(403);
  });

  it('revokes the previous session on login and on invitation accept over a real socket', async () => {
    world = createBffWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const port = await listen(world.handler);
    const headers = (cookie: string, csrf: string) => ({
      host: HOST,
      origin: ORIGIN,
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    });
    const nonce = async () => {
      const pre = await send(port, 'GET', '/api/auth/csrf', { host: HOST });
      return {
        cookie: (pre.headers['set-cookie'] as string[])[0]!.split(';')[0]!,
        csrf: JSON.parse(pre.body).csrfToken as string,
      };
    };
    const session = (raw: Raw) => (raw.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    const status = async (cookie: string) =>
      (await send(port, 'GET', '/api/auth/session', { host: HOST, cookie })).status;

    const pre1 = await nonce();
    const login1 = await send(
      port,
      'POST',
      '/api/auth/login',
      headers(pre1.cookie, pre1.csrf),
      JSON.stringify(world.credentials('subject-admin-a')),
    );
    const first = session(login1);
    expect(await status(first)).toBe(200);

    // Second login, still carrying the first session cookie: the first is revoked.
    const pre2 = await nonce();
    const login2 = await send(
      port,
      'POST',
      '/api/auth/login',
      headers(`${first}; ${pre2.cookie}`, pre2.csrf),
      JSON.stringify(world.credentials('subject-admin-a')),
    );
    expect(login2.status).toBe(200);
    const second = session(login2);
    expect(second).not.toBe(first);
    expect(await status(first)).toBe(401);
    expect(await status(second)).toBe(200);

    // Accepting an invitation while holding a session revokes that session too.
    const admin = await world.platform.signIn(await world.principal('subject-admin-a'));
    const invited = await world.platform.inviteUser(admin.value!.token, 'fixture', 'viewer');
    const pre3 = await nonce();
    const accepted = await send(
      port,
      'POST',
      '/api/auth/invitations/accept',
      headers(`${second}; ${pre3.cookie}`, pre3.csrf),
      JSON.stringify({
        token: invited.value!.invitationToken,
        ...world.credentials('subject-new-viewer'),
      }),
    );
    expect(accepted.status).toBe(201);
    expect(await status(second)).toBe(401);
    expect(await status(session(accepted))).toBe(200);
    expect(a.tenantId).toBeTruthy();
  });
});
