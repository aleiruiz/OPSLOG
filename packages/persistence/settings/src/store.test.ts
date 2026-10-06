import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { SettingsService, type CompanySettings } from '../../../domain/settings/src/index.js';
import { SettingsStoreError } from './errors.js';
import { TypeOrmSettingsStore, type StoreErrorEvent } from './store.js';
import {
  CONNECTION_LOST,
  DEADLOCK,
  DUPLICATE,
  FakeDatabase,
  asDataSource,
} from './test-support/fake-database.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const settings = (tenant: string, over: Partial<CompanySettings> = {}): CompanySettings => ({
  tenantId: tenant,
  expiryWindowDays: 15,
  recipientRoles: ['admin', 'editor'],
  version: 1,
  updatedBy: ACTOR,
  updatedAt: NOW.toISOString(),
  ...over,
});

function setup() {
  const db = new FakeDatabase();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmSettingsStore(asDataSource(db), {
    onError: (event) => events.push(event),
  });
  return { db, events, store };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('construction guards', () => {
  const build = (options: Record<string, unknown>) =>
    new TypeOrmSettingsStore({ options } as never);
  it('requires MySQL, no synchronize and the restricted settings account', () => {
    expect(() => build({ type: 'postgres', username: 'opslog_settings_x' })).toThrow(/MySQL/);
    expect(() =>
      build({ type: 'mysql', username: 'opslog_settings_x', synchronize: true }),
    ).toThrow(/synchronize/);
    expect(() => build({ type: 'mysql', username: 'root' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_assignments_x' })).toThrow(/restricted/);
    expect(() => build({ type: 'mysql' })).toThrow(/restricted runtime account/);
    expect(() => build({ type: 'mysql', username: 'opslog_settings_runtime' })).not.toThrow();
  });
  it('works without an error callback', async () => {
    const db = new FakeDatabase();
    const store = new TypeOrmSettingsStore(asDataSource(db));
    db.failNext('find', CONNECTION_LOST);
    expect(await rejection(store.find(A))).toMatchObject({ code: 'unavailable' });
  });
});

describe('insert, find and replace', () => {
  it('writes the first settings, reads them back and lists the canonical roles', async () => {
    const { db, store } = setup();
    expect(await store.find(A)).toBeNull();
    expect(await store.insert(settings(A))).toBe(true);
    expect(await store.find(A)).toEqual(settings(A));
    expect(db.committed()[0]).toMatchObject({
      tenantId: A,
      expiryWindowDays: 15,
      recipientRoles: 'admin,editor',
      version: 1,
    });
  });

  it('reports a second first write as false and keeps the first', async () => {
    const { store } = setup();
    await store.insert(settings(A));
    expect(await store.insert(settings(A, { expiryWindowDays: 3 }))).toBe(false);
    expect((await store.find(A))?.expiryWindowDays).toBe(15);
  });

  it('replaces only while the stored version matches, in one conditional statement', async () => {
    const { db, store } = setup();
    await store.insert(settings(A));
    const next = settings(A, { version: 2, expiryWindowDays: 7, recipientRoles: ['viewer'] });
    expect(await store.replace(next, 5)).toBe(false);
    expect(await store.replace(next, 1)).toBe(true);
    expect(await store.replace(next, 1)).toBe(false);
    expect(await store.find(A)).toEqual(next);
    const updates = db.statements.filter((statement) => statement.operation === 'update');
    expect(updates.map((statement) => statement.where)).toEqual([
      { tenantId: A, version: 5 },
      { tenantId: A, version: 1 },
      { tenantId: A, version: 1 },
    ]);
  });

  it('names the company in every statement and keeps tenants apart', async () => {
    const { db, store } = setup();
    await store.insert(settings(A));
    await store.insert(settings(B, { expiryWindowDays: 2 }));
    expect((await store.find(B))?.expiryWindowDays).toBe(2);
    expect(await store.replace(settings(B, { version: 2 }), 1)).toBe(true);
    expect((await store.find(A))?.version).toBe(1);
    for (const statement of db.statements.filter((s) => s.where !== null))
      expect(Object.keys(statement.where as object)).toContain('tenantId');
  });

  it('works under the service: the race of two first writes has one winner', async () => {
    const { store } = setup();
    const service = new SettingsService(store, { now: () => NOW });
    const input = { expiryWindowDays: 10, recipientRoles: ['admin'] };
    const outcomes = await Promise.allSettled([
      service.update(A, ACTOR, 0, input),
      service.update(A, ACTOR, 0, input),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await service.get(A)).version).toBe(1);
  });
});

describe('rows that do not satisfy the domain', () => {
  it.each(['', 'root', 'editor,admin', 'admin,admin', 'admin,', ' admin'])(
    'rejects stored recipients %j as an integrity error',
    async (roles) => {
      const { db, store } = setup();
      db.seed({
        ...settings(A),
        recipientRoles: roles,
        updatedAt: NOW,
      });
      expect(await rejection(store.find(A))).toMatchObject({ code: 'integrity' });
    },
  );
});

describe('failures are sanitized', () => {
  it('maps driver failures to coarse codes, reports them and never leaks parameters', async () => {
    const { db, events, store } = setup();
    db.failNext('find', CONNECTION_LOST, { leak: 'tenant-secret-7' });
    const failure = await rejection(store.find(A));
    expect(failure).toBeInstanceOf(SettingsStoreError);
    expect(failure).toMatchObject({ code: 'unavailable', errno: 2013 });
    expect(JSON.stringify(failure)).not.toContain('tenant-secret-7');
    expect(String((failure as Error).message)).not.toContain('tenant-secret-7');
    db.failNext('update', DEADLOCK);
    expect(await rejection(store.replace(settings(A, { version: 2 }), 1))).toMatchObject({
      code: 'contention',
    });
    db.failNext('insert', CONNECTION_LOST);
    expect(await rejection(store.insert(settings(A)))).toMatchObject({ code: 'unavailable' });
    expect(events.map((event) => [event.operation, event.code])).toEqual([
      ['find', 'unavailable'],
      ['replace', 'contention'],
      ['insert', 'unavailable'],
    ]);
  });

  it('treats a duplicate on insert as a lost race, not as an error', async () => {
    const { db, events, store } = setup();
    db.failNext('insert', DUPLICATE);
    expect(await store.insert(settings(A))).toBe(false);
    expect(events).toEqual([]);
  });
});
