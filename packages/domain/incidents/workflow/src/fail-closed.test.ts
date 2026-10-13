import { describe, expect, it } from 'vitest';
import {
  FAIL_CLOSED_COSTS,
  FAIL_CLOSED_REPAIRS,
  FAIL_CLOSED_TOTALS,
  NO_CLOSURE_COSTS,
} from './fail-closed.js';

const ref = { tenantId: 'tenant-a', incidentId: 'incident-1' };

describe('ports without INC-COSTS', () => {
  it('report repairs, costs and totals as not available', async () => {
    await expect(FAIL_CLOSED_REPAIRS.linkedOrders('tenant-a', 'incident-1')).resolves.toEqual({
      available: false,
    });
    await expect(FAIL_CLOSED_COSTS.presence('tenant-a', 'incident-1')).resolves.toEqual({
      available: false,
    });
    await expect(FAIL_CLOSED_TOTALS.totals('tenant-a', 'incident-1')).resolves.toEqual({
      available: false,
    });
  });

  it('keep no closure costs or approval records', async () => {
    const request = {} as Parameters<typeof NO_CLOSURE_COSTS.snapshot>[0];
    await expect(NO_CLOSURE_COSTS.snapshot(request, undefined)).resolves.toBeUndefined();
    await expect(
      NO_CLOSURE_COSTS.recordApproval({ ...ref, kind: 'close' }, undefined),
    ).resolves.toBeUndefined();
    await expect(
      NO_CLOSURE_COSTS.approvalStale({ ...ref, kind: 'assumption' }, undefined),
    ).resolves.toBe(false);
  });
});
