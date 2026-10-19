import type { SmtpConfig } from './types.js';

/** The five variables that turn the SMTP adapter on, in the order they are checked. */
export const SMTP_VARIABLES = [
  'OPSLOG_SMTP_HOST',
  'OPSLOG_SMTP_PORT',
  'OPSLOG_SMTP_USER',
  'OPSLOG_SMTP_PASSWORD',
  'OPSLOG_SMTP_FROM',
] as const;
export type SmtpVariable = (typeof SMTP_VARIABLES)[number];

/** The failure names the variable that is missing or wrong, never its value. */
export class SmtpConfigError extends Error {
  public constructor(public readonly variable: SmtpVariable) {
    super(`SMTP configuration is incomplete or invalid: ${variable}`);
    this.name = 'SmtpConfigError';
  }
}

/** What both adapters accept as an address: one mailbox, no spaces or angle brackets. */
export const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Reads the SMTP settings. None set means the sink stays in charge (`null`); all five set turn the
 * adapter on; anything in between fails naming the first variable that is missing, so a half
 * configured deployment never falls back to the sink without anyone noticing.
 */
export function readSmtpConfig(
  env: Readonly<Record<string, string | undefined>>,
): SmtpConfig | null {
  const value = (name: SmtpVariable): string => (env[name] ?? '').trim();
  const present = SMTP_VARIABLES.filter((name) => value(name) !== '');
  if (present.length === 0) return null;
  const missing = SMTP_VARIABLES.find((name) => value(name) === '');
  if (missing) throw new SmtpConfigError(missing);
  const port = Number(value('OPSLOG_SMTP_PORT'));
  if (!/^\d{1,5}$/.test(value('OPSLOG_SMTP_PORT')) || port < 1 || port > 65_535)
    throw new SmtpConfigError('OPSLOG_SMTP_PORT');
  if (!ADDRESS.test(value('OPSLOG_SMTP_FROM'))) throw new SmtpConfigError('OPSLOG_SMTP_FROM');
  return {
    host: value('OPSLOG_SMTP_HOST'),
    port,
    user: value('OPSLOG_SMTP_USER'),
    // Not trimmed: a password may end in a space.
    password: env['OPSLOG_SMTP_PASSWORD'] as string,
    from: value('OPSLOG_SMTP_FROM'),
  };
}
