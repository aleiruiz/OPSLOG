import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident, type IncidentStatus } from '../../cases/src/index.js';
import { ThirdPartyService } from './third-parties.js';
import { IdentityVault } from './pii.js';
import { InMemoryIncidentChildStore } from './store.js';
import {
  EDITOR,
  GENERIC_EDITOR,
  MANAGER,
  OTHER_REPORTER,
  PARTY,
  PII_READER,
  PROTECTED_VALUES,
  REPORTER,
  TENANT_A,
  TENANT_B,
  VIEWER,
  actorOf,
  setupChildren,
} from './test-support.js';

const rejection = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};
const add = (
  world: ReturnType<typeof setupChildren>,
  incident: Incident,
  extra = {},
  who = MANAGER,
) =>
  world.thirdParties.create(TENANT_A, who, incident.id, {
    version: incident.version,
    ...PARTY,
    ...extra,
  });
async function force(
  world: ReturnType<typeof setupChildren>,
  incident: Incident,
  status: IncidentStatus,
) {
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

describe('protected identity (case 10)', () => {
  it('seals the four protected fields and shows them exactly only with view_pii', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    expect(created.incident.version).toBe(2);
    expect(created.party).toMatchObject({ kind: 'person', identityRestricted: true });
    expect(created.party).not.toHaveProperty('name');

    const stored = (await world.children.thirdParties(TENANT_A, incident.id))[0];
    for (const sealed of Object.values(stored?.identity ?? {})) expect(sealed).toMatch(/^pii1\./);
    expect(JSON.stringify(stored)).not.toMatch(/Marta|0000 1234|ZZZ-999|POL-TERCERO/);

    const open = await world.thirdParties.list(TENANT_A, PII_READER, incident.id);
    expect(open[0]).toMatchObject({
      identityRestricted: false,
      name: PARTY.name,
      contact: PARTY.contact,
      plates: PARTY.plates,
      policyNumber: PARTY.policyNumber,
      insurerName: PARTY.insurerName,
      injuries: false,
    });
    const hidden = await world.thirdParties.list(TENANT_A, EDITOR, incident.id);
    expect(hidden[0]).toMatchObject({ identityRestricted: true, insurerName: PARTY.insurerName });
    for (const field of ['name', 'contact', 'plates', 'policyNumber'])
      expect(hidden[0]).not.toHaveProperty(field);
    // view_pii alone is not enough: the identity also needs incidents:view.
    expect(
      await rejection(world.thirdParties.list(TENANT_A, GENERIC_EDITOR, incident.id)),
    ).toMatchObject({
      code: 'forbidden',
    });
  });

  it('leaves no protected value in the timeline, the audit, the outbox or an error', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    await world.thirdParties.update(TENANT_A, MANAGER, incident.id, created.party.id, {
      version: created.incident.version,
      name: 'Otro Nombre Sintético',
      plates: 'QQQ-111-Z',
    });
    const dump = JSON.stringify([
      await world.service.history(TENANT_A, MANAGER, incident.id),
      world.store.audit,
      world.store.events,
    ]);
    for (const value of [...PROTECTED_VALUES, 'Otro Nombre Sintético', 'QQQ-111-Z'])
      expect(dump).not.toContain(value);
    expect(dump).not.toContain(PARTY.damageDescription);

    const bad = await rejection(
      world.thirdParties.create(TENANT_A, MANAGER, incident.id, {
        version: 3,
        kind: 'person',
        name: 'N'.repeat(500),
        contact: `${PARTY.contact}\u0000`,
        pseudonym: PARTY.name,
      }),
    );
    expect(bad.code).toBe('invalid_input');
    expect(bad.fieldErrors).toEqual(
      expect.arrayContaining([
        { field: 'name', code: 'invalid' },
        { field: 'contact', code: 'invalid' },
        { field: 'pseudonym', code: 'unknown_property' },
      ]),
    );
    expect(JSON.stringify([bad.fieldErrors, bad.message])).not.toContain(PARTY.contact);
  });

  it('opens each value under its own context: a moved envelope does not open', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    await add(world, incident);
    const [stored] = await world.children.thirdParties(TENANT_A, incident.id);
    const vault = new IdentityVault(world.cipher);
    const sealedName = stored?.identity.name as string;
    await expect(
      vault.open(TENANT_A, incident.id, stored?.id as string, 'plates', sealedName),
    ).rejects.toThrow('could not be opened');
    await expect(
      vault.open(TENANT_B, incident.id, stored?.id as string, 'name', sealedName),
    ).rejects.toThrow(/could not be opened$/);
    expect(await vault.open(TENANT_A, incident.id, stored?.id as string, 'name', sealedName)).toBe(
      PARTY.name,
    );
  });

  it('fails with a fixed message when the cipher cannot seal, open or fingerprint', async () => {
    const world = setupChildren();
    const failing = {
      seal: async () => {
        throw new Error(`boom ${PARTY.name}`);
      },
      open: async () => {
        throw new Error(`boom ${PARTY.name}`);
      },
      blindIndex: async () => {
        throw new Error(`boom ${PARTY.name}`);
      },
    };
    const service = new ThirdPartyService(
      world.store,
      new InMemoryIncidentChildStore(world.store),
      new IdentityVault(failing),
    );
    const incident = await world.draft();
    const sealFails = await service
      .create(TENANT_A, MANAGER, incident.id, { version: 1, ...PARTY })
      .catch((error: Error) => error);
    expect(sealFails).toBeInstanceOf(Error);
    expect((sealFails as Error).message).toBe('Third party identity could not be sealed');
    const keyFails = await service
      .create(TENANT_A, MANAGER, incident.id, { version: 1, ...PARTY }, 'key-12345678')
      .catch((error: Error) => error);
    expect((keyFails as Error).message).toBe('Third party identity could not be fingerprinted');
    // A row that cannot be opened is a server fault, never a value.
    const created = await add(world, incident);
    const broken = new ThirdPartyService(world.store, world.children, new IdentityVault(failing));
    const openFails = await broken
      .list(TENANT_A, PII_READER, created.incident.id)
      .catch((error: Error) => error);
    expect((openFails as Error).message).toBe('Third party identity could not be opened');
  });

  it('refuses to store a protected column that is not a sealed envelope', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    const [stored] = await world.children.thirdParties(TENANT_A, incident.id);
    const plain = {
      ...(stored as NonNullable<typeof stored>),
      identity: { name: PARTY.name, contact: null, plates: null, policyNumber: null },
    };
    const mutation = {
      incident: { ...created.incident, version: created.incident.version + 1 },
      expectedVersion: created.incident.version,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    };
    await expect(
      world.children.apply(mutation, { kind: 'third_party_add', party: { ...plain, id: 'x' } }),
    ).rejects.toThrow('must be sealed');
    await expect(
      world.children.apply(mutation, { kind: 'third_party_update', party: plain }),
    ).rejects.toThrow('must be sealed');
  });
});

describe('commands', () => {
  it('records the timeline with names of fields only, one audit and one minimal event', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    const history = await world.service.history(TENANT_A, MANAGER, incident.id);
    expect(history.at(-1)).toMatchObject({
      command: 'third_party_added',
      from: 'draft',
      to: 'draft',
      changedFields: [
        'contact',
        'damageDescription',
        'injuries',
        'insurerName',
        'kind',
        'name',
        'plates',
        'policyNumber',
      ],
      before: { thirdPartyId: created.party.id, kind: 'person' },
    });
    expect(world.store.audit.at(-1)).toEqual({
      tenantId: TENANT_A,
      action: 'incident.third_party_added',
    });
    expect(world.store.events.at(-1)?.event).toEqual({
      type: 'incident.updated',
      payload: { incidentId: incident.id, version: 2 },
    });
  });

  it('updates, clears and ignores no-ops without bumping the version', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    const version = created.incident.version;
    const id = created.party.id;
    const noop = await world.thirdParties.update(TENANT_A, MANAGER, incident.id, id, {
      version,
      kind: 'person',
      injuries: false,
      insurerName: PARTY.insurerName,
    });
    expect(noop.incident.version).toBe(version);
    const nullNoop = await world.thirdParties.update(TENANT_A, MANAGER, incident.id, id, {
      version,
      damageDescription: null,
      insurerName: null,
    });
    expect(nullNoop.incident.version).toBe(version + 1);
    const cleared = await world.thirdParties.update(TENANT_A, PII_READER, incident.id, id, {
      version: version + 1,
      contact: null,
      kind: 'vehicle',
      injuries: true,
      damageDescription: 'Nuevo daño',
    });
    expect(cleared.party).toMatchObject({
      kind: 'vehicle',
      injuries: true,
      contact: null,
      insurerName: null,
      damageDescription: 'Nuevo daño',
      name: PARTY.name,
    });
    const history = await world.service.history(TENANT_A, MANAGER, incident.id);
    expect(history.at(-1)).toMatchObject({
      command: 'third_party_updated',
      changedFields: ['contact', 'damageDescription', 'injuries', 'kind'],
    });
    // Clearing what is already empty is not a change.
    const again = await world.thirdParties.update(TENANT_A, MANAGER, incident.id, id, {
      version: version + 2,
      contact: null,
    });
    expect(again.incident.version).toBe(version + 2);
    const empty = await rejection(
      world.thirdParties.update(TENANT_A, MANAGER, incident.id, id, { version: version + 2 }),
    );
    expect(empty.fieldErrors).toEqual([{ field: 'body', code: 'required' }]);
  });

  it('removes softly: leaves the list, keeps the row and cannot be edited or removed again', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    const removed = await world.thirdParties.remove(
      TENANT_A,
      MANAGER,
      incident.id,
      created.party.id,
      {
        version: created.incident.version,
      },
    );
    expect(removed.version).toBe(3);
    expect(await world.thirdParties.list(TENANT_A, PII_READER, incident.id)).toEqual([]);
    const kept = await world.children.thirdParties(TENANT_A, incident.id, { includeRemoved: true });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.removedAt).not.toBeNull();
    const history = await world.service.history(TENANT_A, MANAGER, incident.id);
    expect(history.at(-1)).toMatchObject({
      command: 'third_party_removed',
      changedFields: ['removedAt'],
    });
    for (const work of [
      world.thirdParties.remove(TENANT_A, MANAGER, incident.id, created.party.id, { version: 3 }),
      world.thirdParties.update(TENANT_A, MANAGER, incident.id, created.party.id, {
        version: 3,
        injuries: true,
      }),
      world.thirdParties.update(TENANT_A, MANAGER, incident.id, 'bad/id', {
        version: 3,
        injuries: true,
      }),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'not_found' });
  });

  it('answers 409 stale_version to the loser of two writes with the same version', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const results = await Promise.allSettled([add(world, incident), add(world, incident)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'stale_version' });
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toHaveLength(1);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(2);
  });

  it('caps the active third parties of a case', async () => {
    const world = setupChildren();
    let incident = await world.draft();
    for (let n = 0; n < 20; n += 1)
      incident = (await add(world, incident, { name: `Tercero ${n}` })).incident;
    const over = await rejection(add(world, incident));
    expect(over).toMatchObject({ code: 'rule_violation', rule: 'third_party_limit_reached' });
    // A removed third party frees its place.
    const [first] = await world.children.thirdParties(TENANT_A, incident.id);
    incident = await world.thirdParties.remove(
      TENANT_A,
      MANAGER,
      incident.id,
      first?.id as string,
      {
        version: incident.version,
      },
    );
    expect((await add(world, incident)).incident.version).toBe(incident.version + 1);
  });
});

describe('Idempotency-Key', () => {
  it('replays the first result for the same key and body, even after the case moved on', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const body = { version: 1, ...PARTY };
    const first = await world.thirdParties.create(
      TENANT_A,
      MANAGER,
      incident.id,
      body,
      'party-key-1',
    );
    await world.service.update(TENANT_A, MANAGER, incident.id, { version: 2, description: 'x' });
    const second = await world.thirdParties.create(
      TENANT_A,
      MANAGER,
      incident.id,
      body,
      'party-key-1',
    );
    expect(second.party.id).toBe(first.party.id);
    expect(second.incident.version).toBe(2);
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toHaveLength(1);
    const clash = await rejection(
      world.thirdParties.create(
        TENANT_A,
        MANAGER,
        incident.id,
        { ...body, name: 'Otro' },
        'party-key-1',
      ),
    );
    expect(clash.code).toBe('idempotency_conflict');
    const badKey = await rejection(
      world.thirdParties.create(TENANT_A, MANAGER, incident.id, body, 'x'),
    );
    expect(badKey.fieldErrors).toEqual([{ field: 'idempotencyKey', code: 'invalid' }]);
    // The stored hash is keyed: it does not let anyone test a guess of the name.
    const hash = (
      await world.store.idempotency(TENANT_A, MANAGER.id, 'third_party_add', 'party-key-1')
    )?.payloadHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers a concurrent twin with the winner result', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const body = { version: 1, ...PARTY };
    const results = await Promise.all([
      world.thirdParties.create(TENANT_A, MANAGER, incident.id, body, 'twin-key-1'),
      world.thirdParties.create(TENANT_A, MANAGER, incident.id, body, 'twin-key-1'),
    ]);
    expect(results[0].party.id).toBe(results[1].party.id);
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toHaveLength(1);
  });

  it('reports a duplicate when the keyed third party is gone from the store', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const body = { version: 1, ...PARTY };
    await world.thirdParties.create(TENANT_A, MANAGER, incident.id, body, 'gone-key-1');
    const empty = new ThirdPartyService(
      world.store,
      new InMemoryIncidentChildStore(world.store),
      new IdentityVault(world.cipher),
    );
    expect(
      await rejection(empty.create(TENANT_A, MANAGER, incident.id, body, 'gone-key-1')),
    ).toMatchObject({ code: 'duplicate' });
  });
});

describe('closed and cancelled cases (case 12)', () => {
  it.each(['closed', 'cancelled'] as const)('refuses every write on a %s case', async (status) => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    const locked = await force(world, created.incident, status);
    const before = await world.children.thirdParties(TENANT_A, incident.id);
    for (const work of [
      add(world, locked),
      world.thirdParties.update(TENANT_A, MANAGER, incident.id, created.party.id, {
        version: locked.version,
        injuries: true,
      }),
      world.thirdParties.remove(TENANT_A, MANAGER, incident.id, created.party.id, {
        version: locked.version,
      }),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'invalid_transition' });
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toEqual(before);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(locked.version);
    // Reading stays possible.
    expect(await world.thirdParties.list(TENANT_A, MANAGER, incident.id)).toHaveLength(1);
  });
});

describe('permissions and tenants (cases 7 and 16)', () => {
  it('lets the author with incidents:report add to their own draft only', async () => {
    const world = setupChildren();
    const mine = await world.service.create(TENANT_A, REPORTER, {
      vehicleId: 'vehicle-1',
      type: 'collision',
    });
    expect((await add(world, mine, {}, REPORTER)).incident.version).toBe(2);
    expect(await rejection(add(world, mine, {}, OTHER_REPORTER))).toMatchObject({
      code: 'forbidden',
    });
    const reported = await force(
      world,
      await world.service.get(TENANT_A, REPORTER, mine.id),
      'reported',
    );
    expect(await rejection(add(world, reported, {}, REPORTER))).toMatchObject({
      code: 'forbidden',
    });
  });

  it('gives incidents:view alone the read but no write, and generic verbs nothing at all', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    expect(await world.thirdParties.list(TENANT_A, VIEWER, incident.id)).toHaveLength(1);
    for (const work of [
      add(world, created.incident, {}, VIEWER),
      world.thirdParties.update(TENANT_A, VIEWER, incident.id, created.party.id, {
        version: 2,
        injuries: true,
      }),
      world.thirdParties.remove(TENANT_A, VIEWER, incident.id, created.party.id, { version: 2 }),
      world.thirdParties.list(TENANT_A, GENERIC_EDITOR, incident.id),
      add(world, created.incident, {}, GENERIC_EDITOR),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'forbidden' });
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toHaveLength(1);
  });

  it('fails closed for a mechanic-scoped member', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const mechanic = actorOf('00000000-0000-4000-8000-0000000000b1', ['incidents:view'], true);
    expect(await rejection(world.thirdParties.list(TENANT_A, mechanic, incident.id))).toMatchObject(
      {
        code: 'not_found',
      },
    );
  });

  it('gives the other tenant a uniform 404 and writes nothing', async () => {
    const world = setupChildren();
    const incident = await world.draft();
    const created = await add(world, incident);
    for (const work of [
      world.thirdParties.list(TENANT_B, MANAGER, incident.id),
      world.thirdParties.create(TENANT_B, MANAGER, incident.id, { version: 2, ...PARTY }),
      world.thirdParties.update(TENANT_B, MANAGER, incident.id, created.party.id, {
        version: 2,
        injuries: true,
      }),
      world.thirdParties.remove(TENANT_B, MANAGER, incident.id, created.party.id, { version: 2 }),
      world.thirdParties.list(TENANT_A, MANAGER, 'no-such-incident'),
      world.thirdParties.list(TENANT_A, MANAGER, '../etc'),
    ])
      expect(await rejection(work)).toMatchObject({ code: 'not_found' });
    expect(await world.children.thirdParties(TENANT_B, incident.id)).toEqual([]);
    expect(await world.children.thirdParties(TENANT_A, incident.id)).toHaveLength(1);
    expect((await world.service.get(TENANT_A, MANAGER, incident.id)).version).toBe(2);
  });
});
