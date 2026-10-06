import type { Area, AreaInput, AreaPatch } from '../app/types';
import { CODE, MAX_RESPONSIBLES, NAME, OPAQUE_ID, normalizeCode, normalizeName } from './rules';
import type { ParentChoice } from './tree';

/**
 * `create` edits every field; `edit` changes name, code and responsibles; `move` changes only the parent (the
 * whole subtree moves with the area).
 */
export type FormMode = 'create' | 'edit' | 'move';

export interface AreaFormValues {
  name: string;
  code: string;
  /** `''` is the root level (no parent). */
  parentId: string;
  responsibleIds: readonly string[];
}

export type FieldKey = 'name' | 'code' | 'parentId' | 'responsibles';
export type FieldErrors = Partial<Record<FieldKey, string | undefined>>;

/** Order in which fields appear, used to move focus to the first one with an error. */
export const fieldOrder: readonly FieldKey[] = ['name', 'code', 'parentId', 'responsibles'];

export const emptyValues = (parentId = ''): AreaFormValues => ({
  name: '',
  code: '',
  parentId,
  responsibleIds: [],
});

export const valuesOf = (area: Area): AreaFormValues => ({
  name: area.name,
  code: area.code ?? '',
  parentId: area.parentId ?? '',
  responsibleIds: area.responsibleIds,
});

interface Context {
  readonly mode: FormMode;
  readonly choices: readonly ParentChoice[];
}

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validate(values: AreaFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  if (context.mode !== 'move') {
    const name = normalizeName(values.name);
    if (!name) errors.name = 'Escribe el nombre del área.';
    else if (!NAME.test(name)) errors.name = 'Usa hasta 80 caracteres, sin saltos de línea.';

    const code = normalizeCode(values.code);
    if (code && !CODE.test(code))
      errors.code =
        'Usa hasta 32 caracteres: letras, números, punto, guion o guion bajo, empezando con letra o número.';

    if (values.responsibleIds.length > MAX_RESPONSIBLES)
      errors.responsibles = `Una área admite hasta ${MAX_RESPONSIBLES} responsables.`;
  }
  if (context.mode !== 'edit' && values.parentId !== '') {
    const choice = context.choices.find((item) => item.id === values.parentId);
    if (!choice) errors.parentId = 'Elige un área superior de la lista.';
    else if (choice.unavailable)
      errors.parentId = `Esa área no está disponible: ${choice.unavailable}. Elige otra.`;
  }
  return errors;
}

/** Why a typed identifier cannot be added to the responsibles, or `null` when it can. */
export function responsibleProblem(text: string, current: readonly string[]): string | null {
  const id = text.trim();
  if (!id) return 'Escribe el identificador de la persona.';
  if (!OPAQUE_ID.test(id)) return 'Usa letras, números, guion o guion bajo, hasta 64 caracteres.';
  if (current.includes(id)) return 'Esa persona ya es responsable.';
  if (current.length >= MAX_RESPONSIBLES)
    return `Una área admite hasta ${MAX_RESPONSIBLES} responsables.`;
  return null;
}

/** Body of a creation. Call only with values that passed `validate`. */
export function toInput(values: AreaFormValues): AreaInput {
  const code = normalizeCode(values.code);
  return {
    name: normalizeName(values.name),
    ...(code ? { code } : {}),
    ...(values.parentId ? { parentId: values.parentId } : {}),
    responsibleIds: [...values.responsibleIds],
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** What changed against the loaded area, as an in-place patch (without version), or `null` when nothing did. */
export function changes(
  area: Area,
  values: AreaFormValues,
  mode: 'edit' | 'move',
): Omit<AreaPatch, 'version'> | null {
  const patch: { -readonly [K in keyof Omit<AreaPatch, 'version'>]?: AreaPatch[K] } = {};
  if (mode === 'edit') {
    const name = normalizeName(values.name);
    if (name !== area.name) patch.name = name;
    const code = normalizeCode(values.code) || null;
    if (code !== area.code) patch.code = code;
    if (!sameSet(values.responsibleIds, area.responsibleIds))
      patch.responsibleIds = [...values.responsibleIds];
  } else if ((values.parentId || null) !== area.parentId) patch.parentId = values.parentId || null;
  return Object.keys(patch).length > 0 ? patch : null;
}
