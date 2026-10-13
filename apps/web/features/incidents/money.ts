import type { BffMoney } from '@opslog/contracts';

/** Digits after the decimal point of a currency's minor unit (2 for MXN or USD, 0 for JPY); 2 when unknown. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * An exact amount in minor units as text (`100001` MXN -> `1,000.01 MXN`). It works on digits only, so a large
 * amount never goes through a float. A negative total (recoveries above expenses) keeps its sign.
 */
export function formatMinor(amountMinor: string, currency: string): string {
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).replace(/\D/g, '') || '0';
  const places = minorDigits(currency);
  const padded = digits.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  const fraction = places > 0 ? `.${padded.slice(-places)}` : '';
  return `${negative ? '-' : ''}${group(whole)}${fraction} ${currency}`;
}
export const formatMoney = (money: BffMoney): string =>
  formatMinor(money.amountMinor, money.currency);

/** What the person types for an amount, in major units (`1500.5`), as the exact minor-unit digits; `null` if invalid or zero. */
export function parseAmount(text: string, currency: string): string | null {
  const places = minorDigits(currency);
  const match = /^(\d{1,15})(?:[.,](\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > places) return null;
  const minor = `${match[1]}${fraction.padEnd(places, '0')}`.replace(/^0+(?=\d)/, '');
  // The server accepts 1 to 15 digits and no zero.
  return /^[1-9]\d{0,14}$/.test(minor) ? minor : null;
}

/** An amount in minor units as the plain major-unit text a field shows (`150050` -> `1500.50`). */
export function amountText(amountMinor: string, currency: string): string {
  const places = minorDigits(currency);
  const padded = amountMinor.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places);
  return places > 0 ? `${whole}.${padded.slice(-places)}` : whole;
}
