import type { StatusTone } from '@opslog/ui';
import type { Vehicle, VehicleStatus } from '../app/types';

/** BRD §8.6 labels; the technical ids never reach the screen. */
export const statusPresentation: Record<VehicleStatus, { label: string; tone: StatusTone }> = {
  active: { label: 'Activo', tone: 'success' },
  restricted: { label: 'Restringido', tone: 'warning' },
  in_maintenance: { label: 'En mantenimiento', tone: 'notice' },
  out_of_service: { label: 'Fuera de servicio', tone: 'danger' },
  inactive: { label: 'Inactivo', tone: 'neutral' },
  decommissioned: { label: 'Baja', tone: 'neutral' },
};

export const statusOrder: readonly VehicleStatus[] = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
];

export const formatKm = (km: number): string => `${new Intl.NumberFormat('es-MX').format(km)} km`;

export const formatDate = (value: string): string =>
  new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toLocaleDateString('es-MX', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

export const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

/** Archived and decommissioned vehicles are read-only (the backend answers 409 `immutable`). */
export const isEditable = (vehicle: Vehicle): boolean =>
  vehicle.archivedAt === null && vehicle.status !== 'decommissioned';

/** Archiving is a logical removal: allowed for a decommissioned vehicle, not twice. */
export const isArchivable = (vehicle: Vehicle): boolean => vehicle.archivedAt === null;
