import { formatDateTime } from './time';
import { useIncidentEnv } from './context';

/** An instant in the company's zone, as text. */
export function DateTime({ value }: { value: string | null }) {
  return <>{formatDateTime(value, useIncidentEnv().zone)}</>;
}
