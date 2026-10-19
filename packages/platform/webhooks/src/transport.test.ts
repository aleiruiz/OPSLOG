import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeWebhookClient } from './client.js';
import { selfSigned, startReceiver, TEST_HOST, type Receiver } from './test-support.js';
import { httpsTransport, MAX_RESPONSE_BYTES } from './transport.js';

const credentials = selfSigned();
const suite = credentials ? describe : describe.skip;
const BODY = new TextEncoder().encode('{"id":"evt_1","type":"vehicle.created"}');

suite('https transport against a real TLS receiver', () => {
  let receiver: Receiver;
  let mode: 'ok' | 'redirect' | 'slow' | 'huge' = 'ok';
  const creds = credentials as { key: string; cert: string };
  beforeAll(async () => {
    receiver = await startReceiver(creds, (_req, res) => {
      if (mode === 'redirect') {
        res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' }).end();
      } else if (mode === 'slow') {
        // Never answers: the attempt must time out.
      } else if (mode === 'huge') {
        res.writeHead(200).end(Buffer.alloc(MAX_RESPONSE_BYTES * 4, 97));
      } else res.writeHead(200).end('ok');
    });
  });
  afterAll(async () => {
    await receiver.close();
  });
  const client = (timeoutMs = 10_000) =>
    new SafeWebhookClient({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: httpsTransport({ ca: creds.cert, port: receiver.port }),
      timeoutMs,
    });
  // The test resolver answers loopback only to prove the transport; the production guard refuses it
  // (see client.test.ts), so the real transport is exercised through its own entry point.
  const direct = (timeoutMs = 10_000, hostname = TEST_HOST) =>
    httpsTransport({ ca: creds.cert, port: receiver.port })({
      address: '127.0.0.1',
      family: 4,
      hostname,
      path: '/hook?a=1',
      headers: { 'Content-Type': 'application/json', 'OPSLOG-Event-Id': 'evt_1' },
      body: BODY,
      timeoutMs,
    });

  it('posts the exact bytes over verified TLS to the pinned address with the host as SNI', async () => {
    mode = 'ok';
    await expect(direct()).resolves.toEqual({ status: 200 });
    const got = receiver.requests.at(-1);
    expect(got?.body.equals(Buffer.from(BODY))).toBe(true);
    expect(got?.url).toBe('/hook?a=1');
    expect(got?.headers.host).toContain(TEST_HOST);
    expect(got?.headers['content-length']).toBe(String(BODY.length));
  });

  it('refuses a certificate that does not match the host name', async () => {
    mode = 'ok';
    await expect(direct(5000, 'other.example.com')).rejects.toMatchObject({ code: 'tls' });
  });

  it('refuses an untrusted certificate (no ca configured)', async () => {
    await expect(
      httpsTransport({ port: receiver.port })({
        address: '127.0.0.1',
        family: 4,
        hostname: TEST_HOST,
        path: '/',
        headers: {},
        body: BODY,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: 'tls' });
  });

  it('reports a redirect as such without following it', async () => {
    mode = 'redirect';
    const before = receiver.requests.length;
    const result = await new SafeWebhookClient({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (input) =>
        httpsTransport({ ca: creds.cert, port: receiver.port })({
          ...input,
          address: '127.0.0.1',
          hostname: TEST_HOST,
        }),
    }).send({
      url: `https://${TEST_HOST}/x`,
      eventId: 'evt_1',
      body: BODY,
      secrets: ['whsec_x'],
      timestamp: 1,
    });
    expect(result).toMatchObject({ status: 302, failure: 'redirect' });
    expect(receiver.requests.length).toBe(before + 1);
  });

  it('times out on a receiver that never answers', async () => {
    mode = 'slow';
    await expect(direct(300)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops reading a huge answer and still reports the status', async () => {
    mode = 'huge';
    await expect(direct()).resolves.toEqual({ status: 200 });
  });

  it('reports a refused connection as a connection failure', async () => {
    await expect(
      httpsTransport({ ca: creds.cert, port: 1 })({
        address: '127.0.0.1',
        family: 4,
        hostname: TEST_HOST,
        path: '/',
        headers: {},
        body: BODY,
        timeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ code: 'connection' });
  });

  it('the guarded client refuses a receiver that resolves to loopback before connecting', async () => {
    mode = 'ok';
    const before = receiver.requests.length;
    const result = await client().send({
      url: `https://${TEST_HOST}/x`,
      eventId: 'evt_9',
      body: BODY,
      secrets: ['whsec_x'],
      timestamp: 1_800_000_000,
    });
    expect(result).toMatchObject({ status: null, failure: 'private_address' });
    expect(receiver.requests.length).toBe(before);
  });
});
