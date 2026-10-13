const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar day `YYYY-MM-DD` of an instant in an IANA zone (the tenant's, SPECS:184). */
export function dayInZone(instant: Date, timeZone: string): string {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}

/** Year of the folio: the tenant's calendar year at creation time. */
export const folioYear = (instant: Date, timeZone: string): number =>
  Number(dayInZone(instant, timeZone).slice(0, 4));

export const FOLIO_PATTERN = /^SIN-\d{4}-\d{6,}$/;
/** `SIN-<year>-<6-digit sequence>`; the sequence only grows, so a cancelled folio is never reused. */
export const formatFolio = (year: number, sequence: number): string =>
  `SIN-${year}-${String(sequence).padStart(6, '0')}`;
