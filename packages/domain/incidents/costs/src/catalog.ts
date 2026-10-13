/** Kinds of line of a case (INC-COSTS): what the company spent, and what somebody else paid back. */
export const COST_KINDS = ['expense', 'recovery'] as const;
export type CostKind = (typeof COST_KINDS)[number];

/** `repair` is a repair without a linked order (ADR-0014). There is no driver as payer (D15). */
export const EXPENSE_CATEGORIES = [
  'repair',
  'deductible',
  'towing',
  'fine',
  'third_party_damage',
  'legal',
  'other',
] as const;
export const RECOVERY_CATEGORIES = ['insurer', 'third_party', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type RecoveryCategory = (typeof RECOVERY_CATEGORIES)[number];
export type CostCategory = ExpenseCategory | RecoveryCategory;

export const CATEGORIES_OF: Readonly<Record<CostKind, readonly CostCategory[]>> = {
  expense: EXPENSE_CATEGORIES,
  recovery: RECOVERY_CATEGORIES,
};

export const COST_LIMITS = { lines: 50, note: 200 } as const;
