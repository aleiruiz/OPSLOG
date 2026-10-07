import { describe, expect, it } from 'vitest';
import { makeSettings } from './fixtures';
import { isUnchanged, orderedRoles, toInput, validate, valuesOf } from './settingsModel';

const values = (days: string, roles = ['admin', 'editor'] as const) => ({
  expiryWindowDays: days,
  recipientRoles: roles,
});

describe('alert settings form model', () => {
  it('starts from the saved settings', () => {
    expect(
      valuesOf(makeSettings({ expiryWindowDays: 15, recipientRoles: ['admin', 'auditor'] })),
    ).toEqual({
      expiryWindowDays: '15',
      recipientRoles: ['admin', 'auditor'],
    });
  });

  it('accepts whole days from 1 to 30, with surrounding spaces', () => {
    for (const days of ['1', '15', ' 30 ']) expect(validate(values(days))).toEqual({});
  });

  it('explains a missing, fractional, out-of-range or non-numeric window', () => {
    expect(validate(values('')).expiryWindowDays).toBe('Escribe los días de anticipación.');
    for (const days of ['0', '31', '2.5', '-3', 'abc', '1e1', '1000'])
      expect(validate(values(days)).expiryWindowDays).toBe(
        'Escribe un número entero entre 1 y 30.',
      );
  });

  it('asks for at least one recipient role', () => {
    expect(validate(values('10', [] as never)).recipientRoles).toBe(
      'Elige al menos un rol que reciba las alertas.',
    );
  });

  it('builds the full replacement in canonical role order with the version of the last read', () => {
    expect(toInput(values(' 12 ', ['viewer', 'admin'] as never), 4)).toEqual({
      version: 4,
      expiryWindowDays: 12,
      recipientRoles: ['admin', 'viewer'],
    });
    expect(orderedRoles(['pii_reader', 'editor'])).toEqual(['editor', 'pii_reader']);
  });

  it('knows when a save would change nothing', () => {
    const settings = makeSettings({ expiryWindowDays: 30, recipientRoles: ['admin', 'editor'] });
    expect(isUnchanged(settings, values('30', ['editor', 'admin'] as never))).toBe(true);
    expect(isUnchanged(settings, values('29'))).toBe(false);
    expect(isUnchanged(settings, values('30', ['admin'] as never))).toBe(false);
    expect(isUnchanged(settings, values('30', ['admin', 'viewer'] as never))).toBe(false);
  });
});
