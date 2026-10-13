import type { CostLine, CurrencyTotals, Money } from './ports.js';

/** Sum of amounts per currency, exact (BigInt), ordered by currency. */
export function sumByCurrency(amounts: readonly Money[]): readonly Money[] {
  const sums = new Map<string, bigint>();
  for (const { currency, amountMinor } of amounts)
    sums.set(currency, (sums.get(currency) ?? 0n) + BigInt(amountMinor));
  return [...sums]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, total]) => ({ currency, amountMinor: total.toString() }));
}

/**
 * The totals of a case by currency (BR-027): the linked orders' costs, the own expenses and the
 * recoveries. A currency never converts or merges with another, and a currency appears when any
 * amount used it.
 */
export function summarize(
  lines: readonly CostLine[],
  orderCosts: readonly Money[],
): readonly CurrencyTotals[] {
  const of = (kind: 'expense' | 'recovery') =>
    sumByCurrency(lines.filter((line) => line.kind === kind).map((line) => line.amount));
  const repairs = sumByCurrency(orderCosts);
  const expenses = of('expense');
  const recoveries = of('recovery');
  const get = (rows: readonly Money[], currency: string): bigint =>
    BigInt(rows.find((row) => row.currency === currency)?.amountMinor ?? '0');
  const currencies = [
    ...new Set([...repairs, ...expenses, ...recoveries].map((row) => row.currency)),
  ].sort();
  return currencies.map((currency) => {
    const [r, e, c] = [get(repairs, currency), get(expenses, currency), get(recoveries, currency)];
    return {
      currency,
      repairs: r.toString(),
      expenses: e.toString(),
      recoveries: c.toString(),
      companyBorne: (r + e - c).toString(),
    };
  });
}
