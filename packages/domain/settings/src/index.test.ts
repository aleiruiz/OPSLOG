import { describe, expect, it } from 'vitest';
import {
  ALERT_RECIPIENT_ROLES,
  DEFAULT_EXPIRY_WINDOW_DAYS,
  DEFAULT_RECIPIENT_ROLES,
  InMemorySettingsStore,
  MAX_EXPIRY_WINDOW_DAYS,
  SettingsError,
  SettingsService,
  defaultSettings,
  isAlertRecipientRole,
  normalizeRoles,
  parseExpectedVersion,
  parseSettings,
} from './index.js';
import { EXPIRING_WINDOW_DAYS } from '../../documents/src/index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';

const code = async (work: () => Promise<unknown> | unknown): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error instanceof SettingsError ? error.code : error;
  }
  return 'resolved';
};

const service = (store = new InMemorySettingsStore()) =>
  ({ store, service: new SettingsService(store, { now: () => NOW }) }) as const;
const valid = { expiryWindowDays: 15, recipientRoles: ['editor', 'admin'] };

describe('constants', () => {
  it('keeps the window inside the 30 days of the expiry helpers and exposes the role guard', () => {
    expect(MAX_EXPIRY_WINDOW_DAYS).toBe(EXPIRING_WINDOW_DAYS);
    expect(DEFAULT_EXPIRY_WINDOW_DAYS).toBe(30);
    expect(DEFAULT_RECIPIENT_ROLES).toEqual(['admin', 'editor']);
    expect(ALERT_RECIPIENT_ROLES.every(isAlertRecipientRole)).toBe(true);
    expect(isAlertRecipientRole('root')).toBe(false);
    expect(isAlertRecipientRole(7)).toBe(false);
  });
});

describe('parseSettings', () => {
  it('accepts a full replacement and stores the recipients in canonical order', () => {
    expect(parseSettings(valid)).toEqual({
      expiryWindowDays: 15,
      recipientRoles: ['admin', 'editor'],
    });
    expect(normalizeRoles(['auditor', 'viewer'])).toEqual(['viewer', 'auditor']);
    expect(
      parseSettings({ expiryWindowDays: 1, recipientRoles: [...ALERT_RECIPIENT_ROLES] }),
    ).toEqual({ expiryWindowDays: 1, recipientRoles: [...ALERT_RECIPIENT_ROLES] });
    expect(
      parseSettings({ expiryWindowDays: 30, recipientRoles: ['viewer'] }).expiryWindowDays,
    ).toBe(30);
  });

  it('rejects anything else with invalid_input', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      {},
      { expiryWindowDays: 15 },
      { recipientRoles: ['admin'] },
      { ...valid, extra: 1 },
      { ...valid, tenantId: 'other' },
      { expiryWindowDays: 0, recipientRoles: ['admin'] },
      { expiryWindowDays: 31, recipientRoles: ['admin'] },
      { expiryWindowDays: 1.5, recipientRoles: ['admin'] },
      { expiryWindowDays: '15', recipientRoles: ['admin'] },
      { expiryWindowDays: 15, recipientRoles: [] },
      { expiryWindowDays: 15, recipientRoles: 'admin' },
      { expiryWindowDays: 15, recipientRoles: ['root'] },
      { expiryWindowDays: 15, recipientRoles: ['admin', 'admin'] },
      { expiryWindowDays: 15, recipientRoles: [...ALERT_RECIPIENT_ROLES, 'admin'] },
    ];
    for (const input of bad) expect(() => parseSettings(input)).toThrow(SettingsError);
  });

  it('accepts 0 (never saved) or a valid version as the expected version', () => {
    expect(parseExpectedVersion(0)).toBe(0);
    expect(parseExpectedVersion(3)).toBe(3);
    for (const value of [-1, 1.5, '1', null, undefined, 2_147_483_647])
      expect(() => parseExpectedVersion(value)).toThrow(SettingsError);
  });
});

describe('SettingsService', () => {
  it('reads the defaults at version 0 until the company saves', async () => {
    const { service: s } = service();
    expect(await s.get(A)).toEqual(defaultSettings(A));
    expect(defaultSettings(A)).toMatchObject({ version: 0, updatedBy: null, updatedAt: null });
    expect(await code(() => s.get('bad id'))).toBe('invalid_input');
  });

  it('saves the first settings at version 1 and then replaces them with the version of the last read', async () => {
    const { service: s } = service();
    const first = await s.update(A, ACTOR, 0, valid);
    expect(first).toEqual({
      tenantId: A,
      expiryWindowDays: 15,
      recipientRoles: ['admin', 'editor'],
      version: 1,
      updatedBy: ACTOR,
      updatedAt: NOW.toISOString(),
    });
    expect(await s.get(A)).toEqual(first);
    const second = await s.update(A, ACTOR, 1, { expiryWindowDays: 7, recipientRoles: ['viewer'] });
    expect(second).toMatchObject({ version: 2, expiryWindowDays: 7, recipientRoles: ['viewer'] });
    expect(await s.get(A)).toEqual(second);
  });

  it('rejects stale writes: a second first write, an old version, or a version without a row', async () => {
    const { service: s } = service();
    await s.update(A, ACTOR, 0, valid);
    expect(await code(() => s.update(A, ACTOR, 0, valid))).toBe('stale_version');
    expect(await code(() => s.update(A, ACTOR, 5, valid))).toBe('stale_version');
    await s.update(A, ACTOR, 1, valid);
    expect(await code(() => s.update(A, ACTOR, 1, valid))).toBe('stale_version');
    expect(await code(() => s.update(B, ACTOR, 2, valid))).toBe('stale_version');
    expect((await s.get(A)).version).toBe(2);
  });

  it('validates input and ids before touching the store', async () => {
    const { service: s, store } = service();
    expect(await code(() => s.update(A, ACTOR, 0, { ...valid, extra: 1 }))).toBe('invalid_input');
    expect(await code(() => s.update(A, ACTOR, -1, valid))).toBe('invalid_input');
    expect(await code(() => s.update('bad id', ACTOR, 0, valid))).toBe('invalid_input');
    expect(await code(() => s.update(A, '', 0, valid))).toBe('invalid_input');
    expect(await store.find(A)).toBeNull();
  });

  it('keeps tenants apart and returns copies from the store', async () => {
    const { service: s, store } = service();
    await s.update(A, ACTOR, 0, valid);
    expect(await s.get(B)).toEqual(defaultSettings(B));
    expect(await store.find(B)).toBeNull();
    const copy = await store.find(A);
    (copy as { expiryWindowDays: number }).expiryWindowDays = 1;
    expect((await store.find(A))?.expiryWindowDays).toBe(15);
  });

  it('never trusts a row of another tenant returned by a store', async () => {
    const store = new InMemorySettingsStore();
    await store.insert({ ...defaultSettings(B), version: 1 });
    const hostile = {
      ...store,
      find: async () => store.find(B),
    } as unknown as InMemorySettingsStore;
    expect(await new SettingsService(hostile).get(A)).toEqual(defaultSettings(A));
  });

  it('uses the wall clock by default', async () => {
    const written = await new SettingsService(new InMemorySettingsStore()).update(
      A,
      ACTOR,
      0,
      valid,
    );
    expect(Math.abs(Date.now() - Date.parse(written.updatedAt as string))).toBeLessThan(5_000);
  });
});
