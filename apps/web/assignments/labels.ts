import type { StatusTone } from '@opslog/ui';
import type {
  AssignmentEndKind,
  AssignmentEvent,
  AssignmentStatus,
  AssignmentType,
  VehicleAssignment,
} from '../app/types';

export { formatDateTime } from '../vehicles/labels';

/** BRD §8.7 labels; the technical ids never reach the screen. */
export const typeLabels: Record<AssignmentType, string> = {
  principal: 'Principal',
  secondary: 'Secundario',
  temporary: 'Temporal',
};

export const typeOrder: readonly AssignmentType[] = ['principal', 'secondary', 'temporary'];

/** Label of a type code; an unknown one (a newer backend) is shown generically, never as a technical id. */
export const typeLabel = (code: string): string =>
  (typeLabels as Record<string, string>)[code] ?? 'Otro tipo';

export const statusPresentation: Record<AssignmentStatus, { label: string; tone: StatusTone }> = {
  current: { label: 'Vigente', tone: 'success' },
  ended: { label: 'Finalizada', tone: 'neutral' },
};

export const statusFilterLabels: Record<AssignmentStatus, string> = {
  current: 'Solo vigentes',
  ended: 'Solo finalizadas',
};

export const statusOrder: readonly AssignmentStatus[] = ['current', 'ended'];

export const endKindLabels: Record<AssignmentEndKind, string> = {
  ended: 'Cerrada por una persona',
  replaced: 'Reemplazada por un nuevo principal',
};

export const eventLabels: Record<AssignmentEvent['kind'], string> = {
  assigned: 'Asignada',
  ended: 'Cerrada',
  replaced: 'Reemplazada',
};

export const eventLabel = (kind: string): string =>
  (eventLabels as Record<string, string>)[kind] ?? 'Cambio';

/** A closed assignment is a read-only record (the backend answers 409 `immutable`). */
export const isCurrent = (assignment: Pick<VehicleAssignment, 'endedAt'>): boolean =>
  assignment.endedAt === null;
