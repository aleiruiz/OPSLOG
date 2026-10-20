/** Failure with a fixed code. Messages never carry a value, a key, a path of user input or a driver text. */
export type ExportErrorCode =
  | 'bad_arguments'
  | 'missing_setting'
  | 'unclassified_table'
  | 'tenant_unresolved'
  | 'source_unavailable'
  | 'pii_open_failed'
  | 'output_exists'
  | 'archive_corrupt'
  | 'archive_key_rejected'
  | 'manifest_mismatch';

export class ExportError extends Error {
  public constructor(public readonly code: ExportErrorCode) {
    super(`tenant export failed: ${code}`);
    this.name = 'ExportError';
  }
}

export type Cell = string | number | boolean | null | Record<string, unknown> | unknown[];
export type Row = Record<string, Cell>;

export interface TableMeta {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
}

export interface ServerInfo {
  readonly version: string;
  readonly serverUuid: string;
  /** When the consistent snapshot was taken (ISO instant, from the database clock). */
  readonly snapshotAt: string;
}

/** The read side of the export: a consistent, read-only view of one company database. */
export interface ExportSource {
  info(): Promise<ServerInfo>;
  /** Every base table of the database. */
  tables(): Promise<readonly TableMeta[]>;
  /** The company record: id and name, or undefined when the database has no (or several) companies. */
  singleCompany(): Promise<{ readonly id: string; readonly name: string } | undefined>;
  count(
    table: TableMeta,
    scope: import('./catalog.js').RowScope,
    tenantId: string,
  ): Promise<number>;
  /** Rows in primary-key order. Date columns arrive as text, 64-bit integers as text. */
  rows(
    table: TableMeta,
    scope: import('./catalog.js').RowScope,
    tenantId: string,
  ): AsyncIterable<Row>;
  close(): Promise<void>;
}

/** A released file of the company, as `opslog_files` describes it. */
export interface FileRecord {
  readonly id: string;
  readonly kind: 'original' | 'derivative';
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Read access to the stored bytes of a file; `undefined` when the store has no such object. */
export interface ObjectReader {
  readonly label: 'memory' | 's3' | 'not_configured';
  read(tenantId: string, file: FileRecord): Promise<Uint8Array | undefined>;
}

/** What the archive records about one entry (a file inside the archive). */
export interface EntryDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
