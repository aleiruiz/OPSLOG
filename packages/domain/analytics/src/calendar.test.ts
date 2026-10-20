import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayEnd,
  dayOf,
  daysBetween,
  dayStart,
  isCalendarDay,
  monthOf,
  monthsBetween,
} from './calendar.js';

describe('calendar days', () => {
  it('accepts only real days written YYYY-MM-DD', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', null, 5, undefined])
      expect(isCalendarDay(bad)).toBe(false);
  });

  it('adds days and counts the days between two days', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-10-19', '2026-11-03')).toBe(15);
    expect(daysBetween('2026-10-19', '2026-10-01')).toBe(-18);
  });

  it('lists the months of a range across a year boundary', () => {
    expect(monthsBetween('2026-11-15', '2027-02-03')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(monthsBetween('2026-10-01', '2026-10-31')).toEqual(['2026-10']);
    expect(monthOf('2026-10-19')).toBe('2026-10');
  });
});

describe('company zone', () => {
  it('puts the instants around local midnight on the right day', () => {
    expect(dayOf('2026-10-19T05:59:59.999Z', 'America/Mexico_City')).toBe('2026-10-18');
    expect(dayOf('2026-10-19T06:00:00.000Z', 'America/Mexico_City')).toBe('2026-10-19');
    expect(dayOf(new Date('2026-10-19T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-20');
    expect(dayOf(Date.parse('2026-10-19T23:30:00Z'), 'UTC')).toBe('2026-10-19');
  });

  it('starts and ends a day in the zone', () => {
    expect(new Date(dayStart('2026-10-19', 'America/Mexico_City')).toISOString()).toBe(
      '2026-10-19T06:00:00.000Z',
    );
    expect(new Date(dayEnd('2026-10-19', 'America/Mexico_City')).toISOString()).toBe(
      '2026-10-20T05:59:59.999Z',
    );
    expect(new Date(dayStart('2026-10-19', 'UTC')).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('follows daylight saving: a 23-hour and a 25-hour day', () => {
    const zone = 'America/New_York';
    expect(new Date(dayStart('2026-03-08', zone)).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(dayStart('2026-03-09', zone)).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(new Date(dayStart('2026-11-01', zone)).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(dayStart('2026-11-02', zone)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('starts a day whose midnight does not exist at the first instant after the gap', () => {
    // Brazil began summer time at midnight on 2018-11-04: 00:00 jumped to 01:00.
    expect(new Date(dayStart('2018-11-04', 'America/Sao_Paulo')).toISOString()).toBe(
      '2018-11-04T03:00:00.000Z',
    );
  });
});
