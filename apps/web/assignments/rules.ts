import type { VehicleStatus } from '../app/types';

/**
 * Field rules of an assignment, mirrored from the domain (`packages/domain/assignments`). The server stays the
 * authority and answers a uniform 400 without saying which field failed, so the forms check the same rules first and
 * explain the problem next to the field.
 */
export const ASSIGNMENT_TYPES = ['principal', 'secondary', 'temporary'] as const;
export const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** One line, 1 to 200 characters, no control characters. */
export const REASON = /^[^\u0000-\u001f\u007f]{1,200}$/u;
export const normalizeReason = (value: string): string => value.trim().replace(/\s+/g, ' ');

/** BR-014: a vehicle that is inactive or decommissioned cannot be assigned (the server refuses it with a 422). */
export const assignableVehicleStatus = (status: VehicleStatus | undefined): boolean =>
  status !== 'inactive' && status !== 'decommissioned';
