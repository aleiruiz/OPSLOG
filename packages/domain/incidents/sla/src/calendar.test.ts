import { describe, expect, it } from 'vitest';
import { addCalendarDays } from './calendar.js';

describe('addCalendarDays', () => {
  it('adds calendar days in UTC', () => {
    expect(addCalendarDays('2026-11-01T10:00:00.000Z', 15, 'UTC')).toBe('2026-11-16T10:00:00.000Z');
    expect(addCalendarDays('2026-12-20T23:59:59.500Z', 30, 'UTC')).toBe('2027-01-19T23:59:59.500Z');
  });

  it('keeps the local hour of the start in the tenant zone, not midnight UTC', () => {
    // 10:00 in Mexico City (UTC-6 in November) is 16:00Z, and so is the deadline.
    expect(addCalendarDays('2026-11-01T16:00:00.000Z', 15, 'America/Mexico_City')).toBe(
      '2026-11-16T16:00:00.000Z',
    );
    expect(addCalendarDays('2026-11-01T16:00:00.000Z', 15, 'UTC')).toBe('2026-11-16T16:00:00.000Z');
    // The same instant has a different local hour in Tokyo: the deadline follows that hour.
    expect(addCalendarDays('2026-11-01T16:00:00.000Z', 1, 'Asia/Tokyo')).toBe(
      '2026-11-02T16:00:00.000Z',
    );
  });

  it('keeps the local hour across a daylight-saving change', () => {
    // New York: 10:00 EST on 7 March is 10:00 EDT on 8 March, one hour earlier in UTC.
    expect(addCalendarDays('2026-03-07T15:00:00.000Z', 1, 'America/New_York')).toBe(
      '2026-03-08T14:00:00.000Z',
    );
    // And the other way round on 1 November.
    expect(addCalendarDays('2026-10-31T14:00:00.000Z', 1, 'America/New_York')).toBe(
      '2026-11-01T15:00:00.000Z',
    );
  });

  it('moves a local time that does not exist to the first instant after the gap', () => {
    // 02:30 EST on 7 March + 1 day would be 02:30 on 8 March, which never happened in New York.
    expect(addCalendarDays('2026-03-07T07:30:00.000Z', 1, 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('takes the earlier instant of a local time that happens twice', () => {
    // 01:30 on 1 November happens as EDT (05:30Z) and again as EST (06:30Z).
    expect(addCalendarDays('2026-10-31T05:30:00.000Z', 1, 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('keeps milliseconds and handles zero days', () => {
    expect(addCalendarDays('2026-11-01T16:00:00.123Z', 0, 'America/Mexico_City')).toBe(
      '2026-11-01T16:00:00.123Z',
    );
  });
});
