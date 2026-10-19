/** Percent with one decimal; null when the denominator is 0 (the view says "sin datos", never 0 % or 100 %). */
export function percentOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((1000 * numerator) / denominator) / 10;
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Median of a non-empty list: the middle value, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Nearest-rank percentile of a non-empty list: the value at rank `ceil(p * n)` (1-based). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}
