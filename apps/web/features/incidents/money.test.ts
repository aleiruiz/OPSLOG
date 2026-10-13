import { describe, expect, it } from 'vitest';
import { amountText, formatMinor, formatMoney, minorDigits, parseAmount } from './money';
import { deductibleText } from './labelsCosts';
import {
  NO_EDITS,
  costsInput,
  estimateProblem,
  isDirty,
  lineDraft,
  lineProblem,
  reconcile,
  workingLines,
} from './costsModel';
import { asTab, tabsFor } from './paths';

describe('money', () => {
  it('formats exact minor units without floats, with grouping and sign', () => {
    expect(formatMinor('100001', 'MXN')).toBe('1,000.01 MXN');
    expect(formatMinor('5', 'MXN')).toBe('0.05 MXN');
    expect(formatMinor('0', 'USD')).toBe('0.00 USD');
    expect(formatMinor('-2000000', 'MXN')).toBe('-20,000.00 MXN');
    expect(formatMinor('123456789012345678', 'MXN')).toBe('1,234,567,890,123,456.78 MXN');
    expect(formatMinor('1500', 'JPY')).toBe('1,500 JPY');
    expect(formatMoney({ amountMinor: '45000', currency: 'MXN' })).toBe('450.00 MXN');
  });

  it('knows the minor unit of a currency and falls back to two digits', () => {
    expect(minorDigits('MXN')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('???')).toBe(2);
  });

  it('parses what is typed in major units into exact minor units, or refuses', () => {
    expect(parseAmount('1500.5', 'MXN')).toBe('150050');
    expect(parseAmount(' 10 ', 'MXN')).toBe('1000');
    expect(parseAmount('0,5', 'MXN')).toBe('50');
    expect(parseAmount('1500', 'JPY')).toBe('1500');
    for (const bad of ['', '0', '0.00', '-1', '1.234', 'abc', '1e3', '1234567890123456'])
      expect(parseAmount(bad, 'MXN')).toBeNull();
    expect(parseAmount('1.5', 'JPY')).toBeNull();
    expect(amountText('150050', 'MXN')).toBe('1500.50');
    expect(amountText('5', 'MXN')).toBe('0.05');
    expect(amountText('1500', 'JPY')).toBe('1500');
  });

  it('shows a percentage deductible as a percentage and an amount as an amount', () => {
    expect(deductibleText({ kind: 'percent', basisPoints: 1000 })).toBe('10 % del monto reclamado');
    expect(deductibleText({ kind: 'percent', basisPoints: 1250 })).toBe(
      '12.5 % del monto reclamado',
    );
    expect(deductibleText({ kind: 'percent', basisPoints: 1205 })).toBe(
      '12.05 % del monto reclamado',
    );
    expect(deductibleText({ kind: 'amount', amountMinor: '300000', currency: 'MXN' })).toBe(
      '3,000.00 MXN',
    );
  });
});

describe('cost edits', () => {
  const server = [
    {
      id: 'a',
      kind: 'expense' as const,
      category: 'fine' as const,
      amount: { amountMinor: '30000', currency: 'MXN' },
      note: null,
    },
    {
      id: 'b',
      kind: 'recovery' as const,
      category: 'insurer' as const,
      amount: { amountMinor: '500', currency: 'MXN' },
      note: 'Pago',
    },
  ];

  it('applies removed, changed and added over the server lines, and builds the replacement', () => {
    expect(isDirty(NO_EDITS)).toBe(false);
    const changed = { ...lineDraft(server[0] as never), amount: '450' };
    const added = { ...lineDraft(server[1] as never), key: 'new-1', id: null, note: '  ' };
    const edits = { added: [added], changed: { a: changed }, removed: ['b'], estimate: undefined };
    expect(isDirty(edits)).toBe(true);
    expect(workingLines(server, edits).map((line) => line.key)).toEqual(['a', 'new-1']);
    expect(costsInput(7, server, edits)).toEqual({
      version: 7,
      lines: [
        {
          id: 'a',
          kind: 'expense',
          category: 'fine',
          amount: { amountMinor: '45000', currency: 'MXN' },
          note: null,
        },
        {
          kind: 'recovery',
          category: 'insurer',
          amount: { amountMinor: '500', currency: 'MXN' },
          note: null,
        },
      ],
    });
  });

  it('sends the estimate only when it changed, and null to clear it', () => {
    expect(costsInput(1, [], { ...NO_EDITS, estimate: null }).initialEstimate).toBeNull();
    expect(
      costsInput(1, [], { ...NO_EDITS, estimate: { amount: '10', currency: 'MXN' } })
        .initialEstimate,
    ).toEqual({ amountMinor: '1000', currency: 'MXN' });
    expect('initialEstimate' in costsInput(1, [], NO_EDITS)).toBe(false);
  });

  it('drops changes to lines the server no longer has', () => {
    const edits = {
      ...NO_EDITS,
      changed: { gone: lineDraft(server[0] as never), a: lineDraft(server[0] as never) },
      removed: ['gone', 'b'],
    };
    const kept = reconcile(edits, server);
    expect(Object.keys(kept.changed)).toEqual(['a']);
    expect(kept.removed).toEqual(['b']);
  });

  it('names what is wrong with a line or an estimate', () => {
    const ok = { ...lineDraft(server[0] as never) };
    expect(lineProblem(ok)).toBeNull();
    expect(lineProblem({ ...ok, currency: 'mx' })).toMatch(/tres letras/);
    expect(lineProblem({ ...ok, amount: '0' })).toMatch(/mayor a cero/);
    expect(lineProblem({ ...ok, note: 'x'.repeat(201) })).toMatch(/200/);
    expect(estimateProblem({ amount: '0', currency: 'MXN' })).toMatch(/mayor a cero/);
    expect(estimateProblem({ amount: '5', currency: 'M' })).toMatch(/tres letras/);
    expect(estimateProblem({ amount: '5', currency: 'MXN' })).toBeNull();
  });
});

describe('tabs by permission', () => {
  it('offers Costos only to who may see costs, and falls back to the summary otherwise', () => {
    expect(tabsFor(true)).toContain('costs');
    expect(tabsFor(false)).not.toContain('costs');
    expect(asTab('costs', true)).toBe('costs');
    expect(asTab('costs', false)).toBe('summary');
    expect(asTab('costs')).toBe('summary');
    expect(asTab('repair')).toBe('repair');
  });
});
