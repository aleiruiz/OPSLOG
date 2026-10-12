import { describe, expect, it } from 'vitest';
import type { BffClient } from '@opslog/contracts';
import { baseOrder } from './fakePorts';
import { formatDate, formatKm, formatMoney, requirementLabel } from './labels';
import { createMaintenancePorts } from './ports';
import { toMinor } from './WorkEditor';
import { byScheduledDate, matches } from './WorkOrdersScreen';
import { availableCommands, canRecordCosts, canRecordWork, nextSteps } from './workflow';

const fleet = {
  permissions: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
  mechanicIds: [],
};
const editor = { permissions: ['view', 'create', 'edit'], mechanicIds: [] };
const mechanic = { permissions: ['view'], mechanicIds: ['mec-1'] };

describe('maintenance model', () => {
  it('formats exact money, dates and kilometers without floating point', () => {
    expect(formatMoney({ amountMinor: '999999999999999', currency: 'MXN' })).toBe(
      '9,999,999,999,999.99 MXN',
    );
    expect(formatMoney({ amountMinor: '5', currency: 'USD' })).toBe('0.05 USD');
    expect(formatMoney({ amountMinor: '1500', currency: 'JPY' })).toBe('1,500 JPY');
    expect(formatDate('2026-10-12')).toBe('12/10/2026');
    expect(formatDate(null)).toBe('Sin fecha');
    expect(formatKm(null)).toBe('Sin dato');
    expect(formatKm(1500)).toMatch(/1.?500 km/);
    expect(requirementLabel('unknown')).toBe('Falta un requisito del flujo.');
    expect(toMinor('1,250.5')).toBe('125050');
    expect(toMinor('0.05')).toBe('5');
    expect(toMinor('12')).toBe('1200');
    expect(toMinor('1.234')).toBeNull();
    expect(toMinor('-1')).toBeNull();
  });

  it('offers only the SPECS §6.1 commands the caller may run', () => {
    const at = (status: ReturnType<typeof baseOrder>['status'], extra = {}) =>
      baseOrder({ status, mechanicId: 'mec-1', ...extra });
    expect(availableCommands(at('scheduled'), fleet)).toEqual(['assign', 'cancel']);
    expect(availableCommands(at('assigned'), mechanic)).toEqual(['start']);
    expect(availableCommands(at('in_progress'), mechanic)).toEqual(['complete']);
    expect(availableCommands(at('in_progress'), { ...mechanic, mechanicIds: ['other'] })).toEqual(
      [],
    );
    expect(availableCommands(at('completed'), editor)).toEqual([]);
    expect(availableCommands(at('completed'), fleet)).toEqual(['approve_close', 'close']);
    expect(
      availableCommands(
        at('completed', { closeApproval: { approvedBy: 'u', approvedAt: 'x' } }),
        fleet,
      ),
    ).toEqual(['close']);
    expect(
      availableCommands(at('completed'), {
        permissions: ['view', 'incidents:approve'],
        mechanicIds: [],
      }),
    ).toEqual(['approve_close']);
    expect(availableCommands(at('closed'), fleet)).toEqual(['reopen']);
    expect(availableCommands(at('closed'), editor)).toEqual([]);
    expect(availableCommands(at('cancelled'), fleet)).toEqual([]);
    expect(canRecordWork(at('in_progress'), mechanic)).toBe(true);
    expect(canRecordWork(at('assigned'), mechanic)).toBe(false);
    expect(canRecordWork(at('closed'), fleet)).toBe(false);
    expect(canRecordCosts(at('completed'), editor)).toBe(false);
    expect(canRecordCosts(at('completed'), fleet)).toBe(true);
  });

  it('explains the next step or the structured missing requirements', () => {
    expect(nextSteps(baseOrder(), ['responsibleId', 'scheduledDate'])).toEqual([
      'Indica la persona responsable.',
      'Indica la fecha programada.',
    ]);
    const workshop = baseOrder({
      status: 'in_progress',
      vehicleProposal: { suggestedStatus: 'in_maintenance', eligibilityBlocked: true },
    });
    expect(nextSteps(workshop, [])).toHaveLength(2);
  });

  it('filters and groups the same orders for the list and the calendar', () => {
    const orders = [
      baseOrder({ id: 'a', scheduledDate: '2026-10-20', status: 'assigned' }),
      baseOrder({ id: 'b', scheduledDate: '2026-10-13', vehicleId: 'veh-002' }),
      baseOrder({ id: 'c' }),
    ];
    expect(
      orders
        .filter((o) => matches(o, { status: 'assigned', vehicleId: '', month: '' }))
        .map((o) => o.id),
    ).toEqual(['a']);
    expect(
      orders
        .filter((o) => matches(o, { status: '', vehicleId: 'veh-002', month: '2026-10' }))
        .map((o) => o.id),
    ).toEqual(['b']);
    const { days, undated } = byScheduledDate(orders);
    expect(days.map(([day]) => day)).toEqual(['2026-10-13', '2026-10-20']);
    expect(undated.map((o) => o.id)).toEqual(['c']);
  });

  it('maps every port to its contract route', async () => {
    const seen: string[] = [];
    const client = {
      call: async (id: string, input?: unknown) => {
        seen.push(`${id} ${JSON.stringify(input ?? {})}`);
        return { ok: true, value: null };
      },
    } as unknown as BffClient;
    const ports = createMaintenancePorts(client);
    await ports.orders.list();
    await ports.orders.get('o');
    await ports.orders.history('o');
    await ports.orders.createCorrective({ vehicleId: 'v', description: 'd' });
    await ports.orders.adoptPreventive({ planId: 'p', scheduledOrderId: 's' });
    await ports.orders.transition('o', { command: 'start', version: 2 }, 'key-12345678');
    await ports.orders.recordWork('o', { version: 3 });
    await ports.orders.recordCosts('o', { version: 4 });
    await ports.plans.list();
    await ports.plans.create({ vehicleId: 'v', intervalDays: 30 });
    await ports.plans.update('p', { version: 1 });
    await ports.plans.schedule('p');
    await ports.workshops.list();
    await ports.workshops.create({ name: 'T', specialties: [] });
    await ports.workshops.deactivate('w');
    await ports.mechanics.list();
    await ports.mechanics.create({ name: 'M', specialties: [], kind: 'external' });
    await ports.mechanics.deactivate('m');
    expect(seen.map((entry) => entry.split(' ')[0])).toEqual([
      'workOrders.list',
      'workOrders.get',
      'workOrders.history',
      'workOrders.create',
      'workOrders.adopt',
      'workOrders.transition',
      'workOrders.work',
      'workOrders.costs',
      'maintenance.plans.list',
      'maintenance.plans.create',
      'maintenance.plans.update',
      'maintenance.plans.schedule',
      'maintenance.workshops.list',
      'maintenance.workshops.create',
      'maintenance.workshops.deactivate',
      'maintenance.mechanics.list',
      'maintenance.mechanics.create',
      'maintenance.mechanics.deactivate',
    ]);
    expect(seen[5]).toContain('"orderId":"o"');
    // The key rides next to params and body so the client sends it as the Idempotency-Key header.
    expect(seen[5]).toContain('"idempotencyKey":"key-12345678"');
  });
});
