import { KINDS, type EventKind, type Severity } from './catalog.js';

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  info: 'Informativo',
  attention: 'Atención',
  important: 'Importante',
  critical: 'Crítico',
};

export interface EmailSource {
  readonly eventKind: EventKind;
  readonly title: string;
  readonly link: string;
  readonly severity: Severity;
}

export interface Email {
  readonly template: EventKind;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The link as the e-mail shows it: absolute when the web host is known, the app path otherwise. */
export function absoluteLink(base: string | undefined, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * The fixed Spanish template of an event: company name, the title of the notice (a label and a
 * folio or economic number), its importance and a link. Nothing else of the record travels: no
 * amount, no person, no free text. Every value is escaped in the HTML.
 */
export function composeEmail(
  source: EmailSource,
  company: string,
  options: { readonly baseUrl?: string | undefined } = {},
): Email {
  const link = absoluteLink(options.baseUrl, source.link);
  const preferences = absoluteLink(options.baseUrl, '/notificaciones/preferencias');
  const importance = SEVERITY_LABELS[source.severity];
  const reason = `Recibes este aviso por «${KINDS[source.eventKind].label}». Puedes cambiar tus avisos en ${preferences}`;
  const text = [
    company,
    '',
    source.title,
    `Importancia: ${importance}`,
    `Ver en OPSLOG: ${link}`,
    '',
    reason,
  ].join('\n');
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#171A1F">',
    `<p style="color:#3E4650;margin:0 0 8px">${escapeHtml(company)}</p>`,
    `<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(source.title)}</h1>`,
    `<p style="margin:0 0 8px">Importancia: <strong>${escapeHtml(importance)}</strong></p>`,
    `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}">Ver en OPSLOG</a></p>`,
    `<p style="font-size:12px;color:#3E4650">${escapeHtml(reason)}</p>`,
    '</body></html>',
  ].join('');
  return {
    template: source.eventKind,
    subject: `OPSLOG · ${company}: ${source.title}`.slice(0, 200),
    text,
    html,
  };
}
