import type { StatusTone } from '@opslog/ui';
import type { CoverageType, Deductible, InsurancePolicy, PolicyStatus } from '../app/types';
import { currencyExponent } from './rules';

export { formatDate, formatDateTime, expiryNote } from '../documents/labels';

/** BRD §8.4 labels; the technical ids never reach the screen. */
export const statusPresentation: Record<
  PolicyStatus | 'replaced',
  { label: string; tone: StatusTone }
> = {
  valid: { label: 'Vigente', tone: 'success' },
  expiring: { label: 'Por vencer', tone: 'warning' },
  expired: { label: 'Vencida', tone: 'danger' },
  replaced: { label: 'Reemplazada', tone: 'neutral' },
};

export const statusOrder: readonly PolicyStatus[] = ['valid', 'expiring', 'expired'];

export const coverageLabels: Record<CoverageType, string> = {
  mandatory_liability: 'Responsabilidad civil obligatoria',
  third_party: 'Daños a terceros',
  comprehensive: 'Todo riesgo',
  other: 'Otra cobertura',
};

/** Label of a coverage code; an unknown one (a newer backend) is shown generically, never as a technical id. */
export const coverageLabel = (code: string): string =>
  (coverageLabels as Record<string, string>)[code] ?? 'Otra cobertura';

/** A policy whose period has not begun is `valid` but not yet covering. */
export const notStarted = (policy: Pick<InsurancePolicy, 'status' | 'covering'>): boolean =>
  policy.status === 'valid' && !policy.covering;

/** "12,500.00 MXN" or "15 %" (an exact decimal rendering of integers: no float arithmetic on money). */
export function formatDeductible(deductible: Deductible): string {
  if (deductible.kind === 'percent') {
    const whole = Math.floor(deductible.basisPoints / 100);
    const fraction = deductible.basisPoints % 100;
    const text = fraction === 0 ? '' : `,${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
    return `${whole}${text} %`;
  }
  const exponent = currencyExponent(deductible.currency) ?? 2;
  const formatter = new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
  // Up to 10^12 minor units: the division is exact enough for display (the API value stays an integer).
  return `${formatter.format(deductible.amountMinor / 10 ** exponent)} ${deductible.currency}`;
}

/** An archived policy is a read-only record (the backend answers 409 `immutable`). */
export const isEditable = (policy: Pick<InsurancePolicy, 'archivedAt'>): boolean =>
  policy.archivedAt === null;
