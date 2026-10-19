import { currencyDigits } from './definitions/vehicles.js';

export interface Amount {
  readonly amountMinor: string;
  readonly currency: string;
}

/** Exact decimal text of a minor-unit amount (`150050` MXN is `1500.50`); no float is involved. */
export function decimalText(amountMinor: string, currency: string): string {
  const digits = currencyDigits(currency);
  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const raw = (negative ? -value : value).toString().padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits);
  const body = digits === 0 ? whole : `${whole}.${raw.slice(raw.length - digits)}`;
  return negative ? `-${body}` : body;
}

/** The decimal as a number for numeric cells; amounts here are far below 2^53 minor units. */
export const decimalNumber = (amountMinor: string, currency: string): number =>
  Number(decimalText(amountMinor, currency));

/** Sum per currency, exact, ordered by currency. */
export function sumByCurrency(amounts: readonly Amount[]): readonly Amount[] {
  const sums = new Map<string, bigint>();
  for (const { currency, amountMinor } of amounts)
    sums.set(currency, (sums.get(currency) ?? 0n) + BigInt(amountMinor));
  return [...sums]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, total]) => ({ currency, amountMinor: total.toString() }));
}

/** `MXN 1500.50; USD 20.00`: every currency apart, never added to another. Null when there is nothing. */
export function moneyText(amounts: readonly Amount[]): string | null {
  const sums = sumByCurrency(amounts);
  return sums.length === 0
    ? null
    : sums.map((m) => `${m.currency} ${decimalText(m.amountMinor, m.currency)}`).join('; ');
}
