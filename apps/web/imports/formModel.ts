import type { ImportEntity, ImportInput, ImportMode } from '../app/types';
import { parseCsv } from './csv';
import { columnLabel } from './labels';
import {
  MAX_CSV_LENGTH,
  MAX_HEADER_COLUMNS,
  MAX_ROWS,
  columnsOf,
  isEntity,
  isMode,
  templateOf,
} from './rules';

/** What the person picks and pastes. The file is read into `csv` in the browser: nothing is uploaded as a file. */
export interface ImportFormValues {
  entity: ImportEntity;
  mode: ImportMode;
  csv: string;
}

export type FieldKey = keyof ImportFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;

export const fieldOrder: readonly FieldKey[] = ['entity', 'mode', 'csv'];

export const emptyValues: ImportFormValues = { entity: 'vehicle', mode: 'dry_run', csv: '' };

/** What a CSV text says about itself, without sending it anywhere. */
export interface CsvInspection {
  /** The CSV could be read (no quote errors). */
  readonly readable: boolean;
  readonly columns: readonly string[];
  /** Data rows (the header excluded). */
  readonly rows: number;
  readonly unknown: readonly string[];
  readonly duplicated: readonly string[];
  readonly missing: readonly string[];
  /** Columns of the file that hold personal data. */
  readonly pii: readonly string[];
  /** 1-based position (header = 1) of the first line whose cell count differs from the header, if any. */
  readonly raggedLine: number | null;
}

export function inspect(csv: string, entity: ImportEntity): CsvInspection {
  const table = parseCsv(csv);
  const template = templateOf(entity);
  if (table === null)
    return {
      readable: false,
      columns: [],
      rows: 0,
      unknown: [],
      duplicated: [],
      missing: [],
      pii: [],
      raggedLine: null,
    };
  const [header = [], ...body] = table;
  const columns = header.map((name) => name.trim());
  const allowed = columnsOf(entity);
  const ragged = body.findIndex((cells) => cells.length !== columns.length);
  return {
    readable: true,
    columns,
    rows: body.length,
    unknown: columns.filter((name) => !allowed.includes(name)),
    duplicated: columns.filter((name, index) => columns.indexOf(name) !== index),
    missing: template.required.filter((name) => !columns.includes(name)),
    pii: columns.filter((name) => template.pii.includes(name)),
    raggedLine: ragged === -1 ? null : ragged + 2,
  };
}

const names = (columns: readonly string[]): string =>
  [...new Set(columns)].map((name) => columnLabel(name) + (columnLabel(name) === name ? '' : ` (${name})`)).join(', ');

interface Context {
  /** Whether the session holds `view_pii`: only then employee files may carry personal-data columns. */
  readonly canViewPii: boolean;
}

/** The same rules the backend enforces, with a message (the server only says "invalid request"). */
export function validate(values: ImportFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  if (!isEntity(values.entity)) errors.entity = 'Elige qué quieres importar.';
  if (!isMode(values.mode)) errors.mode = 'Elige qué hacer con el archivo.';
  if (errors.entity) return errors;
  if (!values.csv.trim()) {
    errors.csv = 'Pega las filas o carga un archivo CSV.';
    return errors;
  }
  if (values.csv.length > MAX_CSV_LENGTH) {
    errors.csv = `El archivo supera los ${new Intl.NumberFormat('es-MX').format(MAX_CSV_LENGTH)} caracteres. Divídelo en varios archivos.`;
    return errors;
  }
  const found = inspect(values.csv, values.entity);
  if (!found.readable)
    errors.csv =
      'No pudimos leer el archivo: revisa las comillas. Un valor con comas va entre comillas dobles y una comilla dentro del valor se escribe doble.';
  else if (found.columns.length > MAX_HEADER_COLUMNS)
    errors.csv = `El encabezado tiene más de ${MAX_HEADER_COLUMNS} columnas.`;
  else if (found.unknown.length > 0)
    errors.csv = `Estas columnas no están en la plantilla: ${found.unknown.join(', ')}. Quítalas o corrige su nombre.`;
  else if (found.duplicated.length > 0)
    errors.csv = `El encabezado repite columnas: ${found.duplicated.join(', ')}.`;
  else if (found.missing.length > 0)
    errors.csv = `Faltan columnas obligatorias en el encabezado: ${names(found.missing)}.`;
  else if (found.rows === 0) errors.csv = 'El archivo solo tiene el encabezado: agrega al menos una fila.';
  else if (found.rows > MAX_ROWS)
    errors.csv = `El archivo tiene ${found.rows} filas y el máximo es ${MAX_ROWS} por importación. Divídelo en varios archivos.`;
  else if (found.raggedLine !== null)
    errors.csv = `La línea ${found.raggedLine} no tiene el mismo número de celdas que el encabezado.`;
  else if (found.pii.length > 0 && !context.canViewPii)
    errors.csv = `El archivo incluye columnas con datos personales (${names(found.pii)}). Tu rol no puede importarlas: quítalas del archivo.`;
  return errors;
}

/**
 * Body of an import. A validation (`dry_run`) carries no key. A commit carries the idempotency key and, when it
 * confirms a validation of the same file, the id of that validation job. Call only with values that passed `validate`.
 */
export function toInput(
  values: ImportFormValues,
  options: { readonly idempotencyKey?: string; readonly dryRunJobId?: string } = {},
): ImportInput {
  return {
    entity: values.entity,
    mode: values.mode,
    csv: values.csv,
    ...(values.mode === 'dry_run' || options.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: options.idempotencyKey }),
    ...(values.mode === 'dry_run' || options.dryRunJobId === undefined
      ? {}
      : { dryRunJobId: options.dryRunJobId }),
  };
}

/** Whether two forms ask the server for the same thing: the key of an attempt is reused only while this holds. */
export const signatureOf = (values: ImportFormValues, dryRunJobId?: string): string =>
  JSON.stringify([values.entity, values.mode, values.csv, dryRunJobId ?? null]);

/** What a validation is bound to: the entity and the exact text. Editing either makes the validation stale. */
export const fileSignatureOf = (values: Pick<ImportFormValues, 'entity' | 'csv'>): string =>
  `${values.entity}\n${values.csv}`;
