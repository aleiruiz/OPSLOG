import {
  ADMIN,
  MANAGER,
  NOW,
  TENANT_A,
  TENANT_B,
  VIEWER,
  actorOf,
  caseIn,
  setup as repairsSetup,
} from '../../repairs/src/test-support.js';
import { CostLedger } from './ledger.js';
import type { PolicyDeductible, PolicyDeductibles } from './ports.js';
import { IncidentCostService } from './service.js';
import { InMemoryIncidentCostStore } from './store.js';

export { ADMIN, MANAGER, NOW, TENANT_A, TENANT_B, VIEWER, actorOf, caseIn };

export class FakeDeductibles implements PolicyDeductibles {
  public value: PolicyDeductible | null = null;
  public fail = false;
  public async deductible(): Promise<PolicyDeductible | null> {
    if (this.fail) throw new Error('policy unavailable');
    return this.value;
  }
}

/** The repairs world plus the costs of INC-COSTS over the in-memory store. */
export function setup(now: () => Date = () => NOW) {
  const world = repairsSetup(now);
  const costs = new InMemoryIncidentCostStore(world.store);
  const ledger = new CostLedger(costs, world.links, world.orders);
  const deductibles = new FakeDeductibles();
  const service = new IncidentCostService(world.store, costs, ledger, deductibles, world.options);
  return { ...world, costs, ledger, deductibles, costService: service };
}
export type World = ReturnType<typeof setup>;

export const line = (
  kind: 'expense' | 'recovery',
  category: string,
  amountMinor: string,
  currency = 'MXN',
  extra: Record<string, unknown> = {},
) => ({ kind, category, amount: { amountMinor, currency }, ...extra });
