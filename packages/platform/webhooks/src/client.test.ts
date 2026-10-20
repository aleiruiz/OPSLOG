import { describe, expect, it, vi } from 'vitest';
import { SafeWebhookClient } from './client.js';
import type { Resolver } from './guard.js';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from './signature.js';
import { TransportError, type Transport, type TransportRequest } from './transport.js';

const BODY = new TextEncoder().encode('{"id":"evt_1"}');
const request = (url = 'https://hooks.example.com/in?x=1') => ({
  url,
  eventId: 'evt_1',
  body: BODY,
  secrets: ['whsec_one', 'whsec_two'],
  timestamp: 1_800_000_000,
});
const pub: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

function harness(status: number | Error, resolve: Resolver = pub) {
  const seen: TransportRequest[] = [];
  const transport: Transport = async (input) => {
    seen.push(input);
    if (status instanceof Error) throw status;
    return { status };
  };
  let clock = 1000;
  const client = new SafeWebhookClient({
    resolve,
    transport,
    now: () => (clock += 25),
  });
  return { client, seen };
}

describe('SafeWebhookClient', () => {
  it('signs the exact bytes, pins the validated address and keeps SNI as the host', async () => {
    const { client, seen } = harness(204);
    const result = await client.send(request());
    expect(result).toEqual({ status: 204, durationMs: 25, failure: null });
    const sent = seen[0] as TransportRequest;
    expect(sent).toMatchObject({
      address: '93.184.216.34',
      family: 4,
      hostname: 'hooks.example.com',
      path: '/in?x=1',
      timeoutMs: 10_000,
    });
    expect(sent.headers[EVENT_ID_HEADER]).toBe('evt_1');
    expect(sent.headers[TIMESTAMP_HEADER]).toBe('1800000000');
    expect(
      verifyWebhook({
        secrets: ['whsec_two'],
        headers: sent.headers,
        body: sent.body,
        nowMs: 1_800_000_000_000,
      }).ok,
    ).toBe(true);
    expect(sent.headers[SIGNATURE_HEADER]?.split(',')).toHaveLength(2);
  });

  it('treats a 3xx as a failure and never follows it', async () => {
    const { client, seen } = harness(302);
    await expect(client.send(request())).resolves.toMatchObject({
      status: 302,
      failure: 'redirect',
    });
    expect(seen).toHaveLength(1);
  });

  it('reports other statuses and transport errors as codes only', async () => {
    await expect(harness(503).client.send(request())).resolves.toMatchObject({
      status: 503,
      failure: 'http',
    });
    await expect(
      harness(new TransportError('timeout')).client.send(request()),
    ).resolves.toMatchObject({
      status: null,
      failure: 'timeout',
    });
    await expect(harness(new TransportError('tls')).client.send(request())).resolves.toMatchObject({
      failure: 'tls',
    });
    await expect(harness(new Error('boom with 10.0.0.1')).client.send(request())).resolves.toEqual({
      status: null,
      durationMs: 25,
      failure: 'connection',
    });
  });

  it('opens no connection to a destination the guard refuses', async () => {
    const privateDns: Resolver = async () => [{ address: '10.0.0.1', family: 4 }];
    const spy = vi.fn();
    for (const [url, resolve, failure] of [
      ['http://hooks.example.com/', pub, 'not_https'],
      ['https://localhost/', pub, 'host'],
      ['https://127.0.0.1/', pub, 'host'],
      ['https://[::1]/', pub, 'host'],
      ['https://[::ffff:10.0.0.1]/', pub, 'host'],
      ['https://169.254.169.254/', pub, 'host'],
      ['https://rebinding.example.com/', privateDns, 'private_address'],
    ] as const) {
      const client = new SafeWebhookClient({
        resolve,
        transport: async (input) => {
          spy(input);
          return { status: 200 };
        },
      });
      await expect(client.send(request(url))).resolves.toMatchObject({ status: null, failure });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a name that was public at registration and is private at send time (rebinding)', async () => {
    let answer = '93.184.216.34';
    const dns: Resolver = async () => [{ address: answer, family: 4 }];
    const { client, seen } = harness(200, dns);
    expect((await client.send(request())).failure).toBeNull();
    answer = '192.168.0.10';
    expect((await client.send(request())).failure).toBe('private_address');
    expect(seen).toHaveLength(1);
  });

  it('uses the system resolver and real clock by default', async () => {
    const client = new SafeWebhookClient();
    await expect(client.send(request('https://localhost/'))).resolves.toMatchObject({
      failure: 'host',
    });
  });
});
