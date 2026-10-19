import { eventIdOf } from './payload.js';
import type { WebhookIngest } from './ingest.js';
import type { WebhookStore } from './ports.js';

export interface DriverFacts {
  readonly id: string;
  readonly eligible: boolean;
  /** Codes (`license_expired`...): no license number, no name. */
  readonly reasons: readonly string[];
}
export interface DriverSource {
  /** `null`: the record is gone or is not a driver. */
  driver(tenantId: string, driverId: string): Promise<DriverFacts | null>;
  /** Every driver of the company that is not archived. */
  drivers(tenantId: string): Promise<readonly DriverFacts[]>;
}

/**
 * `driver.eligibility_changed` is derived: the eligibility computed now is compared with the last
 * one known for that driver. The first sight records without announcing. The id of an announcement
 * is (driver, number of the change), so a crash between announcing and recording repeats the same
 * id and the deduplication absorbs it.
 */
export class EligibilityTracker {
  public constructor(
    private readonly deps: {
      readonly store: WebhookStore;
      readonly source: DriverSource;
      readonly ingest: WebhookIngest;
      readonly now: () => Date;
    },
  ) {}

  public async check(tenantId: string, driverId: string): Promise<boolean> {
    const facts = await this.deps.source.driver(tenantId, driverId);
    return facts === null ? false : this.compare(tenantId, facts);
  }

  /** The daily scan: every driver, so a license that expired by the calendar is noticed. */
  public async scan(tenantId: string): Promise<number> {
    let changed = 0;
    for (const facts of await this.deps.source.drivers(tenantId))
      if (await this.compare(tenantId, facts)) changed += 1;
    return changed;
  }

  private async compare(tenantId: string, facts: DriverFacts): Promise<boolean> {
    const { store, ingest } = this.deps;
    const at = this.deps.now().toISOString();
    const known = await store.driverState(tenantId, facts.id);
    if (known === null) {
      await store.saveDriverState({
        tenantId,
        driverId: facts.id,
        eligible: facts.eligible,
        transitions: 0,
        updatedAt: at,
      });
      return false;
    }
    if (known.eligible === facts.eligible) return false;
    const transitions = known.transitions + 1;
    await ingest.publish(tenantId, {
      eventId: eventIdOf(tenantId, `driver.eligibility_changed:${facts.id}:${transitions}`),
      type: 'driver.eligibility_changed',
      occurredAt: at,
      data: { driverId: facts.id, eligible: facts.eligible, reasons: facts.reasons },
    });
    await store.saveDriverState({
      tenantId,
      driverId: facts.id,
      eligible: facts.eligible,
      transitions,
      updatedAt: at,
    });
    return true;
  }
}
