import {
  BFF_IMPORT_ENTITIES,
  BFF_IMPORT_MAX_ROWS,
  BFF_IMPORT_MODES,
  BFF_IMPORT_TEMPLATES,
} from '@opslog/contracts';
import type { ImportEntity, ImportMode } from '../app/types';

/**
 * Limits and templates of a bulk import, mirrored from the domain (`packages/domain/imports`) and the contract. The
 * server stays the authority and answers a uniform 400 for a malformed file, so the form checks the same rules first.
 */
export const IMPORT_ENTITIES: readonly ImportEntity[] = BFF_IMPORT_ENTITIES;
export const IMPORT_MODES: readonly ImportMode[] = BFF_IMPORT_MODES;
export const MAX_ROWS = BFF_IMPORT_MAX_ROWS;
/** Characters of a CSV text (about 250 KiB for ASCII). */
export const MAX_CSV_LENGTH = 256_000;
export const MAX_CELL_LENGTH = 200;
export const MAX_HEADER_COLUMNS = 16;
/** 8 to 64 characters, starting with a letter or digit. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export interface ColumnTemplate {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** Columns that hold personal data: they need `view_pii` to be imported. */
  readonly pii: readonly string[];
}

const PII_COLUMNS: Readonly<Record<ImportEntity, readonly string[]>> = {
  vehicle: [],
  employee: ['idType', 'nationalId', 'phone', 'email', 'licenseNumber'],
};

export const templateOf = (entity: ImportEntity): ColumnTemplate => ({
  required: BFF_IMPORT_TEMPLATES[entity].required,
  optional: BFF_IMPORT_TEMPLATES[entity].optional,
  pii: PII_COLUMNS[entity],
});

export const columnsOf = (entity: ImportEntity): readonly string[] => [
  ...templateOf(entity).required,
  ...templateOf(entity).optional,
];

export const isEntity = (value: unknown): value is ImportEntity =>
  typeof value === 'string' && (IMPORT_ENTITIES as readonly string[]).includes(value);
export const isMode = (value: unknown): value is ImportMode =>
  typeof value === 'string' && (IMPORT_MODES as readonly string[]).includes(value);
