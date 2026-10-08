import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, jpeg, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const MINUTE = 60_000;

describe('worker jobs and the outbox', () => {
  it('rejects jobs of a suspended tenant and of an absent tenant before any handler runs', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const handled: string[] = [];
    platform.runtime.worker.register('demo.created', (_payload, event) => {
      handled.push(event.tenantId);
    });
    await platform.publish(a.admin.token, corr(), (emit) =>
      emit({ type: 'demo.created', entityId: 'obj-a', payload: {} }),
    );
    await platform.publish(b.admin.token, corr(), (emit) =>
      emit({ type: 'demo.created', entityId: 'obj-b', payload: {} }),
    );
    world.outbox.transaction((tx) =>
      tx.enqueue({
        eventId: 'ghost-event',
        tenantId: 'tenant-that-does-not-exist',
        type: 'demo.created',
        payload: {},
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'ghost',
      }),
    );
    await platform.suspendTenant(b.tenantId);

    await platform.runtime.drainOutbox();
    expect(handled).toEqual([a.tenantId]);
    expect(
      world.outbox.get(
        b.tenantId,
        world.outbox.all().find((r) => r.tenantId === b.tenantId)!.eventId,
      )?.status,
    ).toBe('dead_letter');
    expect(world.outbox.get('tenant-that-does-not-exist', 'ghost-event')?.status).toBe(
      'dead_letter',
    );
    expect(platform.runtime.worker.metrics.rejectedTenants).toBe(2);
    // Rejections carry ids and a reason only: no payload.
    const dlq = [platform.runtime.worker.dlq.receive(), platform.runtime.worker.dlq.receive()];
    expect(dlq.map((entry) => (entry?.body as { reason: string }).reason)).toEqual([
      'tenant unavailable',
      'tenant unavailable',
    ]);
  });

  it('publishes nothing when the transaction rolls back', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const handled: string[] = [];
    platform.runtime.worker.register('demo.created', (_p, event) => {
      handled.push(event.eventId);
    });
    const failed = await platform.publish(a.admin.token, corr(), (emit) => {
      emit({ type: 'demo.created', entityId: 'obj-1', payload: { step: 1 } });
      emit({ type: 'demo.created', entityId: 'obj-2', payload: { step: 2 } });
      throw new Error('business rule failed after emitting');
    });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe('internal_error');
    expect(failed.error?.message).not.toMatch(/business rule/);
    // An async body would commit before settling, so it is refused and also publishes nothing.
    const async = await platform.publish(a.admin.token, corr(), async (emit) => {
      emit({ type: 'demo.created', entityId: 'obj-3', payload: {} });
    });
    expect(async.ok).toBe(false);
    expect(world.outbox.all()).toHaveLength(0);
    expect(await platform.runtime.drainOutbox()).toBe(0);
    expect(handled).toEqual([]);
    expect(
      world.audit
        .snapshotForTesting(a.tenantId)
        .some((event) => event.action === 'outbox.delivered'),
    ).toBe(false);
  });

  it('deduplicates a retried publish by tenant and event id, independently per tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    let deliveries = 0;
    platform.runtime.worker.register('demo.created', () => {
      deliveries += 1;
    });
    const emitSame = (token: string) =>
      platform.publish(token, corr(), (emit) =>
        emit({ eventId: 'evt-stable-1', type: 'demo.created', entityId: 'obj', payload: { n: 1 } }),
      );
    await emitSame(a.admin.token);
    await emitSame(a.admin.token);
    await emitSame(b.admin.token);
    expect(world.outbox.all()).toHaveLength(2);
    await platform.runtime.drainOutbox();
    expect(deliveries).toBe(2);
    // Same id with a different body is a conflict, not a silent overwrite.
    const conflicting = await platform.publish(a.admin.token, corr(), (emit) =>
      emit({ eventId: 'evt-stable-1', type: 'demo.created', entityId: 'obj', payload: { n: 2 } }),
    );
    expect(conflicting.ok).toBe(false);
  });

  it('retries a failing handler with backoff without duplicating the effect or leaking data', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    let calls = 0;
    let effects = 0;
    platform.runtime.worker.register('demo.created', () => {
      calls += 1;
      if (calls === 1) throw new Error('boom token=Bearer abc.def.ghi for owner@example.test');
      effects += 1;
    });
    await platform.publish(a.admin.token, corr(), (emit) =>
      emit({
        type: 'demo.created',
        entityId: 'obj',
        payload: { email: 'owner@example.test' },
      }),
    );
    expect(await platform.runtime.drainOutbox()).toBe(1);
    const failed = world.outbox.all()[0]!;
    expect(failed.status).toBe('retry');
    expect(failed.lastError).not.toMatch(/abc\.def|owner@example/);
    // Not due yet: nothing happens until the backoff elapses.
    expect(await platform.runtime.drainOutbox()).toBe(0);
    world.advance(2 * MINUTE);
    expect(await platform.runtime.drainOutbox()).toBe(1);
    expect(world.outbox.all()[0]!.status).toBe('delivered');
    expect(effects).toBe(1);
    world.advance(10 * MINUTE);
    expect(await platform.runtime.drainOutbox()).toBe(0);
    expect(effects).toBe(1);
    const trail = JSON.stringify(world.audit.snapshotForTesting(a.tenantId));
    expect(trail).not.toMatch(/owner@example|abc\.def|Bearer/);
  });

  it('holds scan jobs of a suspended tenant and releases them after reactivation', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const upload = (token: string, tag: string) =>
      platform.files.upload(token, corr(), {
        name: `${tag}.jpg`,
        contentType: 'image/jpeg',
        bytes: jpeg(tag),
      });
    const fileA = (await upload(a.admin.token, 'alpha')).value!;
    const fileB = (await upload(b.admin.token, 'beta')).value!;
    await platform.suspendTenant(a.tenantId);

    expect(await platform.runtime.runScans()).toMatchObject({ released: 1, deferred: 0 });
    expect(platform.scanQueue.heldBack).toBe(1);
    // B was released; A stays in quarantine, never downloadable.
    expect((await platform.files.status(b.admin.token, corr(), fileB.id)).value?.status).toBe(
      'clean',
    );
    await platform.reactivateTenant(a.tenantId);
    expect((await platform.files.status(a.admin.token, corr(), fileA.id)).value?.status).toBe(
      'pending_scan',
    );
    expect(
      (await platform.files.createDownloadGrant(a.admin.token, corr(), fileA.id)).error?.code,
    ).toBe('not_available');
    // Held back for five minutes, then it is scanned and released.
    expect(await platform.runtime.runScans()).toMatchObject({ released: 0 });
    world.advance(6 * MINUTE);
    expect(await platform.runtime.runScans()).toMatchObject({ released: 1 });
    expect((await platform.files.status(a.admin.token, corr(), fileA.id)).value?.status).toBe(
      'clean',
    );
  });

  it('still scans an active tenant behind a suspended-tenant backlog larger than the batch', async () => {
    world = createWorld({ pipeline: { batchSize: 2 } });
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    for (let i = 0; i < 5; i += 1)
      await platform.files.upload(a.admin.token, corr(), {
        name: `a${i}.jpg`,
        contentType: 'image/jpeg',
        bytes: jpeg(`a${i}`),
      });
    const fileB = (
      await platform.files.upload(b.admin.token, corr(), {
        name: 'b.jpg',
        contentType: 'image/jpeg',
        bytes: jpeg('b'),
      })
    ).value!;
    await platform.suspendTenant(a.tenantId);
    expect(await platform.runtime.runScans()).toMatchObject({ released: 1 });
    expect(platform.scanQueue.heldBack).toBe(5);
    expect((await platform.files.status(b.admin.token, corr(), fileB.id)).value?.status).toBe(
      'clean',
    );
  });

  it('keeps files in quarantine while the scanner is down and never serves them', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    world.scanner.down = true;
    const upload = await platform.files.upload(a.admin.token, corr(), {
      name: 'alpha.jpg',
      contentType: 'image/jpeg',
      bytes: jpeg('alpha'),
    });
    expect(await platform.runtime.runScans()).toMatchObject({ released: 0, deferred: 1 });
    expect(
      (await platform.files.createDownloadGrant(a.admin.token, corr(), upload.value!.id)).error
        ?.code,
    ).toBe('not_available');
    world.scanner.down = false;
    world.advance(10 * MINUTE);
    expect(await platform.runtime.runScans()).toMatchObject({ released: 1 });
  });
});
