import {
  Issues,
  idField,
  isPlainObject,
  objectOf,
  present,
  textField,
  versionField,
} from '../../cases/src/validation.js';
import {
  CATEGORIES_OF,
  COST_KINDS,
  COST_LIMITS,
  type CostCategory,
  type CostKind,
} from './catalog.js';
import type { Money } from './ports.js';

const AMOUNT = /^[1-9]\d{0,14}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A line as the caller sent it; `id` is kept only when it names an existing line. */
export interface LineInput {
  readonly id: string | null;
  readonly kind: CostKind;
  readonly category: CostCategory;
  readonly amount: Money;
  readonly note: string | null;
}
export interface CostsUpdate {
  readonly version: number;
  readonly lines: readonly LineInput[];
  /** `undefined`: leave as it is; `null`: clear it. */
  readonly initialEstimate: Money | null | undefined;
}

function money(issues: Issues, field: string, value: unknown): Money | undefined {
  if (!isPlainObject(value)) return issues.add(field, 'invalid');
  const { amountMinor, currency } = value;
  if (
    Object.keys(value).length !== 2 ||
    typeof amountMinor !== 'string' ||
    !AMOUNT.test(amountMinor) ||
    typeof currency !== 'string' ||
    !CURRENCY.test(currency)
  )
    return issues.add(field, 'invalid');
  return { amountMinor, currency };
}

function line(
  issues: Issues,
  value: unknown,
  index: number,
  known: ReadonlySet<string> | null,
): LineInput | undefined {
  const field = `lines[${index}]`;
  if (!isPlainObject(value)) return issues.add(field, 'invalid');
  const data = value;
  if (Object.keys(value).some((key) => !['id', 'kind', 'category', 'amount', 'note'].includes(key)))
    issues.add(field, 'unknown_property');
  const kind = COST_KINDS.find((candidate) => candidate === data['kind']);
  if (!kind) issues.add(`${field}.kind`, 'invalid');
  const category = kind
    ? CATEGORIES_OF[kind].find((candidate) => candidate === data['category'])
    : undefined;
  if (kind && !category) issues.add(`${field}.category`, 'invalid');
  const amount = money(issues, `${field}.amount`, data['amount']);
  const note = present(data, 'note')
    ? textField(issues, `${field}.note`, data['note'], COST_LIMITS.note)
    : null;
  let id: string | null = null;
  if (present(data, 'id')) {
    const wanted = idField(issues, `${field}.id`, data['id']);
    if (typeof wanted === 'string' && known !== null && !known.has(wanted))
      issues.add(`${field}.id`, 'invalid');
    else if (typeof wanted === 'string') id = wanted;
  }
  if (!kind || !category || !amount || note === undefined) return undefined;
  return { id, kind, category, amount, note };
}

/** `PUT costs`: replaces the lines (at most 50) and optionally sets or clears the initial estimate. */
/** `known === null` checks the shape only: enough to fingerprint a retry before the lines it refers to are compared. */
export function parseCostsUpdate(input: unknown, known: ReadonlySet<string> | null): CostsUpdate {
  const issues = new Issues();
  const data = objectOf(input, ['version', 'lines', 'initialEstimate'], issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  if (!present(data, 'lines')) issues.add('lines', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const raw = data['lines'];
  const lines: LineInput[] = [];
  if (present(data, 'lines')) {
    if (!Array.isArray(raw) || raw.length > COST_LIMITS.lines) issues.add('lines', 'invalid');
    else
      raw.forEach((value, index) => {
        const parsed = line(issues, value, index, known);
        if (parsed) lines.push(parsed);
      });
    const ids = lines.flatMap((entry) => (entry.id ? [entry.id] : []));
    if (new Set(ids).size !== ids.length) issues.add('lines', 'conflict');
  }
  const initialEstimate = !present(data, 'initialEstimate')
    ? undefined
    : data['initialEstimate'] === null
      ? null
      : money(issues, 'initialEstimate', data['initialEstimate']);
  issues.throwIfAny();
  return { version: version as number, lines, initialEstimate };
}
