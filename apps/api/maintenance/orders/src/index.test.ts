import { describe, expect, it } from 'vitest';
import type { Permission } from '../../../../../packages/domain/identity/src/index.js';
import { harness } from '../../../../../packages/domain/maintenance/orders/src/test-support.js';
import { WorkOrderApi } from './index.js';

const TENANT = 'tenant-a';
const sessions: Record<string, { subject: string; permissions: Permission[] }> = {
  admin: {
    subject: 'admin',
    permissions: ['view', 'create', 'edit', 'view_costs', 'approve', 'reopen'],
  },
  editor: { subject: 'editor', permissions: ['view', 'create', 'edit'] },
  mech: { subject: 'mech', permissions: ['view'] },
};

function api() {
  const h = harness();
  const workOrders = new WorkOrderApi({
    orders: h.service,
    authorize: async (token, correlationId) => {
      const session = sessions[token];
      if (!session) throw Object.assign(new Error('expired'), { code: 'expired' });
      return {
        context: {
          tenantId: TENANT,
          actor: { subject: session.subject, kind: 'user' },
          authorizationVersion: 1,
          correlationId,
        },
        permissions: session.permissions,
      };
    },
    mechanicIdsOfMember: async (_tenant, member) => (member === 'mech' ? ['mechanic-1'] : []),
  });
  return { h, workOrders };
}

describe('work order API', () => {
  it('runs the workflow with session identity and hides costs without view_costs', async () => {
    const { workOrders } = api();
    const created = await workOrders.createCorrective('admin', 'c1', {
      vehicleId: 'vehicle-1',
      description: 'Frenos',
    });
    expect(created.ok).toBe(true);
    const id = created.value?.id as string;
    expect(created.value).not.toHaveProperty('tenantId');
    expect(created.value?.createdBy).toBe('user-admin');
    const assigned = await workOrders.command('admin', 'c2', 'assign', id, {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      mechanicId: 'mechanic-1',
      scheduledDate: '2026-10-13',
    });
    const started = await workOrders.command('mech', 'c3', 'start', id, {
      version: assigned.value?.version,
    });
    expect(started.value?.vehicleProposal).toEqual({
      suggestedStatus: 'in_maintenance',
      eligibilityBlocked: true,
    });
    const worked = await workOrders.command('mech', 'c4', 'updateWork', id, {
      version: started.value?.version,
      parts: [{ name: 'Balata', quantity: '2' }],
    });
    const costed = await workOrders.command('admin', 'c5', 'updateCosts', id, {
      version: worked.value?.version,
      partCosts: [
        { partId: worked.value?.parts[0]?.id, unitCost: { amountMinor: '100', currency: 'MXN' } },
      ],
    });
    expect(costed.value?.parts[0]?.unitCost).toEqual({ amountMinor: '100', currency: 'MXN' });
    const editorView = await workOrders.get('editor', 'c6', id);
    expect(JSON.stringify(editorView.value)).not.toMatch(/MXN|"unitCost"|"costs"/);
    expect((await workOrders.list('mech', 'c7')).value?.map((order) => order.id)).toEqual([id]);
    expect((await workOrders.history('admin', 'c8', id)).value?.map((t) => t.command)).toEqual([
      'create',
      'assign',
      'start',
    ]);
    const preventive = await workOrders.adoptPreventive('admin', 'c9', {
      planId: 'plan-1',
      scheduledOrderId: 'missing',
    });
    expect(preventive.error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('maps failures to uniform codes with structured missing requirements', async () => {
    const { workOrders } = api();
    expect((await workOrders.list('nobody', 'c1')).error).toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    const created = await workOrders.createCorrective('editor', 'c2', {
      vehicleId: 'vehicle-1',
      description: 'x',
    });
    const id = created.value?.id as string;
    expect((await workOrders.command('editor', 'c3', 'assign', id, { version: 1 })).error).toEqual({
      code: 'missing_requirements',
      status: 422,
      message: 'Work order request rejected: missing_requirements',
      missingRequirements: ['responsibleId', 'scheduledDate', 'workshopOrMechanic'],
    });
    expect(
      (await workOrders.command('editor', 'c4', 'start', id, { version: 1 })).error?.status,
    ).toBe(409);
    expect(
      (await workOrders.command('editor', 'c5', 'reopen', id, { version: 1, reason: 'x' })).error,
    ).toMatchObject({ code: 'forbidden', status: 403 });
    expect(
      (await workOrders.command('mech', 'c6', 'start', id, { version: 1 })).error,
    ).toMatchObject({ code: 'not_found', status: 404 });
    expect((await workOrders.command('editor', 'c7', 'assign', id, 'nope')).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
    expect((await workOrders.get('admin', 'c8', 'bad id!')).error?.status).toBe(400);
  });

  it('never leaks internal errors', async () => {
    const { h, workOrders } = api();
    h.refs.vehicleExists = async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    };
    const result = await workOrders.createCorrective('admin', 'c1', {
      vehicleId: 'vehicle-1',
      description: 'x',
    });
    expect(result.error).toEqual({
      code: 'internal_error',
      status: 500,
      message: 'Request failed',
    });
  });
});
