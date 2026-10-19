import { APPLIED } from '../rows.js';
import type { ReportColumn, ReportFilter, Row } from '../types.js';

/**
 * A record sheet is a table of sections, fields and values: it travels through the same writers as
 * every report. The sections that hold personal data or amounts are built only when the reader holds
 * the permission, so a sheet never carries what its reader may not see.
 */
export const SHEET_COLUMNS: readonly ReportColumn[] = [
  { id: 'order', label: 'Nº', kind: 'integer', defaultVisible: false },
  { id: 'section', label: 'Sección', kind: 'text' },
  { id: 'field', label: 'Campo', kind: 'text' },
  { id: 'value', label: 'Valor', kind: 'text' },
];

export const SHEET_SORT = { column: 'order', direction: 'asc' } as const;

export const sheetFilter = (id: string, text: string): ReportFilter => ({
  id,
  label: text,
  kind: 'text',
  required: true,
  test: APPLIED,
});

const NONE = '—';

export class SheetRows {
  private readonly rows: Row[] = [];

  /** A section of `field: value` lines; a missing value reads «—» so the field is not silently dropped. */
  public section(
    name: string,
    entries: readonly (readonly [string, string | number | null | undefined])[],
  ): this {
    for (const [field, value] of entries)
      this.rows.push({
        order: this.rows.length + 1,
        section: name,
        field,
        value: value === null || value === undefined || value === '' ? NONE : String(value),
      });
    return this;
  }

  /** A section made of one line per item, for lists (documents, policies, orders, cases). */
  public list(name: string, items: readonly string[], empty = 'Sin registros'): this {
    if (items.length === 0) return this.section(name, [['Registros', empty]]);
    items.forEach((item, index) => this.section(name, [[String(index + 1), item]]));
    return this;
  }

  public build(): readonly Row[] {
    return this.rows;
  }
}
