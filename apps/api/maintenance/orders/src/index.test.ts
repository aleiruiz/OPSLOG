import { describe, expect, it } from 'vitest';
import type { Permission } from '../../../../../packages/domain/identity/src/index.js';
import {
  EDITOR as EDITOR_ACTOR,
  harness,
} from '../../../../../packages/domain/maintenance/orders/src/test-support.js';
import { WorkOrderApi } from './index.js';

const TENANT = 'tenant-a';
const sessions: Record<string, { subject: string; permissions: Permission[] }> = {
  admin: {
    subject: 'admin',
    permissions: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
  },
  editor: { subject: 'editor', permissions: ['view', 'create', 'edit'] },
  mech: { subject: 'mech', permissions: ['view'] },
  // Can reopen but never sees amounts; `reopener2` is the same person after being granted view_costs.
  reopener: { subject: 'reopener', permissions: ['view', 'reopen'] },
};

function api() {
  const h = harness();
  const stored: { actorId: string; name: string; bytes: Uint8Array }[] = [];
  const files = {
    ingest: async (
      tenantId: string,
      actorId: string,
      _correlationId: string,
      input: { name: string; contentType: string; bytes: Uint8Array },
    ) => {
      const id = `file-${stored.length + 1}`;
      stored.push({ actorId, name: input.name, bytes: input.bytes });
      h.refs.files.set(id, {
        id,
        status: 'pending_scan',
        kind: 'original',
        sensitivity: 'standard',
        createdBy: actorId,
        displayName: input.name,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
      });
      return { id };
    },
    read: async (_token: string, _correlationId: string, fileId: string) =>
      stored[Number(fileId.slice(5)) - 1]!.bytes,
  };
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
    files,
  });
  return { h, workOrders, stored };
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

  async function started() {
    const ctx = api();
    const created = await ctx.workOrders.createCorrective('admin', 'f0', {
      vehicleId: 'vehicle-1',
      description: 'Frenos',
    });
    const id = created.value?.id as string;
    const assigned = await ctx.workOrders.command('admin', 'f1', 'assign', id, {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      mechanicId: 'mechanic-1',
      scheduledDate: '2026-10-13',
    });
    const run = await ctx.workOrders.command('mech', 'f2', 'start', id, {
      version: assigned.value?.version,
    });
    return { ...ctx, id, version: run.value?.version as number };
  }
  const upload = (kind: string, bytes = 'JVBERi0xLjQK') => ({
    kind,
    name: 'foto.pdf',
    contentType: 'application/pdf',
    contentBase64: bytes,
  });

  it('uploads evidence for the assigned mechanic, lists it and serves it back without file ids', async () => {
    const { workOrders, stored, id, version } = await started();
    const uploaded = await workOrders.uploadFile('mech', 'u1', id, {
      version,
      ...upload('evidence'),
    });
    expect(uploaded.ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actorId: 'user-mech', name: 'foto.pdf' });
    const listed = await workOrders.listFiles('mech', 'u2', id);
    expect(listed.value).toEqual([
      expect.objectContaining({
        kind: 'evidence',
        displayName: 'foto.pdf',
        fileStatus: 'pending_scan',
      }),
    ]);
    expect(JSON.stringify(listed.value)).not.toMatch(/fileId|file-1|sha256|tenant/);
    const link = listed.value?.[0]?.id as string;
    const content = await workOrders.fileContent('mech', 'u3', id, link);
    expect(Buffer.from(content.value?.contentBase64 ?? '', 'base64').toString('latin1')).toBe(
      '%PDF-1.4\n',
    );
    expect((await workOrders.fileContent('editor', 'u4', id, link)).ok).toBe(true);
    expect((await workOrders.fileContent('nobody', 'u4', id, link)).error?.code).toBe(
      'unauthorized',
    );
    const removed = await workOrders.detachFile('mech', 'u5', id, link, {
      version: uploaded.value?.version,
    });
    expect(removed.ok).toBe(true);
    expect((await workOrders.listFiles('mech', 'u6', id)).value).toEqual([]);
  });

  it('checks permission, status and version before storing a single byte', async () => {
    const { workOrders, stored, id, version } = await started();
    // Invoices are cost data: the mechanic and the editor are refused, and nothing is stored.
    for (const session of ['mech', 'editor'])
      expect(
        (await workOrders.uploadFile(session, 'p1', id, { version, ...upload('invoice') })).error
          ?.code,
      ).toBe('forbidden');
    expect(
      (await workOrders.uploadFile('admin', 'p2', id, { version: 1, ...upload('evidence') })).error
        ?.code,
    ).toBe('stale_version');
    expect(stored).toHaveLength(0);
    // The invoice is invisible to a caller without view_costs, and downloadable only with it.
    const invoice = await workOrders.uploadFile('admin', 'p3', id, {
      version,
      ...upload('invoice'),
    });
    expect(invoice.ok).toBe(true);
    expect((await workOrders.listFiles('mech', 'p4', id)).value).toEqual([]);
    const adminList = await workOrders.listFiles('admin', 'p5', id);
    expect(adminList.value?.map((file) => file.kind)).toEqual(['invoice']);
    expect(
      (await workOrders.fileContent('mech', 'p6', id, adminList.value?.[0]?.id as string)).error
        ?.code,
    ).toBe('not_found');
  });

  it('rejects malformed uploads with 400 and stores nothing', async () => {
    const { workOrders, stored, id, version } = await started();
    const bad: unknown[] = [
      null,
      [],
      { version, ...upload('photo') },
      { version, ...upload('evidence', '') },
      { version, ...upload('evidence', 'not base64!') },
      { version, ...upload('evidence', 'abc') },
      { version, ...upload('evidence'), extra: 1 },
      { version, ...upload('evidence'), name: '' },
      { version, ...upload('evidence'), name: 'x'.repeat(201) },
      { version, ...upload('evidence'), contentType: 7 },
      { ...upload('evidence'), version: 'x' },
    ];
    for (const input of bad)
      expect((await workOrders.uploadFile('mech', 'b1', id, input)).error?.status).toBe(400);
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 3).toString('base64');
    expect(
      (await workOrders.uploadFile('mech', 'b2', id, { version, ...upload('evidence', tooBig) }))
        .error?.status,
    ).toBe(400);
    expect(stored).toHaveLength(0);
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

  it('fails closed: a member whose mechanic link is deactivated sees no orders, not all of them', async () => {
    const h = harness();
    const created = await h.service.createCorrective(TENANT, EDITOR_ACTOR, {
      vehicleId: 'vehicle-1',
      description: 'Frenos',
    });
    let linked = true;
    const workOrders = new WorkOrderApi({
      orders: h.service,
      authorize: async (_token, correlationId) => ({
        context: {
          tenantId: TENANT,
          actor: { subject: 'mech', kind: 'user' },
          authorizationVersion: 1,
          correlationId,
        },
        permissions: ['view'],
      }),
      mechanicIdsOfMember: async () => [],
      mechanicLinked: async () => linked,
      files: {
        ingest: async () => ({ id: 'unused' }),
        read: async () => new Uint8Array(),
      },
    });
    expect(await workOrders.list('mech', 'c1')).toMatchObject({ ok: true, value: [] });
    expect(await workOrders.get('mech', 'c2', created.id)).toMatchObject({
      ok: false,
      error: { status: 404 },
    });
    linked = false;
    expect(((await workOrders.list('mech', 'c3')).value ?? []).length).toBe(1);
  });

  it('replays an idempotent transition filtered for the caller, not for whoever sent the first one', async () => {
    const { workOrders, h } = api();
    const created = await workOrders.createCorrective('admin', 'i0', {
      vehicleId: 'vehicle-1',
      description: 'Frenos',
    });
    const id = created.value?.id as string;
    const assigned = await workOrders.transition('admin', 'i1', 'assign', id, {
      version: 1,
      responsibleId: 'fleet',
      workshopId: 'workshop-1',
      mechanicId: 'mechanic-1',
      scheduledDate: '2026-10-13',
    });
    const started = await workOrders.transition('mech', 'i2', 'start', id, {
      version: assigned.value?.version,
    });
    const worked = await workOrders.command('mech', 'i3', 'updateWork', id, {
      version: started.value?.version,
      tasks: [{ description: 'Balatas' }],
    });
    const costed = await workOrders.command('admin', 'i4', 'updateCosts', id, {
      version: worked.value?.version,
      costs: [{ category: 'labor', amount: { amountMinor: '5000', currency: 'MXN' } }],
    });
    const completed = await workOrders.transition('mech', 'i5', 'complete', id, {
      version: costed.value?.version,
      actualDate: '2026-10-12',
      actualKm: 1500,
    });
    const close = { version: completed.value?.version, vehicleStatus: 'active' };
    // Both commands need the key; the API answers before touching the order.
    expect((await workOrders.transition('admin', 'i6', 'close', id, close)).error).toMatchObject({
      code: 'idempotency_key_required',
      status: 400,
    });
    const closed = await workOrders.transition('admin', 'i7', 'close', id, close, 'close-key-0001');
    expect(closed.value?.costs).toHaveLength(1);
    const replay = await workOrders.transition('admin', 'i8', 'close', id, close, 'close-key-0001');
    expect(replay).toEqual(closed);
    expect(
      (
        await workOrders.transition(
          'admin',
          'i9',
          'close',
          id,
          { ...close, comment: 'x' },
          'close-key-0001',
        )
      ).error,
    ).toMatchObject({ code: 'idempotency_conflict', status: 409 });

    // Reopen by a caller without view_costs: the stored result keeps the amounts, the view hides them.
    const reopen = { version: closed.value?.version, reason: 'Falta factura' };
    const first = await workOrders.transition(
      'reopener',
      'j1',
      'reopen',
      id,
      reopen,
      'reopen-key-001',
    );
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first.value)).not.toMatch(/MXN|"unitCost"|"costs"/);
    sessions['reopener']!.permissions = ['view', 'reopen', 'view_costs'];
    const promoted = await workOrders.transition(
      'reopener',
      'j2',
      'reopen',
      id,
      reopen,
      'reopen-key-001',
    );
    expect(promoted.value?.costs).toHaveLength(1);
    expect({ ...promoted.value, costs: undefined }).toEqual({ ...first.value, costs: undefined });
    sessions['reopener']!.permissions = ['view', 'reopen'];
    expect(
      JSON.stringify(
        (await workOrders.transition('reopener', 'j3', 'reopen', id, reopen, 'reopen-key-001'))
          .value,
      ),
    ).not.toMatch(/MXN|"costs"/);
    expect(
      h.store.events.filter((e) => e.event.type === 'maintenance.status_changed'),
    ).toHaveLength(5);
  });
});
