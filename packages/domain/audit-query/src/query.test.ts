import { describe, expect, it } from 'vitest';
import { resolveAuditQuery } from './query.js';
import { AuditQueryError } from './errors.js';

const now = new Date('2026-10-19T12:00:00.000Z');
const rejects = (input: Parameters<typeof resolveAuditQuery>[0]) =>
  expect(() => resolveAuditQuery(input, now)).toThrow(AuditQueryError);

describe('resolveAuditQuery', () => {
  it('lists the last 30 days with 25 rows when nothing is asked', () => {
    const { filter, page } = resolveAuditQuery({}, now);
    expect(filter.to).toBe('2026-10-19T12:00:00.001Z');
    expect(Date.parse(filter.to) - Date.parse(filter.from)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(page).toEqual({ limit: 25 });
  });

  it('keeps a valid range and every narrowing filter', () => {
    const { filter, page } = resolveAuditQuery(
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00Z',
        actorId: 'user-1',
        entityType: 'incident',
        entityId: 'inc-1',
        action: 'incident.',
        result: 'denied',
        limit: 100,
        after: { occurredAt: '2026-01-15T00:00:00.000Z', eventId: 'e1' },
      },
      now,
    );
    expect(filter).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      actorId: 'user-1',
      entityType: 'incident',
      entityId: 'inc-1',
      actionPrefix: 'incident.',
      result: 'denied',
    });
    expect(page.limit).toBe(100);
    expect(page.after?.eventId).toBe('e1');
  });

  it('accepts exactly 366 days and refuses one millisecond more', () => {
    const from = '2025-01-01T00:00:00.000Z';
    const ok = new Date(Date.parse(from) + 366 * 86_400_000).toISOString();
    expect(() => resolveAuditQuery({ from, to: ok }, now)).not.toThrow();
    rejects({ from, to: new Date(Date.parse(ok) + 1).toISOString() });
  });

  it('refuses ranges that are inverted, empty, half open or malformed', () => {
    rejects({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
    rejects({ from: '2026-02-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
    rejects({ from: '2026-02-01T00:00:00.000Z' });
    rejects({ to: '2026-02-01T00:00:00.000Z' });
    rejects({ from: 'ayer', to: '2026-02-01T00:00:00.000Z' });
    rejects({ from: '2026-02-30T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' });
  });

  it('refuses page sizes, filters and positions outside the allowlists', () => {
    rejects({ limit: 10 });
    rejects({ entityType: 'sql_injection' });
    rejects({ action: 'DROP TABLE' });
    rejects({ action: 'unknown_domain.' });
    rejects({ result: 'maybe' });
    rejects({ actorId: "x' OR 1=1" });
    rejects({ entityId: '' });
    rejects({ after: { occurredAt: 'no', eventId: 'e1' } });
    rejects({ after: { occurredAt: '2026-01-15T00:00:00.000Z', eventId: '../' } });
  });
});
