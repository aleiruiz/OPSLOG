import { SavedViewError } from './errors.js';
import type { ViewModuleCatalog } from './ports.js';
import { MAX_VIEW_NAME_LENGTH, type ViewContent, type ViewDrop, type ViewSort } from './types.js';

const invalid = (): never => {
  throw new SavedViewError('invalid_input');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A readable name: 1-80 characters once trimmed and collapsed, no control characters. */
export function parseName(value: unknown): { readonly name: string; readonly key: string } {
  if (typeof value !== 'string') return invalid();
  const name = value.replace(/\s+/g, ' ').trim();
  const control = /[\u0000-\u001f\u007f]/.test(name);
  if (name.length === 0 || name.length > MAX_VIEW_NAME_LENGTH || control) return invalid();
  return { name, key: name.toLocaleLowerCase('es') };
}

export function parseShared(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}

export function parseVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return invalid();
  return value;
}

/** Strict filters of a writer: an unknown key or a value the filter rejects is a 400; a forbidden one a 403. */
export function parseFilters(
  catalog: ViewModuleCatalog,
  permissions: ReadonlySet<string>,
  value: unknown,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) return invalid();
  const filters: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const rule = catalog.filters.get(key);
    if (!rule || typeof raw !== 'string' || !rule.accepts(raw)) return invalid();
    if (rule.permission && !permissions.has(rule.permission)) throw new SavedViewError('forbidden');
    filters[key] = raw;
  }
  return filters;
}

/** `null` clears the order; an order the module cannot apply is a 400. */
export function parseSort(catalog: ViewModuleCatalog, value: unknown): ViewSort | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).length !== 2) return invalid();
  const { field, direction } = value;
  if (
    typeof field !== 'string' ||
    !catalog.sorts.has(field) ||
    (direction !== 'asc' && direction !== 'desc')
  )
    return invalid();
  return { field, direction };
}

/** `null` (or absent) means the module's default columns. */
export function parseColumns(
  catalog: ViewModuleCatalog,
  permissions: ReadonlySet<string>,
  value: unknown,
): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > catalog.columns.size)
    return invalid();
  const seen = new Set<string>();
  for (const key of value) {
    const rule = typeof key === 'string' ? catalog.columns.get(key) : undefined;
    if (!rule || seen.has(key as string)) return invalid();
    if (rule.permission && !permissions.has(rule.permission)) throw new SavedViewError('forbidden');
    seen.add(key as string);
  }
  return [...seen];
}

/**
 * Revalidates a stored view for one reader (a view of someone else may have been saved with
 * permissions the reader lacks, or before the allowlist changed). What cannot be used is left out and
 * reported; nothing is executed on trust.
 */
export function sanitize(
  catalog: ViewModuleCatalog,
  permissions: ReadonlySet<string>,
  stored: ViewContent,
): { readonly content: ViewContent; readonly dropped: readonly ViewDrop[] } {
  const dropped: ViewDrop[] = [];
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored.filters)) {
    const rule = catalog.filters.get(key);
    if (!rule) dropped.push({ kind: 'filter', key, label: key, reason: 'invalid' });
    else if (rule.permission && !permissions.has(rule.permission))
      dropped.push({ kind: 'filter', key, label: rule.label, reason: 'permission' });
    else if (!rule.accepts(value))
      dropped.push({ kind: 'filter', key, label: rule.label, reason: 'invalid' });
    else filters[key] = value;
  }
  let sort = stored.sort;
  if (sort && !catalog.sorts.has(sort.field)) {
    dropped.push({ kind: 'sort', key: sort.field, label: 'Orden', reason: 'invalid' });
    sort = null;
  }
  const columns = sanitizeColumns(catalog, permissions, stored.columns, dropped);
  return { content: { filters, sort, columns }, dropped };
}

export function sanitizeColumns(
  catalog: ViewModuleCatalog,
  permissions: ReadonlySet<string>,
  stored: readonly string[] | null,
  dropped: ViewDrop[],
): readonly string[] | null {
  if (stored === null) return null;
  const kept: string[] = [];
  for (const key of stored) {
    const rule = catalog.columns.get(key);
    if (!rule) dropped.push({ kind: 'column', key, label: key, reason: 'invalid' });
    else if (rule.permission && !permissions.has(rule.permission))
      dropped.push({ kind: 'column', key, label: rule.label, reason: 'permission' });
    else kept.push(key);
  }
  return kept.length === 0 ? null : kept;
}
