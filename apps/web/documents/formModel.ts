import type {
  ApiError,
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentRenewal,
} from '../app/types';
import {
  MAX_EXPIRY_DATE,
  MIN_DATE,
  NOTES,
  OPAQUE_ID,
  REFERENCE_NUMBER,
  TITLE,
  isDateBetween,
  normalizeReference,
  normalizeText,
  todayOf,
  typeInfo,
} from './rules';

/** What the person types, as text. */
export interface DocumentFormValues {
  /** Create only: the vehicle the document belongs to. */
  ownerId: string;
  /** Create only: a code of the vehicle catalog. */
  typeCode: string;
  title: string;
  notes: string;
  issuedOn: string;
  expiresOn: string;
  documentNumber: string;
}

export type FieldKey = keyof DocumentFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;
export type FormMode = 'create' | 'edit' | 'renew';

/** Order in which fields appear, used to move focus to the first one with an error. */
export const fieldOrder: readonly FieldKey[] = [
  'ownerId',
  'typeCode',
  'title',
  'documentNumber',
  'notes',
  'issuedOn',
  'expiresOn',
];

export const emptyValues: DocumentFormValues = {
  ownerId: '',
  typeCode: '',
  title: '',
  notes: '',
  issuedOn: '',
  expiresOn: '',
  documentNumber: '',
};

/** Values an edit opens with: only the title and the notes can change in place. */
export const editValuesOf = (document: Document): DocumentFormValues => ({
  ...emptyValues,
  title: document.title,
  notes: document.notes ?? '',
});

/** Values a renewal opens with: the number carries over, the dates are for the person to set. */
export const renewalValuesOf = (document: Document): DocumentFormValues => ({
  ...emptyValues,
  documentNumber: document.documentNumber ?? '',
});

interface Context {
  readonly mode: FormMode;
  readonly now: Date;
  /** Edit and renew: the document being changed (its type decides whether an expiry is required). */
  readonly document?: Pick<Document, 'ownerType' | 'typeCode'> | undefined;
}

function validateValidity(
  values: DocumentFormValues,
  required: boolean,
  now: Date,
  errors: FieldErrors,
): void {
  const issuedOn = values.issuedOn.trim();
  const expiresOn = values.expiresOn.trim();
  if (issuedOn && !isDateBetween(issuedOn, MIN_DATE, todayOf(now)))
    errors.issuedOn = 'Elige una fecha de emisión que no sea futura.';
  if (!expiresOn) {
    if (required)
      errors.expiresOn = 'Escribe el vencimiento: este tipo de documento siempre vence.';
  } else if (!isDateBetween(expiresOn, MIN_DATE, MAX_EXPIRY_DATE))
    errors.expiresOn = 'Elige una fecha de vencimiento entre 1950 y 2100.';
  else if (issuedOn && !errors.issuedOn && expiresOn < issuedOn)
    errors.expiresOn = 'El vencimiento no puede ser anterior a la emisión.';
  const number = normalizeReference(values.documentNumber);
  if (number && !REFERENCE_NUMBER.test(number))
    errors.documentNumber =
      'Usa hasta 40 caracteres: letras, números, espacio, punto, diagonal o guion.';
}

function validateTitleAndNotes(values: DocumentFormValues, errors: FieldErrors): void {
  const title = normalizeText(values.title);
  if (!title) errors.title = 'Escribe el título del documento.';
  else if (!TITLE.test(title)) errors.title = 'Usa hasta 80 caracteres, sin saltos de línea.';
  const notes = values.notes.trim();
  if (notes && !NOTES.test(notes)) errors.notes = 'Usa hasta 500 caracteres, sin saltos de línea.';
}

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validate(values: DocumentFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  if (context.mode === 'create') {
    if (!values.ownerId.trim()) errors.ownerId = 'Elige el vehículo del documento.';
    else if (!OPAQUE_ID.test(values.ownerId.trim()))
      errors.ownerId = 'El vehículo elegido no es válido. Elige otro de la lista.';
    if (!values.typeCode) errors.typeCode = 'Elige el tipo de documento.';
    else if (!typeInfo('vehicle', values.typeCode))
      errors.typeCode = 'El tipo elegido no existe. Elige uno de la lista.';
  }
  if (context.mode !== 'renew') validateTitleAndNotes(values, errors);
  if (context.mode !== 'edit') {
    const kind =
      context.mode === 'create'
        ? typeInfo('vehicle', values.typeCode)
        : context.document && typeInfo(context.document.ownerType, context.document.typeCode);
    validateValidity(values, kind?.expiry === 'required', context.now, errors);
  }
  return errors;
}

const optional = <K extends string, V>(key: K, value: V | '') =>
  value === '' ? {} : ({ [key]: value } as Record<K, V>);

/** Body of a creation. Call only with values that passed `validate`. */
export function toInput(values: DocumentFormValues): DocumentInput {
  return {
    ownerType: 'vehicle',
    ownerId: values.ownerId.trim(),
    typeCode: values.typeCode,
    title: normalizeText(values.title),
    ...optional('notes', values.notes.trim()),
    ...optional('issuedOn', values.issuedOn.trim()),
    ...optional('expiresOn', values.expiresOn.trim()),
    ...optional('documentNumber', normalizeReference(values.documentNumber)),
  };
}

/** Body of a renewal (without the version). The renewal replaces the three validity fields as a set. */
export function toRenewal(values: DocumentFormValues): Omit<DocumentRenewal, 'version'> {
  return {
    ...optional('issuedOn', values.issuedOn.trim()),
    ...optional('expiresOn', values.expiresOn.trim()),
    ...optional('documentNumber', normalizeReference(values.documentNumber)),
  };
}

/** What changed against the loaded document: an in-place patch (without version), or `null` when nothing did. */
export function changes(
  document: Document,
  values: DocumentFormValues,
): Omit<DocumentPatch, 'version'> | null {
  const patch: { -readonly [K in keyof Omit<DocumentPatch, 'version'>]?: DocumentPatch[K] } = {};
  const title = normalizeText(values.title);
  const notes = values.notes.trim() || null;
  if (title !== document.title) patch.title = title;
  if (notes !== document.notes) patch.notes = notes;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The field message of a 422 `invalid_owner`: the same one whether the vehicle is unknown, foreign or archived. */
export function ownerErrors(error: ApiError): FieldErrors {
  return error.fieldErrors?.some((item) => item.field === 'owner_id')
    ? { ownerId: 'El vehículo no existe o está archivado. Elige otro de la lista.' }
    : {};
}
