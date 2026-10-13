import { BFF_COST_MAX_LINES } from '@opslog/contracts';
import type {
  BffCostCategory,
  BffCostKind,
  BffCostLine,
  BffCostLineInput,
  BffIncidentCostsInput,
  BffMoney,
} from '@opslog/contracts';
import { amountText, parseAmount } from './money';

/** A cost line as the person edits it: the amount is typed in major units, the way it reads on paper. */
export interface LineDraft {
  /** Stable key in the list: the server's id for a saved line, `new-N` for one not saved yet. */
  readonly key: string;
  /** The server's id when the line already exists; `null` for a new one. */
  readonly id: string | null;
  readonly kind: BffCostKind;
  readonly category: BffCostCategory;
  readonly amount: string;
  readonly currency: string;
  readonly note: string;
}
/** The estimate as typed; `null` clears it, `undefined` leaves it as the server has it. */
export interface EstimateDraft {
  readonly amount: string;
  readonly currency: string;
}

/**
 * What the person changed and has not sent. It is kept as operations over the server's lines, not as a copy of
 * the list, so after a conflict the fresh lines of the other person stay and only these changes are applied on top.
 */
export interface CostEdits {
  readonly added: readonly LineDraft[];
  readonly changed: Readonly<Record<string, LineDraft>>;
  readonly removed: readonly string[];
  readonly estimate: EstimateDraft | null | undefined;
}
export const NO_EDITS: CostEdits = { added: [], changed: {}, removed: [], estimate: undefined };

let counter = 0;
/** A key for a line that does not exist on the server yet. */
export const nextKey = (): string => `new-${(counter += 1)}`;

export const isDirty = (edits: CostEdits): boolean =>
  edits.added.length > 0 ||
  Object.keys(edits.changed).length > 0 ||
  edits.removed.length > 0 ||
  edits.estimate !== undefined;

export const lineDraft = (line: BffCostLine): LineDraft => ({
  key: line.id,
  id: line.id,
  kind: line.kind,
  category: line.category,
  amount: amountText(line.amount.amountMinor, line.amount.currency),
  currency: line.amount.currency,
  note: line.note ?? '',
});

/** The lines the person sees: the server's lines minus the removed, with the changed ones replaced, plus the new. */
export function workingLines(
  server: readonly BffCostLine[],
  edits: CostEdits,
): readonly LineDraft[] {
  return [
    ...server
      .filter((line) => !edits.removed.includes(line.id))
      .map((line) => edits.changed[line.id] ?? lineDraft(line)),
    ...edits.added,
  ];
}

/** Why a line cannot be saved, in Spanish; `null` when it can. */
export function lineProblem(line: LineDraft): string | null {
  if (!/^[A-Z]{3}$/.test(line.currency))
    return 'Usa un código de moneda de tres letras, por ejemplo MXN.';
  if (parseAmount(line.amount, line.currency) === null)
    return 'Escribe un monto mayor a cero, con los decimales que admite la moneda.';
  if (line.note.length > 200) return 'La nota admite hasta 200 caracteres.';
  return null;
}

export function estimateProblem(estimate: EstimateDraft): string | null {
  if (!/^[A-Z]{3}$/.test(estimate.currency))
    return 'Usa un código de moneda de tres letras, por ejemplo MXN.';
  if (parseAmount(estimate.amount, estimate.currency) === null)
    return 'Escribe una estimación mayor a cero, con los decimales que admite la moneda.';
  return null;
}

export const atLineLimit = (lines: readonly LineDraft[]): boolean =>
  lines.length >= BFF_COST_MAX_LINES;

const money = (amount: string, currency: string): BffMoney => ({
  amountMinor: parseAmount(amount, currency) as string,
  currency,
});

/** The replacement the server expects, with the version it was read at. Call it only when every line is valid. */
export function costsInput(
  version: number,
  server: readonly BffCostLine[],
  edits: CostEdits,
): BffIncidentCostsInput {
  const lines: BffCostLineInput[] = workingLines(server, edits).map((line) => ({
    ...(line.id === null ? {} : { id: line.id }),
    kind: line.kind,
    category: line.category,
    amount: money(line.amount, line.currency),
    note: line.note.trim() === '' ? null : line.note.trim(),
  }));
  return {
    version,
    lines,
    ...(edits.estimate === undefined
      ? {}
      : {
          initialEstimate:
            edits.estimate === null ? null : money(edits.estimate.amount, edits.estimate.currency),
        }),
  };
}

/** A change to a line the server no longer has is dropped when the lines refresh. */
export function reconcile(edits: CostEdits, server: readonly BffCostLine[]): CostEdits {
  const known = new Set(server.map((line) => line.id));
  return {
    ...edits,
    changed: Object.fromEntries(Object.entries(edits.changed).filter(([id]) => known.has(id))),
    removed: edits.removed.filter((id) => known.has(id)),
  };
}
