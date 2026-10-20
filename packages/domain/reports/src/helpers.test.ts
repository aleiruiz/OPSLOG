import { describe, expect, it } from 'vitest';
import { addDays, momentInZone, startOfDay } from './calendar.js';
import { decimalNumber, decimalText, moneyText, sumByCurrency } from './money.js';
import { groupDigits, inPeriod, percentiles, round, textFilter } from './rows.js';

describe('money', () => {
  it('writes minor units as exact decimals for any number of digits', () => {
    expect(decimalText('150050', 'MXN')).toBe('1500.50');
    expect(decimalText('5', 'MXN')).toBe('0.05');
    expect(decimalText('0', 'USD')).toBe('0.00');
    expect(decimalText('-150', 'MXN')).toBe('-1.50');
    expect(decimalText('500', 'JPY')).toBe('500');
    expect(decimalText('1234', 'XXXX')).toBe('12.34');
    expect(decimalNumber('150050', 'MXN')).toBe(1500.5);
  });

  it('adds per currency, ordered, and prints every currency apart', () => {
    const lines = [
      { currency: 'USD', amountMinor: '100' },
      { currency: 'MXN', amountMinor: '250' },
      { currency: 'USD', amountMinor: '-30' },
      { currency: 'EUR', amountMinor: '1' },
    ];
    expect(sumByCurrency(lines)).toEqual([
      { currency: 'EUR', amountMinor: '1' },
      { currency: 'MXN', amountMinor: '250' },
      { currency: 'USD', amountMinor: '70' },
    ]);
    expect(moneyText(lines)).toBe('EUR 0.01; MXN 2.50; USD 0.70');
    expect(moneyText([])).toBeNull();
  });
});

describe('calendar', () => {
  it('finds the start of a day in a zone, also across the daylight saving change', () => {
    expect(startOfDay('2026-10-19', 'America/Mexico_City').toISOString()).toBe(
      '2026-10-19T06:00:00.000Z',
    );
    expect(startOfDay('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(startOfDay('2026-01-01', 'Asia/Kolkata').toISOString()).toBe('2025-12-31T18:30:00.000Z');
    expect(startOfDay('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('adds days and prints a moment in the zone of the company', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(addDays('2026-03-02', -3)).toBe('2026-02-27');
    expect(momentInZone(new Date('2026-10-19T03:05:00.000Z'), 'America/Mexico_City')).toBe(
      '2026-10-18 21:05',
    );
    expect(momentInZone(new Date('2026-10-19T00:00:00.000Z'), 'UTC')).toBe('2026-10-19 00:00');
  });
});

describe('row helpers', () => {
  it('computes the median and the nearest-rank p90', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([5])).toEqual({ median: 5, p90: 5 });
    expect(percentiles([3, 1, 2])).toEqual({ median: 2, p90: 3 });
    expect(percentiles([1, 2, 3, 4])).toEqual({ median: 2.5, p90: 4 });
    expect(percentiles(Array.from({ length: 10 }, (_, i) => i + 1))?.p90).toBe(9);
  });

  it('keeps a day inside optional bounds and groups digits the same everywhere', () => {
    const none = new Map<string, string | number>();
    const bounds = new Map<string, string | number>([
      ['from', '2026-01-10'],
      ['to', '2026-01-20'],
    ]);
    expect(inPeriod(null, none)).toBe(true);
    expect(inPeriod(null, bounds)).toBe(false);
    expect(inPeriod('2026-01-10', bounds)).toBe(true);
    expect(inPeriod('2026-01-21', bounds)).toBe(false);
    expect(inPeriod('2026-01-05', new Map([['to', '2026-01-10']]))).toBe(true);
    expect(textFilter(bounds, 'from')).toBe('2026-01-10');
    expect(textFilter(new Map([['n', 3]]), 'n')).toBeUndefined();
    expect(textFilter(none, 'x')).toBeUndefined();
    expect(groupDigits(1234567)).toBe('1,234,567');
    expect(groupDigits(999)).toBe('999');
    expect(round(1.23456, 2)).toBe(1.23);
  });
});
