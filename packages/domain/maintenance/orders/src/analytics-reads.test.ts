import { describe, expect, it } from 'vitest';
import { InMemoryWorkOrderStore } from './store.js';
import type { WorkOrder } from './types.js';

const order = (over: Partial<WorkOrder>): WorkOrder => ({
  id: 'o1',
  tenantId: 'tenant-a',
  kind: 'corrective',
  vehicleId: 'v1',
  planId: null,
  occurrenceId: null,
  status: 'closed',
  version: 1,
  description: 'texto libre que no debe salir',
  responsibleId: null,
  workshopId: null,
  mechanicId: null,
  scheduledDate: '2026-10-10',
  requiresWorkshop: false,
  startedAt: null,
  completedAt: null,
  actualDate: '2026-10-11',
  actualKm: null,
  tasks: [],
  parts: [],
  costs: [{ id: 'c1', category: 'labor', amount: { amountMinor: '1500', currency: 'MXN' } }],
  closeApproval: null,
  closedAt: '2026-10-11T12:00:00.000Z',
  closedBy: 'u1',
  vehicleStatusDecision: 'active',
  cancelReason: null,
  reopenCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2026-10-11T12:00:00.000Z',
  updatedBy: 'u1',
  ...over,
});

const put = (store: InMemoryWorkOrderStore, value: WorkOrder) =>
  store.apply({
    order: value,
    expectedVersion: null,
    transition: null,
    auditAction: 'test',
    events: [],
  });

describe('InMemoryWorkOrderStore.closedFacts', () => {
  it('returns closed orders of the tenant in [from, to) with dates and money only', async () => {
    const store = new InMemoryWorkOrderStore();
    await put(store, order({ id: 'in' }));
    await put(store, order({ id: 'edge', closedAt: '2026-10-12T00:00:00.000Z' }));
    await put(store, order({ id: 'open', status: 'in_progress', closedAt: null }));
    await put(store, order({ id: 'other', tenantId: 'tenant-b' }));
    const window = { from: '2026-10-11T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' };
    const facts = await store.closedFacts('tenant-a', window);
    expect(facts).toEqual([
      {
        vehicleId: 'v1',
        kind: 'corrective',
        scheduledDate: '2026-10-10',
        actualDate: '2026-10-11',
        costs: [{ amountMinor: '1500', currency: 'MXN' }],
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('texto libre');
  });
});
