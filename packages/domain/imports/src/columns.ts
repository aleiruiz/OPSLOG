import type { ImportEntity } from './types.js';

export const MAX_ROWS = 500;
/** Characters of a CSV text (about 250 KiB for ASCII). */
export const MAX_CSV_LENGTH = 256_000;
export const MAX_CELL_LENGTH = 200;
export const MAX_HEADER_COLUMNS = 16;

/**
 * The template of each entity: the column names a row may carry (the names of the create request of
 * the entity). `pii` columns are personal data: they are accepted, sealed by the employee service
 * and never fingerprinted, stored or reported. `integers` are numeric in the create request.
 */
export interface ColumnSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly integers: readonly string[];
  readonly pii: readonly string[];
}
export const IMPORT_COLUMNS: Readonly<Record<ImportEntity, ColumnSpec>> = {
  vehicle: {
    required: ['economicNumber', 'plate', 'make', 'model', 'year', 'areaId', 'odometerKm'],
    optional: ['vin', 'registeredOn'],
    integers: ['year', 'odometerKm'],
    pii: [],
  },
  employee: {
    required: ['kind', 'firstName', 'lastName', 'areaId'],
    optional: [
      'employeeNumber',
      'position',
      'hireDate',
      'idType',
      'nationalId',
      'phone',
      'email',
      'licenseNumber',
      'licenseType',
      'licenseExpiresOn',
    ],
    integers: [],
    pii: ['idType', 'nationalId', 'phone', 'email', 'licenseNumber'],
  },
};
export const columnsOf = (entity: ImportEntity): readonly string[] => [
  ...IMPORT_COLUMNS[entity].required,
  ...IMPORT_COLUMNS[entity].optional,
];
