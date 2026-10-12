import { describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_PLAN_SCAN_EVENT,
  PREVENTIVE_ORDER_ADOPTED_EVENT,
  PREVENTIVE_ORDER_CANCELLED_EVENT,
  PREVENTIVE_ORDER_CLOSED_EVENT,
  PREVENTIVE_ORDER_REOPENED_EVENT,
  registerMaintenancePlanHandlers,
} from './index.js';

describe('maintenance plan outbox handlers', () => {
  it('takes the tenant from the claimed envelope and dispatches a scan', async () => {
    const handlers = new Map<
      string,
      (
        payload: unknown,
        event: { tenantId: string; eventId: string; type: string },
      ) => void | Promise<void>
    >();
    const plans = { scan: vi.fn(async () => []), consumeClosure: vi.fn(async () => undefined) };
    registerMaintenancePlanHandlers(
      { register: (type, handler) => handlers.set(type, handler) },
      plans as never,
    );
    await handlers.get(MAINTENANCE_PLAN_SCAN_EVENT)?.(
      { planId: 'plan-a' },
      { tenantId: 'tenant-a', eventId: 'event-a', type: MAINTENANCE_PLAN_SCAN_EVENT },
    );
    expect(plans.scan).toHaveBeenCalledExactlyOnceWith('tenant-a', 'plan-a');
  });
  it('rejects untrusted extra fields and applies closure idempotently through the domain port', async () => {
    const handlers = new Map<
      string,
      (
        payload: unknown,
        event: { tenantId: string; eventId: string; type: string },
      ) => void | Promise<void>
    >();
    const plans = { scan: vi.fn(async () => []), consumeClosure: vi.fn(async () => undefined) };
    registerMaintenancePlanHandlers(
      { register: (type, handler) => handlers.set(type, handler) },
      plans as never,
    );
    const close = handlers.get(PREVENTIVE_ORDER_CLOSED_EVENT)!;
    await expect(
      close(
        {
          planId: 'p',
          occurrenceId: 'o',
          orderId: 'x',
          kind: 'preventive',
          completedAt: '2026-01-01T00:00:00Z',
          actualDate: '2026-01-01',
          actualKm: 10,
          tenantId: 'tenant-b',
        },
        { tenantId: 'tenant-a', eventId: 'e', type: PREVENTIVE_ORDER_CLOSED_EVENT },
      ),
    ).rejects.toThrow('invalid maintenance job');
    await close(
      {
        planId: 'p',
        occurrenceId: 'o',
        orderId: 'x',
        kind: 'corrective',
        completedAt: '2026-01-01T00:00:00Z',
        actualDate: '2026-01-01',
        actualKm: 10,
      },
      { tenantId: 'tenant-a', eventId: 'e', type: PREVENTIVE_ORDER_CLOSED_EVENT },
    );
    expect(plans.consumeClosure).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', eventId: 'e', kind: 'corrective' }),
    );
  });
  it('routes reopen, cancel and adopt events to the domain with the envelope tenant and order version', async () => {
    const handlers = new Map<
      string,
      (
        payload: unknown,
        event: { tenantId: string; eventId: string; type: string },
      ) => void | Promise<void>
    >();
    const plans = {
      consumeReopened: vi.fn(async () => undefined),
      consumeCancelled: vi.fn(async () => undefined),
      consumeAdopted: vi.fn(async () => undefined),
    };
    registerMaintenancePlanHandlers(
      { register: (type, handler) => handlers.set(type, handler) },
      plans as never,
    );
    const payload = { planId: 'p', occurrenceId: 'o', orderId: 'x', version: 7 };
    const routes = [
      [PREVENTIVE_ORDER_REOPENED_EVENT, plans.consumeReopened],
      [PREVENTIVE_ORDER_CANCELLED_EVENT, plans.consumeCancelled],
      [PREVENTIVE_ORDER_ADOPTED_EVENT, plans.consumeAdopted],
    ] as const;
    for (const [type, consume] of routes) {
      const handler = handlers.get(type)!;
      await handler(payload, { tenantId: 'tenant-a', eventId: 'e', type });
      expect(consume).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        eventId: 'e',
        planId: 'p',
        occurrenceId: 'o',
        orderId: 'x',
        version: 7,
      });
      await expect(
        handler({ ...payload, tenantId: 'tenant-b' }, { tenantId: 'tenant-a', eventId: 'e', type }),
      ).rejects.toThrow('invalid maintenance job');
      await expect(
        handler({ ...payload, version: 'x' }, { tenantId: 'tenant-a', eventId: 'e', type }),
      ).rejects.toThrow('invalid maintenance lifecycle event');
    }
  });
});
