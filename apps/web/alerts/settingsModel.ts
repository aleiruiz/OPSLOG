import type { AlertRecipientRole, AlertSettings, AlertSettingsInput } from '../app/types';
import { recipientOrder } from './labels';

/** Window limits of the backend (`packages/domain/settings`): a whole number of days, 1 to 30. */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 30;
export const MAX_RECIPIENTS = recipientOrder.length;

export interface SettingsFormValues {
  readonly expiryWindowDays: string;
  readonly recipientRoles: readonly AlertRecipientRole[];
}

export type SettingsFieldKey = 'expiryWindowDays' | 'recipientRoles';
export type SettingsFieldErrors = Partial<Record<SettingsFieldKey, string | undefined>>;
export const settingsFieldOrder: readonly SettingsFieldKey[] = [
  'expiryWindowDays',
  'recipientRoles',
];

export const valuesOf = (settings: AlertSettings): SettingsFormValues => ({
  expiryWindowDays: String(settings.expiryWindowDays),
  recipientRoles: settings.recipientRoles,
});

const WHOLE_NUMBER = /^\d{1,3}$/;

/** The same rules as the backend, so the person sees what is wrong before sending (the server answers a bare 400). */
export function validate(values: SettingsFormValues): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {};
  const days = values.expiryWindowDays.trim();
  if (days === '') errors.expiryWindowDays = 'Escribe los días de anticipación.';
  else if (
    !WHOLE_NUMBER.test(days) ||
    Number(days) < MIN_WINDOW_DAYS ||
    Number(days) > MAX_WINDOW_DAYS
  )
    errors.expiryWindowDays = `Escribe un número entero entre ${MIN_WINDOW_DAYS} y ${MAX_WINDOW_DAYS}.`;
  if (values.recipientRoles.length === 0)
    errors.recipientRoles = 'Elige al menos un rol que reciba las alertas.';
  return errors;
}

/** Roles in the canonical order of the backend, without repeats. */
export const orderedRoles = (roles: readonly AlertRecipientRole[]): AlertRecipientRole[] =>
  recipientOrder.filter((role) => roles.includes(role));

/** The full replacement the backend expects, carrying the version of the last read. Call only on valid values. */
export const toInput = (values: SettingsFormValues, version: number): AlertSettingsInput => ({
  version,
  expiryWindowDays: Number(values.expiryWindowDays.trim()),
  recipientRoles: orderedRoles(values.recipientRoles),
});

/** Whether saving would change nothing. */
export const isUnchanged = (settings: AlertSettings, values: SettingsFormValues): boolean => {
  const next = toInput(values, settings.version);
  return (
    next.expiryWindowDays === settings.expiryWindowDays &&
    next.recipientRoles.length === settings.recipientRoles.length &&
    next.recipientRoles.every((role, index) => role === settings.recipientRoles[index])
  );
};
