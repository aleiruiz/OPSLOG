import { describe, expect, it } from 'vitest';
import { WorkOrderError } from './errors.js';
import { ADMIN, EDITOR, FLEET, MECHANIC, OTHER_MECHANIC, TENANT, harness } from './test-support.js';
import type { Harness } from './test-support.js';
import type { WorkOrder, WorkOrderFileRecord } from './types.js';
import type { WorkOrderActor } from './workflow.js';

const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkOrderError)
      return error.missingRequirements.length
        ? `${error.code}:${error.missingRequirements.join(',')}`
        : error.code;
    throw error;
  }
  return 'ok';
};

const file = (
  h: Harness,
  id: string,
  owner: WorkOrderActor,
  over: Partial<WorkOrderFileRecord> = {},
): string => {
  h.refs.files.set(id, {
    id,
    status: 'clean',
    kind: 'original',
    sensitivity: 'standard',
    createdBy: owner.id,
    displayName: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 10,
    ...over,
  });
  return id;
};

async function inProgress(h = harness()) {
  const order = await h.service.createCorrective(TENANT, FLEET, {
    vehicleId: 'vehicle-1',
    description: 'Frenos',
  });
  const assigned = await h.service.assign(TENANT, FLEET, order.id, {
    version: 1,
    responsibleId: 'fleet',
    workshopId: 'workshop-1',
    mechanicId: 'mechanic-1',
    scheduledDate: '2026-10-13',
  });
  const started = await h.service.start(TENANT, MECHANIC, order.id, { version: assigned.version });
  const worked = await h.service.updateWork(TENANT, MECHANIC, order.id, {
    version: started.version,
    tasks: [{ description: 'Cambio de balatas' }],
  });
  return { h, order: worked };
}

const complete = (h: Harness, order: WorkOrder, actor: WorkOrderActor = MECHANIC) =>
  h.service.complete(TENANT, actor, order.id, {
    version: order.version,
    actualDate: '2026-10-12',
    actualKm: 1500,
  });

describe('configured evidence and invoice requirements (G3 H3)', () => {
  it('asks for nothing by default', async () => {
    const { h, order } = await inProgress();
    expect(await code(complete(h, order))).toBe('ok');
  });

  it('blocks completion with the structured missing evidence until a persisted file is attached', async () => {
    const { h, order } = await inProgress();
    h.refs.required = { evidence: true, invoice: false };
    expect(await code(complete(h, order))).toBe('missing_requirements:evidence');
    // An upload intent can never be linked, and a file still in quarantine does not count.
    file(h, 'f-intent', MECHANIC, { status: 'pending_upload' });
    expect(
      await code(
        h.service.attachFile(TENANT, MECHANIC, order.id, {
          version: order.version,
          kind: 'evidence',
          fileId: 'f-intent',
        }),
      ),
    ).toBe('invalid_association');
    file(h, 'f-queued', MECHANIC, { status: 'pending_scan' });
    const queued = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-queued',
    });
    expect(await code(complete(h, queued))).toBe('missing_requirements:evidence');
    // Once the files module releases it, it counts.
    h.refs.files.set('f-queued', { ...h.refs.files.get('f-queued')!, status: 'clean' });
    expect(await code(complete(h, queued))).toBe('ok');
  });

  it('a rejected file never counts', async () => {
    const { h, order } = await inProgress();
    h.refs.required = { evidence: true, invoice: false };
    file(h, 'f-1', MECHANIC, { status: 'pending_scan' });
    const attached = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-1',
    });
    h.refs.files.set('f-1', { ...h.refs.files.get('f-1')!, status: 'rejected' });
    expect(await code(complete(h, attached))).toBe('missing_requirements:evidence');
    const views = await h.service.listFiles(TENANT, MECHANIC, order.id);
    expect(views.map((view) => view.fileStatus)).toEqual(['rejected']);
  });

  it('asks for the invoice too, and only a caller with view_costs can attach it', async () => {
    const { h, order } = await inProgress();
    h.refs.required = { evidence: true, invoice: true };
    file(h, 'f-ev', MECHANIC);
    file(h, 'f-inv', FLEET);
    const withEvidence = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-ev',
    });
    expect(await code(complete(h, withEvidence))).toBe('missing_requirements:invoice');
    for (const actor of [MECHANIC, EDITOR])
      expect(
        await code(
          h.service.attachFile(TENANT, actor, order.id, {
            version: withEvidence.version,
            kind: 'invoice',
            fileId: 'f-inv',
          }),
        ),
      ).toBe('forbidden');
    const both = await h.service.attachFile(TENANT, FLEET, order.id, {
      version: withEvidence.version,
      kind: 'invoice',
      fileId: 'f-inv',
    });
    expect(await code(complete(h, both))).toBe('ok');
  });

  it('re-checks the requirement at closure when evidence is removed after completion', async () => {
    const { h, order } = await inProgress();
    h.refs.required = { evidence: true, invoice: false };
    file(h, 'f-ev', MECHANIC);
    const attached = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-ev',
    });
    const done = await complete(h, attached);
    const link = (await h.store.attachments(TENANT, order.id))[0]!;
    const stripped = await h.service.detachFile(TENANT, FLEET, order.id, {
      version: done.version,
      attachmentId: link.id,
    });
    const close = (version: number) =>
      h.service.close(TENANT, ADMIN, order.id, { version, vehicleStatus: 'active' });
    expect(await code(close(stripped.version))).toBe('missing_requirements:evidence');
    file(h, 'f-ev2', FLEET);
    const restored = await h.service.attachFile(TENANT, FLEET, order.id, {
      version: stripped.version,
      kind: 'evidence',
      fileId: 'f-ev2',
    });
    expect(await code(close(restored.version))).toBe('ok');
  });
});

describe('who may attach, detach and read', () => {
  it('lets the assigned mechanic attach evidence only while the order is in progress (D9)', async () => {
    const h = harness();
    const created = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: 'Frenos',
    });
    const assigned = await h.service.assign(TENANT, FLEET, created.id, {
      version: 1,
      responsibleId: 'fleet',
      mechanicId: 'mechanic-1',
      scheduledDate: '2026-10-13',
    });
    file(h, 'f-1', MECHANIC);
    const attach = (actor: WorkOrderActor, version: number) =>
      h.service.attachFile(TENANT, actor, created.id, { version, kind: 'evidence', fileId: 'f-1' });
    expect(await code(attach(MECHANIC, assigned.version))).toBe('forbidden');
    const started = await h.service.start(TENANT, MECHANIC, created.id, {
      version: assigned.version,
    });
    // Another mechanic does not even see the order.
    expect(await code(attach(OTHER_MECHANIC, started.version))).toBe('not_found');
    expect(await code(attach(MECHANIC, started.version))).toBe('ok');
  });

  it('hides invoices from callers without view_costs', async () => {
    const { h, order } = await inProgress();
    file(h, 'f-ev', MECHANIC);
    file(h, 'f-inv', FLEET);
    const one = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-ev',
    });
    await h.service.attachFile(TENANT, FLEET, order.id, {
      version: one.version,
      kind: 'invoice',
      fileId: 'f-inv',
    });
    expect((await h.service.listFiles(TENANT, FLEET, order.id)).map((v) => v.kind)).toEqual([
      'evidence',
      'invoice',
    ]);
    for (const actor of [MECHANIC, EDITOR])
      expect((await h.service.listFiles(TENANT, actor, order.id)).map((v) => v.kind)).toEqual([
        'evidence',
      ]);
    const [, invoice] = await h.store.attachments(TENANT, order.id);
    // A caller without view_costs cannot remove the invoice either.
    expect(
      await code(
        h.service.detachFile(TENANT, MECHANIC, order.id, {
          version: one.version + 1,
          attachmentId: invoice!.id,
        }),
      ),
    ).toBe('forbidden');
  });

  it('never links a file of another tenant, of another uploader, a derivative or a PII file', async () => {
    const { h, order } = await inProgress();
    file(h, 'f-other-user', FLEET);
    file(h, 'f-derivative', MECHANIC, { kind: 'derivative' });
    file(h, 'f-pii', MECHANIC, { sensitivity: 'pii' });
    const attempt = (fileId: string) =>
      code(
        h.service.attachFile(TENANT, MECHANIC, order.id, {
          version: order.version,
          kind: 'evidence',
          fileId,
        }),
      );
    expect(await attempt('f-other-user')).toBe('not_found');
    expect(await attempt('f-unknown')).toBe('not_found');
    expect(await attempt('f-derivative')).toBe('invalid_input');
    expect(await attempt('f-pii')).toBe('invalid_input');
    expect(
      await code(
        h.service.attachFile('tenant-b', MECHANIC, order.id, {
          version: order.version,
          kind: 'evidence',
          fileId: 'f-other-user',
        }),
      ),
    ).toBe('not_found');
    expect(await h.store.attachments(TENANT, order.id)).toEqual([]);
  });

  it('rejects malformed input, duplicates, stale versions and too many files', async () => {
    const { h, order } = await inProgress();
    file(h, 'f-1', MECHANIC);
    const body = { version: order.version, kind: 'evidence', fileId: 'f-1' };
    for (const bad of [
      { ...body, kind: 'photo' },
      { ...body, extra: 1 },
      { ...body, fileId: '../x' },
    ])
      expect(await code(h.service.attachFile(TENANT, MECHANIC, order.id, bad))).toBe(
        'invalid_input',
      );
    expect(
      await code(h.service.attachFile(TENANT, MECHANIC, order.id, { ...body, version: 1 })),
    ).toBe('stale_version');
    const attached = await h.service.attachFile(TENANT, MECHANIC, order.id, body);
    expect(
      await code(
        h.service.attachFile(TENANT, MECHANIC, order.id, { ...body, version: attached.version }),
      ),
    ).toBe('duplicate');
    let version = attached.version;
    for (let n = 2; n <= 20; n += 1) {
      file(h, `f-${n}`, MECHANIC);
      version = (
        await h.service.attachFile(TENANT, MECHANIC, order.id, {
          version,
          kind: 'evidence',
          fileId: `f-${n}`,
        })
      ).version;
    }
    file(h, 'f-21', MECHANIC);
    expect(
      await code(
        h.service.attachFile(TENANT, MECHANIC, order.id, {
          version,
          kind: 'evidence',
          fileId: 'f-21',
        }),
      ),
    ).toBe('invalid_input');
    expect(
      await code(
        h.service.detachFile(TENANT, MECHANIC, order.id, { version, attachmentId: 'nope' }),
      ),
    ).toBe('not_found');
    expect(
      await code(
        h.service.detachFile(TENANT, MECHANIC, order.id, { version, attachmentId: '../' }),
      ),
    ).toBe('invalid_input');
  });
});

describe('closed and cancelled orders are immutable', () => {
  it('blocks attaching and detaching evidence once the order is closed or cancelled', async () => {
    const { h, order } = await inProgress();
    file(h, 'f-1', MECHANIC);
    const attached = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-1',
    });
    const done = await complete(h, attached);
    const closed = await h.service.close(TENANT, ADMIN, order.id, {
      version: done.version,
      vehicleStatus: 'active',
    });
    const link = (await h.store.attachments(TENANT, order.id))[0]!;
    file(h, 'f-2', FLEET);
    expect(
      await code(
        h.service.attachFile(TENANT, ADMIN, order.id, {
          version: closed.version,
          kind: 'evidence',
          fileId: 'f-2',
        }),
      ),
    ).toBe('invalid_transition');
    expect(
      await code(
        h.service.detachFile(TENANT, ADMIN, order.id, {
          version: closed.version,
          attachmentId: link.id,
        }),
      ),
    ).toBe('invalid_transition');
    expect(await h.store.attachments(TENANT, order.id)).toHaveLength(1);

    const second = await h.service.createCorrective(TENANT, FLEET, {
      vehicleId: 'vehicle-1',
      description: 'Luces',
    });
    const cancelled = await h.service.cancel(TENANT, FLEET, second.id, {
      version: second.version,
      reason: 'Duplicada',
    });
    expect(
      await code(
        h.service.attachFile(TENANT, ADMIN, second.id, {
          version: cancelled.version,
          kind: 'evidence',
          fileId: 'f-2',
        }),
      ),
    ).toBe('invalid_transition');
  });
});

describe('history, audit and outbox', () => {
  it('records timeline entries and audit actions, and keeps evidence out of the outbox', async () => {
    const { h, order } = await inProgress();
    file(h, 'f-1', MECHANIC);
    const events = h.store.events.length;
    const attached = await h.service.attachFile(TENANT, MECHANIC, order.id, {
      version: order.version,
      kind: 'evidence',
      fileId: 'f-1',
    });
    const link = (await h.store.attachments(TENANT, order.id))[0]!;
    await h.service.detachFile(TENANT, MECHANIC, order.id, {
      version: attached.version,
      attachmentId: link.id,
    });
    expect(h.store.events).toHaveLength(events);
    expect(h.store.audit.map((entry) => entry.action).slice(-2)).toEqual([
      'maintenance.work_order.evidence_attached',
      'maintenance.work_order.evidence_detached',
    ]);
    const history = await h.service.history(TENANT, MECHANIC, order.id);
    expect(history.slice(-2).map((entry) => [entry.command, entry.from, entry.to])).toEqual([
      ['evidence_attached', 'in_progress', 'in_progress'],
      ['evidence_detached', 'in_progress', 'in_progress'],
    ]);
    // Nothing the files carry travels in any outbox payload.
    expect(JSON.stringify(h.store.events)).not.toMatch(/f-1|evidence|invoice|pdf|displayName/);
  });
});

describe('calendar day of the tenant zone (G3 M4)', () => {
  it('judges "not in the future" on the tenant calendar, not on UTC', async () => {
    const { h, order } = await inProgress();
    // 2026-10-13T00:30Z is still 2026-10-12 18:30 in Mexico City.
    h.clock.now = new Date('2026-10-13T00:30:00.000Z');
    const tomorrowLocal = { version: order.version, actualDate: '2026-10-13', actualKm: 1500 };
    h.refs.zone = 'America/Mexico_City';
    expect(await code(h.service.complete(TENANT, MECHANIC, order.id, tomorrowLocal))).toBe(
      'invalid_input',
    );
    h.refs.zone = 'UTC';
    expect(await code(h.service.complete(TENANT, MECHANIC, order.id, tomorrowLocal))).toBe('ok');
  });

  it('accepts the local date in the zone where UTC has already moved on', async () => {
    const { h, order } = await inProgress();
    h.clock.now = new Date('2026-10-13T00:30:00.000Z');
    h.refs.zone = 'America/Mexico_City';
    expect(
      await code(
        h.service.complete(TENANT, MECHANIC, order.id, {
          version: order.version,
          actualDate: '2026-10-12',
          actualKm: 1500,
        }),
      ),
    ).toBe('ok');
  });
});
