import type { CostThreshold, CostTotals } from './ports.js';

/**
 * D20 by amount (ADR-0014): an approval of a member with `incidents:approve` is needed only when a
 * threshold is configured and what the company bears is strictly above it. Equal does not ask.
 * Without conversion, any amount above zero in another currency asks, because nobody can prove it
 * does not exceed the threshold. Totals nobody can read ask as well (fail closed); with no threshold
 * nothing is asked or invented.
 */
export function approvalRequired(threshold: CostThreshold | null, totals: CostTotals): boolean {
  if (threshold === null) return false;
  if (!totals.available) return true;
  const limit = BigInt(threshold.amountMinor);
  return totals.companyBorne.some(({ currency, amountMinor }) =>
    currency === threshold.currency ? BigInt(amountMinor) > limit : BigInt(amountMinor) > 0n,
  );
}
