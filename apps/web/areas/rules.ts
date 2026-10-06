/**
 * Field rules of an area, mirrored from the domain (`packages/domain/areas`). The server stays the authority
 * and answers a uniform 400 without saying which field failed, so the forms check the same rules first and
 * explain the problem next to the field.
 */
export const MAX_AREA_DEPTH = 4;
export const MAX_RESPONSIBLES = 20;
export const MAX_NAME_LENGTH = 80;
export const MAX_CODE_LENGTH = 32;

export const NAME = /^[^\u0000-\u001f\u007f]{1,80}$/u;
export const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
export const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Display form of a name: trimmed, inner whitespace collapsed (the server stores the same form). */
export const normalizeName = (value: string): string => value.trim().replace(/\s+/g, ' ');
/** Codes are stored upper case. */
export const normalizeCode = (value: string): string => value.trim().toUpperCase();
