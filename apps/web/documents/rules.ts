import type { DocumentOwnerType } from '../app/types';

/**
 * Field rules of a document, mirrored from the domain (`packages/domain/documents`). The server stays the
 * authority and answers a uniform 400 without saying which field failed, so the forms check the same rules first
 * and explain the problem next to the field.
 */
export const MIN_DATE = '1950-01-01';
export const MAX_EXPIRY_DATE = '2100-12-31';
/** A document or policy is `expiring` from 30 days before its last valid day (BRD §15). */
export const EXPIRING_WINDOW_DAYS = 30;

export const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TITLE = /^[^\u0000-\u001f\u007f]{1,80}$/u;
export const NOTES = /^[^\u0000-\u001f\u007f]{1,500}$/u;
/** Shared by document numbers and policy numbers. */
export const REFERENCE_NUMBER = /^[A-Z0-9][A-Z0-9 ./-]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
export const normalizeReference = (value: string): string => normalizeText(value).toUpperCase();

export const todayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** A real calendar date `YYYY-MM-DD` between the two limits (inclusive). */
export function isDateBetween(value: string, min: string, max: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && todayOf(parsed) === value && value >= min && value <= max
  );
}

/** Whether a document type needs an expiry date. */
export type ExpiryRule = 'required' | 'optional';

export interface DocumentTypeInfo {
  readonly code: string;
  readonly label: string;
  readonly expiry: ExpiryRule;
}

/** Built-in catalog by owner, mirrored from the domain (the per-company catalog is FLT-SETTINGS). */
export const DOCUMENT_TYPES: Record<DocumentOwnerType, readonly DocumentTypeInfo[]> = {
  vehicle: [
    { code: 'registration_card', label: 'Tarjeta de circulación', expiry: 'required' },
    { code: 'technical_inspection', label: 'Verificación técnica', expiry: 'required' },
    { code: 'transport_permit', label: 'Permiso de transporte', expiry: 'required' },
    { code: 'municipal_authorization', label: 'Autorización municipal', expiry: 'required' },
    { code: 'ownership_title', label: 'Título de propiedad', expiry: 'optional' },
    { code: 'other', label: 'Otro documento', expiry: 'optional' },
  ],
  employee: [
    { code: 'medical_exam', label: 'Examen médico', expiry: 'required' },
    { code: 'training_certificate', label: 'Constancia de capacitación', expiry: 'optional' },
    { code: 'driving_course', label: 'Curso de manejo', expiry: 'optional' },
    { code: 'other', label: 'Otro documento', expiry: 'optional' },
  ],
};

export const typeInfo = (
  ownerType: DocumentOwnerType,
  code: string,
): DocumentTypeInfo | undefined => DOCUMENT_TYPES[ownerType].find((type) => type.code === code);
