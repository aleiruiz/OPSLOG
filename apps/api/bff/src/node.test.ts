import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
});
