import { StatusBadge } from '@opslog/ui';
import type { BffIncidentSla } from '@opslog/contracts';
import { SLA_LABELS, SLA_TONES } from './labelsCosts';

/** The SLA of a case as text and tone; nothing when the deployment sends no `sla` block. */
export function SlaBadge({ sla }: { sla: BffIncidentSla | undefined }) {
  if (!sla) return null;
  return <StatusBadge label={SLA_LABELS[sla.state]} tone={SLA_TONES[sla.state]} />;
}
