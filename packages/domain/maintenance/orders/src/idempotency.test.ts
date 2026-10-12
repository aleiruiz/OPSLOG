import { describe, expect, it } from 'vitest';
import { WorkOrderError } from './errors.js';
import { IDEMPOTENCY_TTL_MS, canonicalJson, idempotencyKey, payloadHash } from './idempotency.js';
import { ADMIN, FLEET, MECHANIC, TENANT, harness } from './test-support.js';
import type { WorkOrderActor } from './workflow.js';

const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkOrderError) return error.code;
    throw error;
  }
  return 'ok';
};
const KEY = 'close-key-0001';
const OTHER_ADMIN: WorkOrderActor = { ...ADMIN, id: 'user-admin2', subject: 'admin2' };

/** An order completed by its mechanic, ready to close. */
async function completed() {
  const h = harness();
  const created = await h.service.createCorrective(TENANT, FLEET, {
    vehicleId: 'vehicle-1',
    description: 'Frenos',
  });
  const assigned = await h.service.assign(TENANT, FLEET, created.id, {
    version: 1,
    responsibleId: 'fleet',
    workshopId: 'workshop-1',
    mechanicId: 'mechanic-1',
    scheduledDate: '2026-10-13',
  });
  const started = await h.service.start(TENANT, MECHANIC, created.id, {
    version: assigned.version,
  });
  const worked = await h.service.updateWork(TENANT, MECHANIC, created.id, {
    version: started.version,
    tasks: [{ description: 'Cambio de balatas' }],
  });
  const order = await h.service.complete(TENANT, MECHANIC, created.id, {
    version: worked.version,
    actualDate: '2026-10-12',
    actualKm: 1500,
  });
  return { h, order };
}
const closing = (version: number, extra: object = {}) => ({
  version,
  vehicleStatus: 'active',
  ...extra,
});

describe('canonical payload hash', () => {
  it('ignores key order and undefined members, and tells payloads apart', () => {
    expect(canonicalJson({ b: [1, { d: 2, c: undefined }], a: 'x' })).toBe(
      '{"a":"x","b":[1,{"d":2}]}',
    );
    expect(canonicalJson([undefined, 'a'])).toBe('[null,"a"]');
    expect(canonicalJson(undefined)).toBe('null');
    const a = payloadHash('o1', 'close', { version: 3, comment: 'x' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash('o1', 'close', { comment: 'x', version: 3 })).toBe(a);
    expect(payloadHash('o1', 'close', { version: 3, comment: 'y' })).not.toBe(a);
    expect(payloadHash('o2', 'close', { version: 3, comment: 'x' })).not.toBe(a);
    expect(payloadHash('o1', 'cancel', { version: 3, comment: 'x' })).not.toBe(a);
  });

  it('accepts only 8 to 128 characters of [A-Za-z0-9_-]', () => {
    expect(idempotencyKey('abcdefgh')).toBe('abcdefgh');
    expect(idempotencyKey('a'.repeat(128))).toHaveLength(128);
    for (const bad of ['short', 'a'.repeat(129), 'has space!', 'ñandú-1234', 7, null, undefined])
      expect(() => idempotencyKey(bad)).toThrow(WorkOrderError);
  });
});

describe('Idempotency-Key on work order commands', () => {
  it('requires the key to close and reopen, and accepts it optionally elsewhere', async () => {
    const { h, order } = await completed();
    expect(
      await code(h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version))),
    ).toBe('idempotency_key_required');
    expect(
      await code(
        h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), 'bad'),
      ),
    ).toBe('invalid_input');
    // Nothing was written by the refused calls.
    expect((await h.service.get(TENANT, ADMIN, order.id)).version).toBe(order.version);
    h.refs.approval = true;
    const approved = await h.service.execute(TENANT, ADMIN, 'approve_close', order.id, {
      version: order.version,
    }); // optional for other commands: no key
    expect(approved.closeApproval).not.toBeNull();
  });

  it('replays the stored result for the same key and payload without executing again', async () => {
    const { h, order } = await completed();
    const first = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(order.version),
      KEY,
    );
    expect(first.status).toBe('closed');
    const events = h.store.events.length;
    const audit = h.store.audit.length;
    const history = (await h.service.history(TENANT, ADMIN, order.id)).length;
    // The payload is the same JSON, even with its members in another order.
    const again = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      { vehicleStatus: 'active', version: order.version },
      KEY,
    );
    expect(again).toEqual(first);
    expect(h.store.events).toHaveLength(events);
    expect(h.store.audit).toHaveLength(audit);
    expect(await h.service.history(TENANT, ADMIN, order.id)).toHaveLength(history);
    // The order moved on (reopened) and the old key still answers with the original result.
    const reopened = await h.service.execute(
      TENANT,
      ADMIN,
      'reopen',
      order.id,
      { version: first.version, reason: 'Falta factura' },
      'reopen-key-001',
    );
    expect(reopened.status).toBe('in_progress');
    expect(
      await h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY),
    ).toEqual(first);
    expect((await h.service.get(TENANT, ADMIN, order.id)).status).toBe('in_progress');
  });

  it('rejects the same key with another payload, another order or another command as a conflict', async () => {
    const { h, order } = await completed();
    await h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY);
    expect(
      await code(
        h.service.execute(
          TENANT,
          ADMIN,
          'close',
          order.id,
          closing(order.version, { comment: 'otro' }),
          KEY,
        ),
      ),
    ).toBe('idempotency_conflict');
    expect(
      await code(
        h.service.execute(TENANT, ADMIN, 'close', 'other-order', closing(order.version), KEY),
      ),
    ).toBe('idempotency_conflict');
    // The key is per command: the same text on a reopen is a different key.
    expect(
      await code(
        h.service.execute(
          TENANT,
          ADMIN,
          'reopen',
          order.id,
          { version: order.version + 1, reason: 'x' },
          KEY,
        ),
      ),
    ).toBe('ok');
  });

  it('scopes keys to the actor', async () => {
    const { h, order } = await completed();
    const first = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(order.version),
      KEY,
    );
    // Another actor with the same key and payload is not a replay: it really runs and is refused.
    expect(
      await code(
        h.service.execute(TENANT, OTHER_ADMIN, 'close', order.id, closing(order.version), KEY),
      ),
    ).toBe('invalid_transition');
    expect(await h.store.idempotency(TENANT, OTHER_ADMIN.id, 'close', KEY)).toBeNull();
    expect((await h.store.idempotency(TENANT, ADMIN.id, 'close', KEY))?.response).toEqual(first);
    // And the tenant is part of the identity too.
    expect(await h.store.idempotency('tenant-b', ADMIN.id, 'close', KEY)).toBeNull();
  });

  it('still checks that the caller may see the order and run the command on a replay', async () => {
    const { h, order } = await completed();
    await h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY);
    const revoked: WorkOrderActor = { ...ADMIN, permissions: ['view', 'edit'] };
    expect(
      await code(
        h.service.execute(TENANT, revoked, 'close', order.id, closing(order.version), KEY),
      ),
    ).toBe('forbidden');
    const blind: WorkOrderActor = { ...ADMIN, permissions: [] };
    expect(
      await code(h.service.execute(TENANT, blind, 'close', order.id, closing(order.version), KEY)),
    ).toBe('not_found');
  });

  it('treats an expired key as new and replaces its record', async () => {
    const { h, order } = await completed();
    const first = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(order.version),
      KEY,
    );
    const reopened = await h.service.execute(
      TENANT,
      ADMIN,
      'reopen',
      order.id,
      { version: first.version, reason: 'Falta factura' },
      'reopen-key-001',
    );
    h.clock.now = new Date(h.clock.now.getTime() + IDEMPOTENCY_TTL_MS + 1000);
    const done = await h.service.complete(TENANT, MECHANIC, order.id, {
      version: reopened.version,
      actualDate: '2026-10-12',
      actualKm: 1600,
    });
    const second = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(done.version, { comment: 'nuevo' }),
      KEY,
    );
    // Same key, other payload, but the old record had expired: a new command that really ran.
    expect(second.version).toBe(done.version + 1);
    expect(second.status).toBe('closed');
    expect((await h.store.idempotency(TENANT, ADMIN.id, 'close', KEY))?.response).toEqual(second);
  });

  it('lets exactly one of concurrent duplicates take effect and replays the rest', async () => {
    const { h, order } = await completed();
    const before = h.store.events.length;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY),
      ),
    );
    expect(new Set(results.map((result) => result.version)).size).toBe(1);
    expect(results[0]?.status).toBe('closed');
    // One status event for the single effect.
    expect(h.store.events.length - before).toBe(1);
    expect(h.store.audit.filter((entry) => entry.action.endsWith('.close'))).toHaveLength(1);
  });

  it('leaves no key behind when the mutation fails', async () => {
    const { h, order } = await completed();
    const apply = h.store.apply.bind(h.store);
    h.store.apply = async () => {
      throw new Error('crash');
    };
    await expect(
      h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY),
    ).rejects.toThrow('crash');
    h.store.apply = apply;
    expect(await h.store.idempotency(TENANT, ADMIN.id, 'close', KEY)).toBeNull();
    const retried = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(order.version),
      KEY,
    );
    expect(retried.status).toBe('closed');
  });

  it('does not record a key for a rejected command, so the corrected retry runs', async () => {
    const { h, order } = await completed();
    expect(
      await code(
        h.service.execute(TENANT, ADMIN, 'close', order.id, { version: order.version }, KEY),
      ),
    ).toBe('missing_requirements');
    expect(await h.store.idempotency(TENANT, ADMIN.id, 'close', KEY)).toBeNull();
    expect(
      (await h.service.execute(TENANT, ADMIN, 'close', order.id, closing(order.version), KEY))
        .status,
    ).toBe('closed');
  });

  it('replays the winner when the duplicate looked up the key just before the winner committed', async () => {
    const { h, order } = await completed();
    const lookup = h.store.idempotency.bind(h.store);
    let raced = false;
    let winner: unknown;
    h.store.idempotency = async (...args) => {
      if (!raced) {
        raced = true;
        // The duplicate finds no key; the winner then commits before the duplicate reads the order.
        winner = await h.service.execute(
          TENANT,
          ADMIN,
          'close',
          order.id,
          closing(order.version),
          KEY,
        );
        return null;
      }
      return lookup(...args);
    };
    const loser = await h.service.execute(
      TENANT,
      ADMIN,
      'close',
      order.id,
      closing(order.version),
      KEY,
    );
    expect(loser).toEqual(winner);
    expect(loser.status).toBe('closed');
  });
});
