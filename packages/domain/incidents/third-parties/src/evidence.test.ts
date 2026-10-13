import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident, type IncidentStatus } from '../../cases/src/index.js';
import { EVIDENCE_MAX_BYTES } from './catalog.js';
import type { FileRecordRef } from './types.js';
import {
  GENERIC_EDITOR,
  MANAGER,
  OTHER_REPORTER,
  REPORTER,
  TENANT_A,
  TENANT_B,
  VIEWER,
  setupChildren,
  sha256,
} from './test-support.js';

type World = ReturnType<typeof setupChildren>;
const rejection = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};
const meta = { category: 'photo', stage: 'on_site' } as const;
const upload = (
  world: World,
  incident: Incident,
  extra: Record<string, unknown> = {},
  who = MANAGER,
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
  key?: string,
) =>
  world.evidence.upload(
    TENANT_A,
    who,
    incident.id,
    { version: incident.version, name: 'foto.jpg', contentType: 'image/jpeg', ...meta, ...extra },
    bytes,
    'corr-1',
    key,
  );
async function force(world: World, incident: Incident, status: IncidentStatus) {
  const result = await world.store.apply({
    incident: { ...incident, status, version: incident.version + 1 },
    expectedVersion: incident.version,
    folioYear: null,
    transitions: [],
    auditActions: [],
    events: [],
  });
  if (!result.applied) throw new Error('fixture failed');
  return result.incident;
}

describe('clean evidence (case 11)', () => {
  it('shows a file in quarantine with its status, counts it only once clean, never serves a rejected one', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const first = await upload(world, incident);
    expect(first.evidence).toMatchObject({ fileStatus: 'pending_scan', counts: false });
    expect(first.incident.version).toBe(2);
    const second = await upload(world, first.incident, { category: 'budget' });
    const list = () => world.evidence.list(TENANT_A, MANAGER, incident.id);
    expect((await list()).map((e) => [e.fileStatus, e.counts])).toEqual([
      ['pending_scan', false],
      ['pending_scan', false],
    ]);
    expect(
      Object.values(await world.evidence.cleanCounts(TENANT_A, MANAGER, incident.id)).reduce(
        (a, b) => a + b,
      ),
    ).toBe(0);
    const [a, b] = await world.children.evidence(TENANT_A, incident.id);
    expect(
      await rejection(world.evidence.downloadable(TENANT_A, MANAGER, incident.id, a?.id as string)),
    ).toMatchObject({
      code: 'invalid_transition',
    });

    world.files.setStatus(TENANT_A, a?.fileId as string, 'clean');
    world.files.setStatus(TENANT_A, b?.fileId as string, 'rejected');
    expect((await list()).map((e) => [e.fileStatus, e.counts])).toEqual([
      ['clean', true],
      ['rejected', false],
    ]);
    expect(await world.evidence.cleanCounts(TENANT_A, MANAGER, incident.id)).toMatchObject({
      photo: 1,
      budget: 0,
    });
    expect(
      (await world.evidence.downloadable(TENANT_A, MANAGER, incident.id, a?.id as string)).fileId,
    ).toBe(a?.fileId);
    expect(
      await rejection(world.evidence.downloadable(TENANT_A, MANAGER, incident.id, b?.id as string)),
    ).toMatchObject({
      code: 'invalid_transition',
    });
    expect(second.evidence.category).toBe('budget');
  });

  it('answers 404 to a download of another tenant, an unknown link or a file the module forgot', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const { evidence } = await upload(world, incident);
    expect(
      await rejection(world.evidence.downloadable(TENANT_B, MANAGER, incident.id, evidence.id)),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await rejection(world.evidence.downloadable(TENANT_A, MANAGER, incident.id, 'nope')),
    ).toMatchObject({ code: 'not_found' });
    world.files.records.clear();
    expect(
      await rejection(world.evidence.downloadable(TENANT_A, MANAGER, incident.id, evidence.id)),
    ).toMatchObject({ code: 'not_found' });
    expect((await world.evidence.list(TENANT_A, MANAGER, incident.id))[0]).toMatchObject({
      fileStatus: 'missing',
      counts: false,
    });
  });

  it('links a file once per tenant: the second link is a 409 even from another case', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const other = await world.draft();
    const fileId = world.files.add(TENANT_A, MANAGER.id);
    const attach = (target: Incident, version = target.version) =>
      world.evidence.attach(TENANT_A, MANAGER, target.id, { version, fileId, ...meta });
    const linked = await attach(incident);
    expect(linked.evidence.fileStatus).toBe('pending_scan');
    expect(await rejection(attach(linked.incident))).toMatchObject({ code: 'duplicate' });
    expect(await rejection(attach(other))).toMatchObject({ code: 'duplicate' });
    expect(await world.children.evidence(TENANT_A, other.id)).toEqual([]);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(2);
    // The store refuses it too when two links race for the same file.
    const raced = await Promise.allSettled([
      world.evidence.attach(TENANT_A, MANAGER, other.id, {
        version: 1,
        fileId: world.files.add(TENANT_A, MANAGER.id, 'pending_scan', 'file-race'),
        ...meta,
      }),
      world.evidence.attach(TENANT_A, MANAGER, incident.id, {
        version: 2,
        fileId: 'file-race',
        ...meta,
      }),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (raced.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'duplicate',
    });
  });

  it('accepts only an original, standard file of the caller that is saved or in the scan', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const attach = (fileId: string) =>
      world.evidence.attach(TENANT_A, MANAGER, incident.id, { version: 1, fileId, ...meta });
    expect(await rejection(attach('missing-file'))).toMatchObject({ code: 'not_found' });
    expect(await rejection(attach(world.files.add(TENANT_A, OTHER_REPORTER.id)))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await rejection(attach(world.files.add(TENANT_B, MANAGER.id, 'clean', 'file-b'))),
    ).toMatchObject({
      code: 'not_found',
    });
    for (const status of ['pending_upload', 'rejected'] as const)
      expect(await rejection(attach(world.files.add(TENANT_A, MANAGER.id, status)))).toMatchObject({
        code: 'invalid_input',
      });
    const derivative = world.files.add(TENANT_A, MANAGER.id, 'clean');
    world.files.records.set(`${TENANT_A}/${derivative}`, {
      ...(world.files.records.get(`${TENANT_A}/${derivative}`) as FileRecordRef),
      kind: 'derivative',
    });
    const pii = world.files.add(TENANT_A, MANAGER.id, 'clean');
    world.files.records.set(`${TENANT_A}/${pii}`, {
      ...(world.files.records.get(`${TENANT_A}/${pii}`) as FileRecordRef),
      sensitivity: 'pii',
    });
    for (const id of [derivative, pii])
      expect(await rejection(attach(id))).toMatchObject({ code: 'invalid_input' });
    expect(await world.children.evidence(TENANT_A, incident.id)).toEqual([]);
  });

  it('detaches the link only: the file stays and can be linked again', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const { incident: after, evidence } = await upload(world, incident);
    const [link] = await world.children.evidence(TENANT_A, incident.id);
    const detached = await world.evidence.detach(TENANT_A, MANAGER, incident.id, evidence.id, {
      version: after.version,
    });
    expect(detached.version).toBe(3);
    expect(await world.evidence.list(TENANT_A, MANAGER, incident.id)).toEqual([]);
    expect(world.files.records.has(`${TENANT_A}/${link?.fileId}`)).toBe(true);
    const history = await world.service.history(TENANT_A, MANAGER, incident.id);
    expect(history.at(-1)).toMatchObject({
      command: 'evidence_detached',
      before: { evidenceId: evidence.id, category: 'photo', stage: 'on_site' },
    });
    expect(world.store.audit.at(-1)?.action).toBe('incident.evidence_detached');
    expect(
      await rejection(
        world.evidence.detach(TENANT_A, MANAGER, incident.id, evidence.id, { version: 3 }),
      ),
    ).toMatchObject({ code: 'not_found' });
    const again = await world.evidence.attach(TENANT_A, MANAGER, incident.id, {
      version: 3,
      fileId: link?.fileId,
      ...meta,
    });
    expect(again.incident.version).toBe(4);
  });
});

describe('compressed photos keep the received file intact (case 17)', () => {
  it('hands the received bytes to the files module untouched and records the declaration', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
    const { evidence } = await upload(
      world,
      incident,
      { clientCompressed: true, capturedAt: '2026-10-13T10:00:00Z' },
      MANAGER,
      bytes,
    );
    const [link] = await world.children.evidence(TENANT_A, incident.id);
    expect(link).toMatchObject({
      clientCompressed: true,
      capturedAt: '2026-10-13T10:00:00.000Z',
      displayName: `${link?.fileId}.jpg`,
    });
    expect(evidence.clientCompressed).toBe(true);
    expect(sha256(world.files.bytes.get(link?.fileId as string) as Uint8Array)).toBe(sha256(bytes));
    const plain = await upload(world, await world.service.get(TENANT_A, MANAGER, incident.id));
    expect(plain.evidence.clientCompressed).toBe(false);
    expect(plain.evidence.capturedAt).toBeNull();
    // The listing never carries the hash, the file id or the storage key.
    expect(JSON.stringify(evidence)).not.toMatch(/sha|fileId|storage/i);
  });
});

describe('inputs and limits', () => {
  it('names every bad field and refuses empty or oversized content before storing anything', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const bad = await rejection(
      world.evidence.upload(
        TENANT_A,
        MANAGER,
        incident.id,
        { name: '', category: 'x', stage: 1, extra: 1, capturedAt: 'ayer', clientCompressed: 'si' },
        new Uint8Array(1),
        'c',
      ),
    );
    expect(bad.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'version', code: 'required' },
        { field: 'contentType', code: 'required' },
        { field: 'category', code: 'invalid' },
        { field: 'stage', code: 'invalid' },
        { field: 'capturedAt', code: 'invalid' },
        { field: 'clientCompressed', code: 'invalid' },
        { field: 'extra', code: 'unknown_property' },
      ]),
    );
    expect(await rejection(upload(world, incident, {}, MANAGER, new Uint8Array(0)))).toMatchObject({
      code: 'invalid_input',
    });
    expect(
      await rejection(upload(world, incident, {}, MANAGER, new Uint8Array(EVIDENCE_MAX_BYTES + 1))),
    ).toMatchObject({ code: 'invalid_input' });
    const missing = await rejection(
      world.evidence.attach(TENANT_A, MANAGER, incident.id, { version: 1, ...meta }),
    );
    expect(missing.fieldErrors).toEqual([{ field: 'fileId', code: 'required' }]);
    const bare = await rejection(world.evidence.detach(TENANT_A, MANAGER, incident.id, 'x', {}));
    expect(bare.fieldErrors).toEqual([{ field: 'version', code: 'required' }]);
    expect(world.files.records.size).toBe(0);
  });

  it('writes nothing when the files module rejects the upload', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    world.files.reject = true;
    expect(await rejection(upload(world, incident))).toMatchObject({ code: 'invalid_input' });
    expect(await world.children.evidence(TENANT_A, incident.id)).toEqual([]);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(1);
  });

  it('checks the version before storing a byte and caps the files of a case', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    expect(await rejection(upload(world, { ...incident, version: 9 }))).toMatchObject({
      code: 'stale_version',
    });
    expect(world.files.records.size).toBe(0);
    let current = incident;
    for (let n = 0; n < 50; n += 1) current = (await upload(world, current)).incident;
    expect(await rejection(upload(world, current))).toMatchObject({
      code: 'rule_violation',
      rule: 'evidence_limit_reached',
    });
  });

  it('writes the timeline with names only and a minimal event', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    await upload(world, incident, { name: 'Nombre privado del archivo.jpg' });
    const dump = JSON.stringify([
      await world.service.history(TENANT_A, MANAGER, incident.id),
      world.store.audit,
      world.store.events,
    ]);
    expect(dump).not.toContain('Nombre privado');
    expect(world.store.events.at(-1)?.event.payload).toEqual({
      incidentId: incident.id,
      version: 2,
    });
  });
});

describe('Idempotency-Key', () => {
  it('stores the file once for the same key and body and conflicts on another body', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const bytes = new Uint8Array([1, 1, 1]);
    const first = await upload(world, incident, {}, MANAGER, bytes, 'evid-key-1');
    const replay = await upload(world, incident, {}, MANAGER, bytes, 'evid-key-1');
    expect(replay.evidence.id).toBe(first.evidence.id);
    expect(world.files.records.size).toBe(1);
    expect(await world.children.evidence(TENANT_A, incident.id)).toHaveLength(1);
    expect(
      await rejection(upload(world, incident, {}, MANAGER, new Uint8Array([2]), 'evid-key-1')),
    ).toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(await rejection(upload(world, incident, {}, MANAGER, bytes, 'x'))).toMatchObject({
      code: 'invalid_input',
    });
  });

  it('answers a concurrent twin with the winner and reports a vanished link as duplicate', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const bytes = new Uint8Array([4, 4]);
    const [a, b] = await Promise.all([
      upload(world, incident, {}, MANAGER, bytes, 'evid-twin-1'),
      upload(world, incident, {}, MANAGER, bytes, 'evid-twin-1'),
    ]);
    expect(a.evidence.id).toBe(b.evidence.id);
    await world.evidence.detach(TENANT_A, MANAGER, incident.id, a.evidence.id, { version: 2 });
    expect(
      await rejection(upload(world, incident, {}, MANAGER, bytes, 'evid-twin-1')),
    ).toMatchObject({ code: 'duplicate' });
  });
});

describe('state and permissions (cases 7, 12 and 16)', () => {
  it.each(['closed', 'cancelled'] as const)('refuses every write on a %s case', async (status) => {
    const world = setupChildren();
    const incident = await world.draft();
    const { incident: after, evidence } = await upload(world, incident);
    const locked = await force(world, after, status);
    const fileId = world.files.add(TENANT_A, MANAGER.id);
    for (const work of [
      upload(world, locked),
      world.evidence.attach(TENANT_A, MANAGER, incident.id, {
        version: locked.version,
        fileId,
        ...meta,
      }),
      world.evidence.detach(TENANT_A, MANAGER, incident.id, evidence.id, {
        version: locked.version,
      }),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'invalid_transition' });
    expect(await world.children.evidence(TENANT_A, incident.id)).toHaveLength(1);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(locked.version);
    expect(await world.evidence.list(TENANT_A, MANAGER, incident.id)).toHaveLength(1);
  });

  it('reads with incidents:view, writes only with edit (or the author while draft), never with generic verbs', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const { incident: after, evidence } = await upload(world, incident);
    expect(await world.evidence.list(TENANT_A, VIEWER, incident.id)).toHaveLength(1);
    for (const work of [
      upload(world, after, {}, VIEWER),
      world.evidence.detach(TENANT_A, VIEWER, incident.id, evidence.id, { version: 2 }),
      world.evidence.list(TENANT_A, GENERIC_EDITOR, incident.id),
      upload(world, after, {}, GENERIC_EDITOR),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'forbidden' });
    const mine = await world.service.create(TENANT_A, REPORTER, {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    expect((await upload(world, mine, {}, REPORTER)).incident.version).toBe(2);
    expect(await rejection(upload(world, mine, {}, OTHER_REPORTER))).toMatchObject({
      code: 'forbidden',
    });
  });

  it('gives another tenant a uniform 404 on every route and writes nothing', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const { evidence } = await upload(world, incident);
    const fileId = world.files.add(TENANT_B, MANAGER.id);
    for (const work of [
      world.evidence.list(TENANT_B, MANAGER, incident.id),
      world.evidence.upload(
        TENANT_B,
        MANAGER,
        incident.id,
        { version: 2, name: 'a.jpg', contentType: 'image/jpeg', ...meta },
        new Uint8Array(1),
        'c',
      ),
      world.evidence.attach(TENANT_B, MANAGER, incident.id, { version: 2, fileId, ...meta }),
      world.evidence.detach(TENANT_B, MANAGER, incident.id, evidence.id, { version: 2 }),
      world.evidence.cleanCounts(TENANT_B, MANAGER, incident.id),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'not_found' });
    expect(await world.children.evidence(TENANT_B, incident.id)).toEqual([]);
    expect(await world.children.evidence(TENANT_A, incident.id)).toHaveLength(1);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(2);
    expect(world.files.records.size).toBe(2);
  });
});
