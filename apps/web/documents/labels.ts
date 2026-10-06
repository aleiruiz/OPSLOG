import type { StatusTone } from '@opslog/ui';
import type { Document, DocumentOwnerType, DocumentStatus } from '../app/types';
import { DOCUMENT_TYPES, typeInfo } from './rules';

/** BRD §12.2 labels; the technical ids never reach the screen. */
export const statusPresentation: Record<
  DocumentStatus | 'replaced',
  { label: string; tone: StatusTone }
> = {
  valid: { label: 'Vigente', tone: 'success' },
  expiring: { label: 'Por vencer', tone: 'warning' },
  expired: { label: 'Vencido', tone: 'danger' },
  replaced: { label: 'Reemplazado', tone: 'neutral' },
};

export const statusOrder: readonly DocumentStatus[] = ['valid', 'expiring', 'expired'];

export const ownerTypeLabels: Record<DocumentOwnerType, string> = {
  vehicle: 'Vehículo',
  employee: 'Empleado',
};

/** Label of a type code; an unknown code (a newer backend) is shown generically, never as a technical id. */
export function typeLabel(ownerType: DocumentOwnerType, code: string): string {
  return typeInfo(ownerType, code)?.label ?? 'Otro documento';
}

/** Every distinct type of the catalog, for a filter that does not pick an owner type. */
export function allTypes(): readonly { code: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const list of Object.values(DOCUMENT_TYPES))
    for (const type of list) if (!seen.has(type.code)) seen.set(type.code, type.label);
  return [...seen].map(([code, label]) => ({ code, label }));
}

export const formatDate = (value: string): string =>
  new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toLocaleDateString('es-MX', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

export const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Vence hoy", "Faltan 12 días", "Venció hace 3 días", or "Sin vencimiento". */
export function expiryNote(daysToExpiry: number | null): string {
  if (daysToExpiry === null) return 'Sin vencimiento';
  if (daysToExpiry === 0) return 'Vence hoy';
  if (daysToExpiry > 0) return `Faltan ${plural(daysToExpiry, 'día', 'días')}`;
  return `Venció hace ${plural(-daysToExpiry, 'día', 'días')}`;
}

/** An archived document is a read-only record (the backend answers 409 `immutable`). */
export const isEditable = (document: Pick<Document, 'archivedAt'>): boolean =>
  document.archivedAt === null;
