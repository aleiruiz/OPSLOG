import { describe, expect, it } from 'vitest';
import { EligibilityTracker, type DriverFacts } from './eligibility.js';
import { endpointOf, world } from './test-support.js';

describe('driver eligibility', () => {
  it('announces one change when the license expires and one when it is renewed', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w, 'tenant-a', ['driver.eligibility_changed']);
    let facts: DriverFacts | null = { id: 'drv-1', eligible: true, reasons: [] };
    const tracker = new EligibilityTracker({
      store: w.store,
      ingest: w.ingest,
      now: w.clock.now,
      source: {
        driver: async () => facts,
        drivers: async () => (facts ? [facts] : []),
      },
    });
    const sent = async () =>
      (await w.store.deliveries('tenant-a', endpoint.id, { limit: 20, offset: 0 })).total;
    // First sight records, announces nothing.
    expect(await tracker.check('tenant-a', 'drv-1')).toBe(false);
    expect(await sent()).toBe(0);
    expect(await tracker.check('tenant-a', 'drv-1')).toBe(false);
    // The license expires: found by the daily scan and again by an event: still one.
    facts = { id: 'drv-1', eligible: false, reasons: ['license_expired'] };
    expect(await tracker.scan('tenant-a')).toBe(1);
    expect(await tracker.check('tenant-a', 'drv-1')).toBe(false);
    expect(await tracker.scan('tenant-a')).toBe(0);
    expect(await sent()).toBe(1);
    facts = { id: 'drv-1', eligible: true, reasons: [] };
    expect(await tracker.check('tenant-a', 'drv-1')).toBe(true);
    expect(await sent()).toBe(2);
    const bodies = (
      await w.store.deliveries('tenant-a', endpoint.id, { limit: 20, offset: 0 })
    ).items.map((d) => JSON.parse(d.body));
    // Same clock tick, so the listing order between the two is not defined.
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.data)).toEqual(
      expect.arrayContaining([
        { driverId: 'drv-1', eligible: true, reasons: [] },
        { driverId: 'drv-1', eligible: false, reasons: ['license_expired'] },
      ]),
    );
    expect(new Set(bodies.map((b) => b.id)).size).toBe(2);
    // A driver that no longer exists is skipped.
    facts = null;
    expect(await tracker.check('tenant-a', 'drv-1')).toBe(false);
  });

  it('a crash between announcing and recording repeats the same id, so nothing is duplicated', async () => {
    const w = world();
    const { endpoint } = await endpointOf(w, 'tenant-a', ['driver.eligibility_changed']);
    const facts: DriverFacts = { id: 'drv-1', eligible: true, reasons: [] };
    const make = () =>
      new EligibilityTracker({
        store: w.store,
        ingest: w.ingest,
        now: w.clock.now,
        source: { driver: async () => facts, drivers: async () => [facts] },
      });
    await make().check('tenant-a', 'drv-1');
    const flipped = { ...facts, eligible: false, reasons: ['license_expired'] };
    const crashing = new EligibilityTracker({
      store: Object.assign(Object.create(w.store), {
        saveDriverState: async () => {
          throw new Error('crash');
        },
      }),
      ingest: w.ingest,
      now: w.clock.now,
      source: { driver: async () => flipped, drivers: async () => [flipped] },
    });
    await expect(crashing.check('tenant-a', 'drv-1')).rejects.toThrow('crash');
    const again = new EligibilityTracker({
      store: w.store,
      ingest: w.ingest,
      now: w.clock.now,
      source: { driver: async () => flipped, drivers: async () => [flipped] },
    });
    expect(await again.check('tenant-a', 'drv-1')).toBe(true);
    expect(
      (await w.store.deliveries('tenant-a', endpoint.id, { limit: 20, offset: 0 })).total,
    ).toBe(1);
  });
});
