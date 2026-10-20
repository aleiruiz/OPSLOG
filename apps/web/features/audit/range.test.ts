import { describe, expect, it } from 'vitest';
import { addDays, resolveRange, shortcutDays } from './range';

describe('audit date range', () => {
  it('turns inclusive days into instants of the company zone', () => {
    expect(resolveRange('2026-10-01', '2026-10-02', 'UTC')).toEqual({
      ok: true,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-03T00:00:00.000Z',
    });
    expect(resolveRange('2026-10-01', '2026-10-01', 'America/Mexico_City')).toEqual({
      ok: true,
      from: '2026-10-01T06:00:00.000Z',
      to: '2026-10-02T06:00:00.000Z',
    });
  });

  it('leaves the range open when both days are empty and rejects the incomplete or inverted', () => {
    expect(resolveRange('', '', 'UTC')).toEqual({ ok: true });
    expect(resolveRange('2026-10-01', '', 'UTC')).toMatchObject({ ok: false });
    expect(resolveRange('2026-10-02', '2026-10-01', 'UTC')).toMatchObject({ ok: false });
  });

  it('accepts exactly 366 days and rejects 367', () => {
    expect(resolveRange('2025-10-19', '2026-10-19', 'UTC').ok).toBe(true);
    expect(resolveRange('2025-10-18', '2026-10-19', 'UTC')).toMatchObject({ ok: false });
  });

  it('counts shortcuts on the wall clock of the zone', () => {
    const now = Date.parse('2026-10-19T02:00:00Z');
    expect(shortcutDays('today', now, 'UTC')).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(shortcutDays('today', now, 'America/Mexico_City')).toEqual({
      from: '2026-10-18',
      to: '2026-10-18',
    });
    expect(shortcutDays('30', now, 'UTC')).toEqual({ from: '2026-09-20', to: '2026-10-19' });
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('reports an impossible calendar day', () => {
    expect(resolveRange('2026-02-30', '2026-03-02', 'UTC')).toMatchObject({ ok: false });
  });
});
