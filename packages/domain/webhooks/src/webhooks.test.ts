import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../../../platform/webhooks/src/index.js';
import {
  DISABLE_AFTER_FAILURES,
  MAX_ENDPOINTS,
  RETRY_DELAYS_MS,
  WebhookError,
  eventIdOf,
} from './index.js';
import { endpointOf, event, failing, world } from './test-support.js';

const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error instanceof WebhookError ? `${error.code}:${error.field ?? ''}` : 'other';
  }
  return 'none';
};

describe('endpoint administration', () => {
  it('shows the secret once, stores it sealed and never reads it back', async () => {
    const w = world();
    const { endpoint, secret } = await endpointOf(w);
    expect(secret).toMatch(/^whsec_/);
    const stored = await w.store.endpoint('tenant-a', endpoint.id);
    expect(stored?.secretSealed).toMatch(/^pii1\./);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(await w.service.list('tenant-a'))).not.toContain(secret);
    expect(JSON.stringify(await w.service.get('tenant-a', endpoint.id))).not.toContain('pii1.');
    expect(endpoint.companyRef).toMatch(/^co_/);
    expect(endpoint.companyRef).not.toContain('tenant-a');
  });

  it('validates input and caps the company at five endpoints', async () => {
    const w = world();
    const make = (input: object) => w.service.create('tenant-a', 'a', input as never);
    expect(await code(make({ url: 'http://x.example.com', events: ['vehicle.created'] }))).toBe(
      'invalid_input:url',
    );
    expect(await code(make({ url: 5, events: ['vehicle.created'] }))).toBe('invalid_input:url');
    for (const events of [[], 'x', ['nope'], ['vehicle.created', 'vehicle.created'], ['ping']])
      expect(await code(make({ url: 'https://h.example.com', events }))).toBe(
        'invalid_input:events',
      );
    expect(
      await code(
        make({ url: 'https://h.example.com', events: ['vehicle.created'], active: 'yes' }),
      ),
    ).toBe('invalid_input:active');
    for (let i = 0; i < MAX_ENDPOINTS; i += 1) await endpointOf(w);
    expect(await code(endpointOf(w))).toBe('limit_reached:');
    // The limit is per company.
    expect(await code(endpointOf(w, 'tenant-b'))).toBe('none');
  });

  it('keeps companies apart: B cannot read, change, rotate, test, list or delete what A made', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    await w.ingest.publish('tenant-a', event('evt_1'));
    const [d] = (await w.service.deliveries('tenant-a', endpoint.id, { limit: 10, offset: 0 }))
      .items;
    expect(await code(w.service.get('tenant-b', endpoint.id))).toBe('not_found:');
    expect(
      await code(w.service.update('tenant-b', endpoint.id, { version: 1, active: false })),
    ).toBe('not_found:');
    expect(await code(w.service.rotate('tenant-b', endpoint.id, 1))).toBe('not_found:');
    expect(await code(w.service.test('tenant-b', endpoint.id))).toBe('not_found:');
    expect(
      await code(w.service.deliveries('tenant-b', endpoint.id, { limit: 10, offset: 0 })),
    ).toBe('not_found:');
    expect(await code(w.service.retry('tenant-b', endpoint.id, d?.id))).toBe('not_found:');
    expect(await code(w.service.remove('tenant-b', endpoint.id))).toBe('not_found:');
    expect(await w.service.list('tenant-b')).toEqual([]);
    expect(await code(w.service.get('tenant-a', '../x'))).toBe('not_found:id');
  });

  it('updates with a version check and re-enabling clears the failures', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    expect(await code(w.service.update('tenant-a', endpoint.id, { version: 9 }))).toBe(
      'stale_version:',
    );
    expect(await code(w.service.update('tenant-a', endpoint.id, { version: 'x' }))).toBe(
      'invalid_input:version',
    );
    expect(
      await code(w.service.update('tenant-a', endpoint.id, { version: 1, active: 'no' })),
    ).toBe('invalid_input:active');
    const off = await w.service.update('tenant-a', endpoint.id, { version: 1, active: false });
    expect(off).toMatchObject({ active: false, version: 2 });
    await w.store.noteResult('tenant-a', endpoint.id, false, w.clock.now().toISOString());
    const on = await w.service.update('tenant-a', endpoint.id, {
      version: 2,
      active: true,
      url: 'https://other.example.com/x',
      events: ['driver.created'],
    });
    expect(on).toMatchObject({
      active: true,
      consecutiveFailures: 0,
      url: 'https://other.example.com/x',
      events: ['driver.created'],
    });
    expect(
      await code(
        w.service.update('tenant-a', endpoint.id, { version: 3, url: 'http://bad.example.com' }),
      ),
    ).toBe('invalid_input:url');
  });

  it('rotates: both secrets sign for 24 hours, then only the new one', async () => {
    const w = world();
    const { endpoint, secret: first } = await endpointOf(w);
    expect(await code(w.service.rotate('tenant-a', endpoint.id, 7))).toBe('stale_version:');
    const rotated = await w.service.rotate('tenant-a', endpoint.id, 1);
    expect(rotated.secret).not.toBe(first);
    expect(rotated.endpoint.previousSecretUntil).not.toBeNull();
    await w.ingest.publish('tenant-a', event('evt_1'));
    await w.dispatcher.runDue('tenant-a');
    const call = w.client.calls[0];
    expect(call?.secrets).toEqual([rotated.secret, first]);
    w.clock.advance(24 * 3_600_000 + 1);
    const stored = await w.store.endpoint('tenant-a', endpoint.id);
    expect(await w.vault.signing(stored as never, w.clock.now())).toEqual([rotated.secret]);
    expect((await w.service.get('tenant-a', endpoint.id)).previousSecretUntil).toBeNull();
  });

  it('deletes an endpoint with its history and sends a ping to that endpoint only', async () => {
    const w = world();
    const a = await endpointOf(w);
    const b = await endpointOf(w, 'tenant-a', ['driver.created']);
    const ping = await w.service.test('tenant-a', a.endpoint.id);
    expect(ping.eventType).toBe('ping');
    expect(
      (await w.service.deliveries('tenant-a', b.endpoint.id, { limit: 5, offset: 0 })).total,
    ).toBe(0);
    await w.dispatcher.runDue('tenant-a');
    expect(JSON.parse(Buffer.from(w.client.calls[0]?.body as Uint8Array).toString())).toMatchObject(
      {
        type: 'ping',
        companyRef: a.endpoint.companyRef,
      },
    );
    await w.service.update('tenant-a', b.endpoint.id, { version: 1, active: false });
    expect(await code(w.service.test('tenant-a', b.endpoint.id))).toBe('invalid_transition:');
    await w.service.remove('tenant-a', a.endpoint.id);
    expect(await code(w.service.get('tenant-a', a.endpoint.id))).toBe('not_found:');
    expect(await code(w.service.remove('tenant-a', a.endpoint.id))).toBe('not_found:');
  });
});

describe('fan-out', () => {
  it('reaches only subscribed, active endpoints of the same company and only once', async () => {
    const w = world();
    const a1 = await endpointOf(w, 'tenant-a', ['vehicle.created']);
    await endpointOf(w, 'tenant-a', ['driver.created']);
    const b1 = await endpointOf(w, 'tenant-b', ['vehicle.created']);
    const off = await endpointOf(w, 'tenant-a', ['vehicle.created']);
    await w.service.update('tenant-a', off.endpoint.id, { version: 1, active: false });
    expect(await w.ingest.publish('tenant-a', event('evt_1'))).toBe(1);
    expect(await w.ingest.publish('tenant-a', event('evt_1'))).toBe(0);
    expect(await w.ingest.publish('tenant-a', event('evt_nobody', 'incident.closed'))).toBe(0);
    expect(
      (await w.service.deliveries('tenant-a', a1.endpoint.id, { limit: 5, offset: 0 })).total,
    ).toBe(1);
    expect(
      (await w.service.deliveries('tenant-b', b1.endpoint.id, { limit: 5, offset: 0 })).total,
    ).toBe(0);
    const [row] = (await w.store.deliveries('tenant-a', a1.endpoint.id, { limit: 5, offset: 0 }))
      .items;
    expect(row?.body).not.toContain('tenant-a');
    expect(JSON.parse(row?.body as string)).toMatchObject({
      id: 'evt_1',
      type: 'vehicle.created',
      schemaVersion: 1,
      companyRef: a1.endpoint.companyRef,
      data: { economicNumber: 'E-100' },
    });
  });

  it('refuses a body above the size limit and derives opaque, stable event ids', async () => {
    const w = world();
    await endpointOf(w);
    await expect(
      w.ingest.publish('tenant-a', { ...event('evt_big'), data: { text: 'x'.repeat(9000) } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(eventIdOf('t', 'k')).toBe(eventIdOf('t', 'k'));
    expect(eventIdOf('t', 'k')).not.toBe(eventIdOf('u', 'k'));
    expect(eventIdOf('t', 'k')).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});

describe('dispatch', () => {
  it('signs, delivers and records code and duration', async () => {
    const w = world();
    const { secret } = await endpointOf(w);
    await w.ingest.publish('tenant-a', event('evt_1'));
    expect(await w.dispatcher.runDue('tenant-a')).toEqual({
      delivered: 1,
      retried: 0,
      deadLettered: 0,
    });
    const call = w.client.calls[0];
    expect(call?.eventId).toBe('evt_1');
    expect(call?.secrets).toEqual([secret]);
    expect(call?.timestamp).toBe(Math.floor(w.clock.ms / 1000));
    expect(verifyWebhook({ secrets: [secret], headers: {}, body: '', nowMs: 0 }).ok).toBe(false);
    const [row] = (
      await w.store.deliveries('tenant-a', (await w.store.endpoints('tenant-a'))[0]?.id as string, {
        limit: 5,
        offset: 0,
      })
    ).items;
    expect(row).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 200,
      lastDurationMs: 12,
      nextAttemptAt: null,
    });
    expect(await w.dispatcher.runDue('tenant-a')).toEqual({
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    });
  });

  it('retries at 1m/5m/30m/2h/12h within the jitter, ends in the DLQ and retries manually with the same id', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    w.client.answer = () => failing(503);
    await w.ingest.publish('tenant-a', event('evt_1'));
    const read = async () =>
      (await w.store.deliveries('tenant-a', endpoint.id, { limit: 5, offset: 0 })).items[0];
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await w.dispatcher.runDue('tenant-a');
      const row = await read();
      if (row?.nextAttemptAt) {
        const wait = Date.parse(row.nextAttemptAt) - w.clock.ms;
        waits.push(wait);
        // Too early: nothing is sent.
        w.clock.advance(wait - 1);
        const before = w.client.calls.length;
        await w.dispatcher.runDue('tenant-a');
        expect(w.client.calls.length).toBe(before);
        w.clock.advance(1);
        // The per-minute window has to pass too for the long waits; they are longer than a minute anyway.
      }
    }
    expect(waits).toHaveLength(5);
    waits.forEach((wait, i) => {
      const base = RETRY_DELAYS_MS[i] as number;
      expect(wait).toBeGreaterThanOrEqual(base * 0.8);
      expect(wait).toBeLessThanOrEqual(base * 1.2);
    });
    const dead = await read();
    expect(dead).toMatchObject({
      status: 'dead_letter',
      attempts: 6,
      lastError: 'http_503',
      nextAttemptAt: null,
    });
    expect(w.client.calls.map((c) => c.eventId)).toEqual(Array(6).fill('evt_1'));

    const retried = await w.service.retry('tenant-a', endpoint.id, dead?.id);
    expect(retried.status).toBe('pending');
    w.clock.advance(61_000);
    w.client.answer = () => ({});
    await w.dispatcher.runDue('tenant-a');
    expect(w.client.calls).toHaveLength(7);
    expect(w.client.calls[6]?.eventId).toBe('evt_1');
    expect(await read()).toMatchObject({ status: 'delivered', attempts: 7 });
    expect(await code(w.service.retry('tenant-a', endpoint.id, dead?.id))).toBe(
      'invalid_transition:',
    );
    expect(await code(w.service.retry('tenant-a', endpoint.id, 'whd_missing'))).toBe('not_found:');
  });

  it('a failed manual retry dead-letters again without a new schedule', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    w.client.answer = () => failing(400);
    await w.ingest.publish('tenant-a', event('evt_1'));
    await w.dispatcher.runDue('tenant-a');
    const row = (await w.store.deliveries('tenant-a', endpoint.id, { limit: 5, offset: 0 }))
      .items[0];
    expect(row).toMatchObject({ status: 'dead_letter', attempts: 1, lastError: 'http_400' });
    await w.service.retry('tenant-a', endpoint.id, row?.id);
    w.clock.advance(61_000);
    w.client.answer = () => failing(500);
    await w.dispatcher.runDue('tenant-a');
    expect(await w.store.delivery('tenant-a', endpoint.id, row?.id as string)).toMatchObject({
      status: 'dead_letter',
      attempts: 2,
      manual: false,
    });
  });

  it.each([
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [404, 'dead'],
    [410, 'dead'],
  ])('a %i answer is %s', async (status, kind) => {
    const w = world();
    await endpointOf(w);
    w.client.answer = () => failing(status);
    await w.ingest.publish('tenant-a', event('evt_1'));
    const summary = await w.dispatcher.runDue('tenant-a');
    expect(kind === 'retry' ? summary.retried : summary.deadLettered).toBe(1);
  });

  it('treats a refused destination as terminal and a timeout as transient', async () => {
    const w = world();
    await endpointOf(w);
    w.client.answer = () => ({ status: null, failure: 'private_address' });
    await w.ingest.publish('tenant-a', event('evt_1'));
    expect((await w.dispatcher.runDue('tenant-a')).deadLettered).toBe(1);
    w.client.answer = () => ({ status: null, failure: 'timeout' });
    await w.ingest.publish('tenant-a', event('evt_2'));
    expect((await w.dispatcher.runDue('tenant-a')).retried).toBe(1);
  });

  it('two workers on the same delivery send once', async () => {
    const w = world();
    await endpointOf(w);
    await w.ingest.publish('tenant-a', event('evt_1'));
    const [first, second] = await Promise.all([
      w.dispatcher.runDue('tenant-a'),
      w.dispatcher.runDue('tenant-a'),
    ]);
    expect(first.delivered + second.delivered).toBe(1);
    expect(w.client.calls).toHaveLength(1);
  });

  it('a worker that lost its lease neither sends nor settles', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    await w.ingest.publish('tenant-a', event('evt_1'));
    const real = w.store.renew.bind(w.store);
    w.store.renew = async () => null;
    expect(await w.dispatcher.runDue('tenant-a')).toEqual({
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(w.client.calls).toHaveLength(0);
    w.store.renew = real;
    // Settling under a lease that is not ours writes nothing.
    w.clock.advance(3 * 60_000);
    const [work] = await w.store.claimDue('tenant-a', w.clock.now(), 60_000, 1);
    const ok = await w.store.settle(
      'tenant-a',
      work?.delivery.id as string,
      { kind: 'delivered', statusCode: 200, durationMs: 1 },
      w.clock.now().toISOString(),
      'another-lease',
    );
    expect(ok).toBe(false);
    expect(
      (await w.store.delivery('tenant-a', endpoint.id, work?.delivery.id as string))?.status,
    ).toBe('pending');
  });

  it('starts at most 60 deliveries a minute per company and keeps the rest for later', async () => {
    const w = world({ perMinute: 3 });
    await endpointOf(w);
    for (let i = 0; i < 7; i += 1) await w.ingest.publish('tenant-a', event(`evt_${i}`));
    await w.dispatcher.runDue('tenant-a');
    expect(w.client.calls).toHaveLength(3);
    await w.dispatcher.runDue('tenant-a');
    expect(w.client.calls).toHaveLength(3);
    w.clock.advance(61_000);
    await w.dispatcher.runDue('tenant-a');
    w.clock.advance(61_000);
    await w.dispatcher.runDue('tenant-a');
    expect(w.client.calls).toHaveLength(7);
    // Another company has its own budget.
    const other = world({ perMinute: 3 });
    await endpointOf(other, 'tenant-b');
    await other.ingest.publish('tenant-b', event('evt_x'));
    expect((await other.dispatcher.runDue('tenant-b')).delivered).toBe(1);
  });

  it('uses the production limit of 60 by default', async () => {
    const w = world();
    await endpointOf(w);
    for (let i = 0; i < 65; i += 1) await w.ingest.publish('tenant-a', event(`evt_${i}`));
    await w.dispatcher.runDue('tenant-a');
    expect(w.client.calls).toHaveLength(60);
  });

  it('switches an endpoint off after 20 failures in a row and tells the administrators once', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    w.client.answer = () => failing(500);
    for (let i = 0; i < DISABLE_AFTER_FAILURES + 2; i += 1) {
      await w.ingest.publish('tenant-a', event(`evt_${i}`));
      await w.dispatcher.runDue('tenant-a');
      w.clock.advance(61_000);
    }
    expect(w.disabled).toEqual([endpoint.id]);
    const view = await w.service.get('tenant-a', endpoint.id);
    expect(view).toMatchObject({
      active: false,
      disabled: true,
      consecutiveFailures: DISABLE_AFTER_FAILURES,
    });
    // A success in between resets the run.
    const fresh = world();
    const ep = await endpointOf(fresh);
    fresh.client.answer = () => failing(500);
    for (let i = 0; i < 4; i += 1) {
      await fresh.ingest.publish('tenant-a', event(`evt_${i}`));
      await fresh.dispatcher.runDue('tenant-a');
      fresh.clock.advance(61_000);
    }
    fresh.client.answer = () => ({});
    fresh.clock.advance(61_000);
    await fresh.dispatcher.runDue('tenant-a');
    expect((await fresh.service.get('tenant-a', ep.endpoint.id)).consecutiveFailures).toBe(0);
  });

  it('purges old deliveries and ignores a result for a deleted endpoint', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w);
    await w.ingest.publish('tenant-a', event('evt_1'));
    w.clock.advance(31 * 86_400_000);
    expect(await w.store.purge('tenant-a', new Date(w.clock.ms - 30 * 86_400_000))).toBe(1);
    expect(await w.store.purge('tenant-a', new Date(w.clock.ms - 30 * 86_400_000))).toBe(0);
    await w.service.remove('tenant-a', endpoint.id);
    expect(await w.store.noteResult('tenant-a', endpoint.id, false, 'x')).toEqual({
      disabled: false,
    });
  });
});
