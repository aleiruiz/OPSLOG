import type {
  ApiError,
  CoverageType,
  Deductible,
  InsurancePolicy,
  InsurancePolicyInput,
  InsurancePolicyPatch,
  InsurancePolicyRenewal,
} from '../app/types';
import {
  MAX_EXPIRY_DATE,
  MIN_DATE,
  NOTES,
  OPAQUE_ID,
  REFERENCE_NUMBER,
  isDateBetween,
  normalizeReference,
  normalizeText,
} from '../documents/rules';
import {
  COVERAGE_TYPES,
  CURRENCY,
  DEFAULT_CURRENCY,
  INSURER,
  currencyExponent,
  draftOf,
  parseAmountToMinor,
  parsePercentToBasisPoints,
} from './rules';

/** What the person types, as text. The deductible is flattened so each part has its own field and message. */
export interface PolicyFormValues {
  /** Create only. */
  vehicleId: string;
  insurer: string;
  coverageNotes: string;
  policyNumber: string;
  coverageType: string;
  startsOn: string;
  endsOn: string;
  deductibleKind: 'none' | 'amount' | 'percent';
  deductibleAmount: string;
  deductibleCurrency: string;
  deductiblePercent: string;
}

export type FieldKey = keyof PolicyFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;
export type FormMode = 'create' | 'edit' | 'renew';

/** Order in which fields appear, used to move focus to the first one with an error. */
export const fieldOrder: readonly FieldKey[] = [
  'vehicleId',
  'insurer',
  'policyNumber',
  'coverageType',
  'coverageNotes',
  'startsOn',
  'endsOn',
  'deductibleKind',
  'deductibleAmount',
  'deductibleCurrency',
  'deductiblePercent',
];

export const emptyValues: PolicyFormValues = {
  vehicleId: '',
  insurer: '',
  coverageNotes: '',
  policyNumber: '',
  coverageType: '',
  startsOn: '',
  endsOn: '',
  deductibleKind: 'none',
  deductibleAmount: '',
  deductibleCurrency: DEFAULT_CURRENCY,
  deductiblePercent: '',
};

const flat = (
  deductible: Deductible | null,
): Pick<
  PolicyFormValues,
  'deductibleKind' | 'deductibleAmount' | 'deductibleCurrency' | 'deductiblePercent'
> => {
  const draft = draftOf(deductible);
  return {
    deductibleKind: draft.kind,
    deductibleAmount: draft.amount,
    deductibleCurrency: draft.currency,
    deductiblePercent: draft.percent,
  };
};

/** Values an edit opens with: only the insurer and the notes can change in place. */
export const editValuesOf = (policy: InsurancePolicy): PolicyFormValues => ({
  ...emptyValues,
  insurer: policy.insurer,
  coverageNotes: policy.coverageNotes ?? '',
});

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Values a renewal opens with: the number, the coverage and the deductible carry over, and the new period is
 * proposed as the year that follows the current one (the person can change it).
 */
export function renewalValuesOf(policy: InsurancePolicy): PolicyFormValues {
  const startsOn = addDays(policy.endsOn, 1);
  const next = new Date(`${startsOn}T00:00:00.000Z`);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return {
    ...emptyValues,
    policyNumber: policy.policyNumber,
    coverageType: policy.coverageType,
    startsOn,
    endsOn: addDays(next.toISOString().slice(0, 10), -1),
    ...flat(policy.deductible),
  };
}

interface Context {
  readonly mode: FormMode;
  /** Whether the session may read and write the deductible (`view_costs`). */
  readonly canViewCosts: boolean;
}

function validateDeductible(values: PolicyFormValues, errors: FieldErrors): void {
  if (values.deductibleKind === 'amount') {
    const currency = values.deductibleCurrency.trim().toUpperCase();
    if (!CURRENCY.test(currency) || currencyExponent(currency) === null)
      errors.deductibleCurrency = 'Escribe un código de moneda de 3 letras, por ejemplo MXN.';
    else if (!values.deductibleAmount.trim())
      errors.deductibleAmount = 'Escribe el monto del deducible.';
    else if (parseAmountToMinor(values.deductibleAmount, currency) === null)
      errors.deductibleAmount =
        currencyExponent(currency) === 0
          ? 'Escribe un monto entero mayor a cero, sin decimales.'
          : `Escribe un monto mayor a cero, con hasta ${currencyExponent(currency)} decimales (por ejemplo 12500.50).`;
  } else if (
    values.deductibleKind === 'percent' &&
    parsePercentToBasisPoints(values.deductiblePercent) === null
  )
    errors.deductiblePercent =
      'Escribe un porcentaje entre 0.01 y 100, con hasta 2 decimales (por ejemplo 15).';
}

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validate(values: PolicyFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  const { mode } = context;
  if (mode === 'create') {
    if (!values.vehicleId.trim()) errors.vehicleId = 'Elige el vehículo de la póliza.';
    else if (!OPAQUE_ID.test(values.vehicleId.trim()))
      errors.vehicleId = 'El vehículo elegido no es válido. Elige otro de la lista.';
  }
  if (mode !== 'renew') {
    const insurer = normalizeText(values.insurer);
    if (!insurer) errors.insurer = 'Escribe el nombre de la aseguradora.';
    else if (!INSURER.test(insurer))
      errors.insurer = 'Usa de 2 a 80 caracteres, sin saltos de línea.';
    const notes = values.coverageNotes.trim();
    if (notes && !NOTES.test(notes))
      errors.coverageNotes = 'Usa hasta 500 caracteres, sin saltos de línea.';
  }
  if (mode !== 'edit') {
    const number = normalizeReference(values.policyNumber);
    if (!number) errors.policyNumber = 'Escribe el número de póliza.';
    else if (!REFERENCE_NUMBER.test(number))
      errors.policyNumber =
        'Usa hasta 40 caracteres: letras, números, espacio, punto, diagonal o guion.';
    if (!values.coverageType) errors.coverageType = 'Elige el tipo de cobertura.';
    else if (!(COVERAGE_TYPES as readonly string[]).includes(values.coverageType))
      errors.coverageType = 'La cobertura elegida no existe. Elige una de la lista.';
    const startsOn = values.startsOn.trim();
    const endsOn = values.endsOn.trim();
    if (!startsOn) errors.startsOn = 'Elige el primer día de cobertura.';
    else if (!isDateBetween(startsOn, MIN_DATE, MAX_EXPIRY_DATE))
      errors.startsOn = 'Elige una fecha de inicio entre 1950 y 2100.';
    if (!endsOn) errors.endsOn = 'Elige el último día de cobertura.';
    else if (!isDateBetween(endsOn, MIN_DATE, MAX_EXPIRY_DATE))
      errors.endsOn = 'Elige una fecha de fin entre 1950 y 2100.';
    else if (startsOn && !errors.startsOn && endsOn < startsOn)
      errors.endsOn = 'El fin de la vigencia no puede ser anterior al inicio.';
    if (context.canViewCosts) validateDeductible(values, errors);
  }
  return errors;
}

/** The deductible of the form values, as the contract wants it. Call only with values that passed `validate`. */
function deductibleOf(values: PolicyFormValues): Deductible | null {
  if (values.deductibleKind === 'percent')
    return {
      kind: 'percent',
      basisPoints: parsePercentToBasisPoints(values.deductiblePercent) as number,
    };
  if (values.deductibleKind === 'amount') {
    const currency = values.deductibleCurrency.trim().toUpperCase();
    return {
      kind: 'amount',
      amountMinor: parseAmountToMinor(values.deductibleAmount, currency) as number,
      currency,
    };
  }
  return null;
}

/**
 * Body of a creation. The `deductible` key is sent only when there is one and the session may write it: any
 * request that mentions it, even with `null`, needs `view_costs`.
 */
export function toInput(values: PolicyFormValues, canViewCosts: boolean): InsurancePolicyInput {
  const deductible = canViewCosts ? deductibleOf(values) : null;
  const notes = values.coverageNotes.trim();
  return {
    vehicleId: values.vehicleId.trim(),
    insurer: normalizeText(values.insurer),
    ...(notes ? { coverageNotes: notes } : {}),
    policyNumber: normalizeReference(values.policyNumber),
    coverageType: values.coverageType as CoverageType,
    startsOn: values.startsOn.trim(),
    endsOn: values.endsOn.trim(),
    ...(deductible ? { deductible } : {}),
  };
}

/**
 * Body of a renewal (without the version). With `view_costs` the deductible is always sent (`null` removes it);
 * without it the key is omitted so the current deductible carries over untouched.
 */
export function toRenewal(
  values: PolicyFormValues,
  canViewCosts: boolean,
): Omit<InsurancePolicyRenewal, 'version'> {
  return {
    policyNumber: normalizeReference(values.policyNumber),
    coverageType: values.coverageType as CoverageType,
    startsOn: values.startsOn.trim(),
    endsOn: values.endsOn.trim(),
    ...(canViewCosts ? { deductible: deductibleOf(values) } : {}),
  };
}

/** What changed against the loaded policy: an in-place patch (without version), or `null` when nothing did. */
export function changes(
  policy: InsurancePolicy,
  values: PolicyFormValues,
): Omit<InsurancePolicyPatch, 'version'> | null {
  const patch: {
    -readonly [K in keyof Omit<InsurancePolicyPatch, 'version'>]?: InsurancePolicyPatch[K];
  } = {};
  const insurer = normalizeText(values.insurer);
  const notes = values.coverageNotes.trim() || null;
  if (insurer !== policy.insurer) patch.insurer = insurer;
  if (notes !== policy.coverageNotes) patch.coverageNotes = notes;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The field message of a 422 `invalid_vehicle`: the same one whether the vehicle is unknown, foreign or archived. */
export function vehicleErrors(error: ApiError): FieldErrors {
  return error.fieldErrors?.some((item) => item.field === 'vehicle_id')
    ? { vehicleId: 'El vehículo no existe o está archivado. Elige otro de la lista.' }
    : {};
}
