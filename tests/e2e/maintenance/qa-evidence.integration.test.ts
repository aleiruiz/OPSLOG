import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_TABLES } from '../../../packages/persistence/audit/src/index.js';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/index.js';
import type {
  WorkOrder,
  WorkOrderActor,
  WorkOrderService,
} from '../../../packages/domain/maintenance/orders/src/index.js';
import {
  ACTORS,
  VEHICLE,
  adminUrl,
  startMaintenanceWorld,
  type MaintenanceWorld,
} from './qa-world.js';

const suite = adminUrl ? describe : describe.skip;
const code = async (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (error: { code?: string; missingRequirements?: string[] }) =>
      error.missingRequirements?.length
        ? `${error.code}:${error.missingRequirements.join(',')}`
        : String(error.code),
  );
const REQUIRED = { evidence: true, invoice: true };

// G3 H3: evidence and invoices of work orders on real MySQL 8.4 with synthetic tenants A and B.
suite('work order evidence and invoices on MySQL 8.4', () => {
  let world: MaintenanceWorld;
  beforeAll(async () => {
    world = await startMaintenanceWorld('qa_evidence');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  }, 60_000);

  let sequence = 0;
  const file = (
    owner: WorkOrderActor,
    status: 'clean' | 'pending_scan' | 'pending_upload' = 'clean',
  ) => {
    const id = `qa-file-${(sequence += 1)}`;
    world.registerFile(world.tenantA, id, owner, { status });
    return id;
  };
  const attach = (
    service: WorkOrderService,
    actor: WorkOrderActor,
    order: WorkOrder,
    kind: 'evidence' | 'invoice',
    fileId: string,
  ) =>
    service.attachFile(world.tenantA, actor, order.id, {
      version: order.version,
      kind,
      fileId,
    });

  async function inProgress(service: WorkOrderService, description = 'Evidencia QA') {
    const t = world.tenantA;
    let order = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description,
    });
    order = await service.assign(t, ACTORS.editor, order.id, {
      version: order.version,
      responsibleId: 'editor',
      workshopId: 'workshop-1',
      mechanicId: 'mechanic-a',
      scheduledDate: '2026-10-12',
    });
    order = await service.start(t, world.mechanic, order.id, { version: order.version });
    return service.updateWork(t, world.mechanic, order.id, {
      version: order.version,
      tasks: [{ description: 'Reparación' }],
    });
  }
  const complete = (service: WorkOrderService, order: WorkOrder) =>
    service.complete(world.tenantA, world.mechanic, order.id, {
      version: order.version,
      actualDate: '2026-10-12',
      actualKm: 1200,
    });

  it('blocks completion and closure until persisted evidence and invoice exist, then lets both through', async () => {
    const service = world.service({ required: REQUIRED });
    const t = world.tenantA;
    const order = await inProgress(service);
    expect(await code(complete(service, order))).toBe('missing_requirements:evidence,invoice');

    // An upload intent is not linkable; a queued (quarantined) file links but does not count yet.
    expect(
      await code(
        attach(service, world.mechanic, order, 'evidence', file(world.mechanic, 'pending_upload')),
      ),
    ).toBe('invalid_association');
    const queuedId = file(world.mechanic, 'pending_scan');
    const queued = await attach(service, world.mechanic, order, 'evidence', queuedId);
    expect(await code(complete(service, queued))).toBe('missing_requirements:evidence,invoice');

    world.registerFile(t, queuedId, world.mechanic, { status: 'clean' });
    expect(await code(complete(service, queued))).toBe('missing_requirements:invoice');
    const invoiced = await attach(service, ACTORS.admin, queued, 'invoice', file(ACTORS.admin));
    const done = await complete(service, invoiced);
    expect(done.status).toBe('completed');

    // Removing the evidence after completion blocks the closure again.
    const evidence = (await service.listFiles(t, ACTORS.admin, order.id)).find(
      (view) => view.kind === 'evidence',
    );
    const stripped = await service.detachFile(t, ACTORS.admin, order.id, {
      version: done.version,
      attachmentId: evidence?.id as string,
    });
    const close = (current: WorkOrder) =>
      service.close(t, ACTORS.admin, order.id, {
        version: current.version,
        vehicleStatus: 'active',
      });
    expect(await code(close(stripped))).toBe('missing_requirements:evidence');
    const restored = await attach(service, ACTORS.admin, stripped, 'evidence', file(ACTORS.admin));
    expect((await close(restored)).status).toBe('closed');

    // Links, history and audit are all there; nothing travelled in the outbox.
    const links = await world.db.rows<{ kind: string }>(
      `SELECT kind FROM ${WORK_ORDER_TABLES.files} WHERE company_id=? AND order_id=? ORDER BY attached_at, id`,
      [t, order.id],
    );
    expect(links.map((link) => link.kind).sort()).toEqual(['evidence', 'invoice']);
    const history = await world.db.rows<{ command: string }>(
      `SELECT command FROM ${WORK_ORDER_TABLES.transitions} WHERE company_id=? AND order_id=? ORDER BY sequence`,
      [t, order.id],
    );
    expect(history.map((entry) => entry.command)).toEqual([
      'create',
      'assign',
      'start',
      'evidence_attached',
      'invoice_attached',
      'complete',
      'evidence_detached',
      'evidence_attached',
      'close',
    ]);
    const [audit] = await world.db.rows<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${AUDIT_TABLES.local} WHERE tenant_id=? AND entity_id=?`,
      [t, order.id],
    );
    // One audit row per version: work edits, file changes and commands alike.
    expect(Number(audit?.total)).toBeGreaterThanOrEqual(history.length);
    const outbox = await world.db.rows<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=?`,
      [t, order.id],
    );
    expect(outbox.map((event) => event.type).every((type) => type.startsWith('maintenance.'))).toBe(
      true,
    );
    expect(JSON.stringify(outbox)).not.toMatch(/qa-file|evidence|invoice|\.pdf|displayName/);
  });

  it('asks nothing by default and lets the assigned mechanic complete without files', async () => {
    const service = world.service();
    const order = await inProgress(service, 'Sin requisitos');
    expect((await complete(service, order)).status).toBe('completed');
  });

  it('applies D9 and view_costs to who attaches, detaches and reads evidence and invoices', async () => {
    const service = world.service();
    const t = world.tenantA;
    const order = await inProgress(service, 'Permisos');
    const evidence = await attach(service, world.mechanic, order, 'evidence', file(world.mechanic));
    for (const actor of [world.mechanic, ACTORS.editor, ACTORS.viewer])
      expect(await code(attach(service, actor, evidence, 'invoice', file(actor)))).toBe(
        'forbidden',
      );
    // A viewer cannot add evidence either; a mechanic of another order does not even see this one.
    expect(
      await code(attach(service, ACTORS.viewer, evidence, 'evidence', file(ACTORS.viewer))),
    ).toBe('forbidden');
    const other = { ...world.mechanic, id: 'user-mech2', mechanicIds: ['mechanic-z'] };
    expect(await code(attach(service, other, evidence, 'evidence', file(other)))).toBe('not_found');
    const invoiced = await attach(service, ACTORS.admin, evidence, 'invoice', file(ACTORS.admin));
    expect((await service.listFiles(t, ACTORS.admin, order.id)).map((v) => v.kind).sort()).toEqual([
      'evidence',
      'invoice',
    ]);
    for (const actor of [world.mechanic, ACTORS.editor])
      expect((await service.listFiles(t, actor, order.id)).map((v) => v.kind)).toEqual([
        'evidence',
      ]);
    const invoice = (await service.listFiles(t, ACTORS.admin, order.id)).find(
      (view) => view.kind === 'invoice',
    );
    expect(await code(service.fileLink(t, ACTORS.editor, order.id, invoice?.id as string))).toBe(
      'not_found',
    );
    expect(
      await code(
        service.detachFile(t, world.mechanic, order.id, {
          version: invoiced.version,
          attachmentId: invoice?.id,
        }),
      ),
    ).toBe('forbidden');
    // The assigned mechanic may take back their own evidence while the work is in progress.
    const mine = (await service.listFiles(t, world.mechanic, order.id)).find(
      (view) => view.kind === 'evidence',
    );
    expect(
      await code(
        service.detachFile(t, world.mechanic, order.id, {
          version: invoiced.version,
          attachmentId: mine?.id,
        }),
      ),
    ).toBe('ok');
  });

  it('keeps tenants A and B apart and links a file only once', async () => {
    const service = world.service();
    const serviceB = world.service({ side: 'b' });
    const t = world.tenantA;
    const order = await inProgress(service, 'Aislamiento');
    const fileId = file(world.mechanic);
    const linked = await attach(service, world.mechanic, order, 'evidence', fileId);

    // Tenant B neither sees the order nor can use tenant A's file id.
    expect(await code(serviceB.listFiles(world.tenantB, ACTORS.admin, order.id))).toBe('not_found');
    expect(
      await code(
        serviceB.attachFile(world.tenantB, ACTORS.admin, order.id, {
          version: order.version,
          kind: 'evidence',
          fileId,
        }),
      ),
    ).toBe('not_found');
    expect(await code(service.listFiles(world.tenantB, ACTORS.admin, order.id))).toBe('not_found');
    const [leak] = await world.db.rowsB<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${WORK_ORDER_TABLES.files}`,
    );
    expect(Number(leak?.total)).toBe(0);

    // The same file cannot be linked to a second order of the tenant (unique key), nor to this one twice.
    const second = await inProgress(service, 'Segunda orden');
    expect(await code(attach(service, world.mechanic, second, 'evidence', fileId))).toBe(
      'duplicate',
    );
    expect(await code(attach(service, world.mechanic, linked, 'evidence', fileId))).toBe(
      'duplicate',
    );
    // A file uploaded by someone else, or unknown, looks the same.
    world.registerFile(t, 'qa-foreign', ACTORS.admin);
    expect(await code(attach(service, world.mechanic, second, 'evidence', 'qa-foreign'))).toBe(
      'not_found',
    );
    expect(await code(attach(service, world.mechanic, second, 'evidence', 'qa-unknown'))).toBe(
      'not_found',
    );
  });

  it('lets exactly one of two concurrent attaches of the same version win', async () => {
    const a = world.service();
    const a2 = world.service({ side: 'a2' });
    const order = await inProgress(a, 'Concurrencia');
    const results = await Promise.all([
      code(attach(a, world.mechanic, order, 'evidence', file(world.mechanic))),
      code(attach(a2, world.mechanic, order, 'evidence', file(world.mechanic))),
    ]);
    expect(results.sort()).toEqual(['ok', 'stale_version']);
    expect(await a.listFiles(world.tenantA, ACTORS.admin, order.id)).toHaveLength(1);
  });

  it('freezes evidence and invoices once the order is closed or cancelled, and the runtime cannot edit links', async () => {
    const service = world.service();
    const t = world.tenantA;
    const order = await inProgress(service, 'Inmutable');
    const withEvidence = await attach(
      service,
      world.mechanic,
      order,
      'evidence',
      file(world.mechanic),
    );
    const done = await complete(service, withEvidence);
    const closed = await service.close(t, ACTORS.admin, order.id, {
      version: done.version,
      vehicleStatus: 'restricted',
    });
    const [link] = await service.listFiles(t, ACTORS.admin, order.id);
    expect(await code(attach(service, ACTORS.admin, closed, 'evidence', file(ACTORS.admin)))).toBe(
      'invalid_transition',
    );
    expect(await code(attach(service, ACTORS.admin, closed, 'invoice', file(ACTORS.admin)))).toBe(
      'invalid_transition',
    );
    expect(
      await code(
        service.detachFile(t, ACTORS.admin, order.id, {
          version: closed.version,
          attachmentId: link?.id,
        }),
      ),
    ).toBe('invalid_transition');
    expect(await service.listFiles(t, ACTORS.admin, order.id)).toHaveLength(1);

    const cancelled = await service.createCorrective(t, ACTORS.editor, {
      vehicleId: VEHICLE,
      description: 'Cancelada',
    });
    const gone = await service.cancel(t, ACTORS.editor, cancelled.id, {
      version: cancelled.version,
      reason: 'Duplicada',
    });
    expect(await code(attach(service, ACTORS.editor, gone, 'evidence', file(ACTORS.editor)))).toBe(
      'invalid_transition',
    );
    // Reopening makes it editable again; the evidence survived.
    const reopened = await service.reopen(t, ACTORS.admin, order.id, {
      version: closed.version,
      reason: 'Corrección',
    });
    expect(await service.listFiles(t, ACTORS.admin, order.id)).toHaveLength(1);
    expect(
      await code(attach(service, ACTORS.admin, reopened, 'evidence', file(ACTORS.admin))),
    ).toBe('ok');

    // The runtime account may insert and delete links but never rewrite them.
    const denied = await world.ordersSourceA
      .query(`UPDATE ${WORK_ORDER_TABLES.files} SET kind='invoice' WHERE company_id=?`, [t])
      .then(
        () => 'ok',
        (error: { errno?: number; driverError?: { errno?: number } }) =>
          error.driverError?.errno ?? error.errno,
      );
    expect(denied).toBe(1142);
  });
});
