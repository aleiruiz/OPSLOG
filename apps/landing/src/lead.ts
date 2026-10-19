/** A demo request sent from the public landing page. */
export interface Lead {
  readonly nombre: string;
  readonly empresa: string;
  readonly correo: string;
  readonly telefono: string;
  readonly flotilla: FleetSize;
  readonly mensaje: string;
  /** Campaign or referrer the visitor arrived with (utm_source or ref), if any. */
  readonly origen: string;
}

export const FLEET_SIZES = ['1-20', '21-50', '51-200', '201+'] as const;
export type FleetSize = (typeof FLEET_SIZES)[number];

export type LeadResult =
  | { readonly kind: 'lead'; readonly lead: Lead }
  /** The hidden honeypot field was filled: answer as if accepted, store nothing. */
  | { readonly kind: 'bot' }
  | { readonly kind: 'invalid'; readonly fields: readonly string[] };

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const PHONE = /^[0-9+()\-.\s]{7,30}$/;

/** Trims, collapses control characters and caps a free-text value. */
function text(value: unknown, max: number, multiline = false): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return undefined;
  const cleaned = (multiline ? value.replace(/\r\n?/g, '\n') : value)
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return cleaned.length > max ? undefined : cleaned;
}

const accepted = (value: unknown): boolean =>
  value === true || value === 'on' || value === 'true' || value === '1';

/** Validates the submitted fields. Field names are the Spanish names of the form inputs. */
export function parseLead(input: Readonly<Record<string, unknown>>): LeadResult {
  const honeypot = input.sitio;
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return { kind: 'bot' };

  const invalid: string[] = [];
  const nombre = text(input.nombre, 120);
  const empresa = text(input.empresa, 160);
  const correo = text(input.correo, 254)?.toLowerCase();
  const telefono = text(input.telefono, 30);
  const mensaje = text(input.mensaje, 2000, true);
  const origen = text(input.origen, 100) ?? '';
  const flotilla = FLEET_SIZES.find((size) => size === input.flotilla);

  if (!nombre) invalid.push('nombre');
  if (!empresa) invalid.push('empresa');
  if (!correo || !EMAIL.test(correo)) invalid.push('correo');
  if (telefono === undefined || (telefono !== '' && !PHONE.test(telefono)))
    invalid.push('telefono');
  if (!flotilla) invalid.push('flotilla');
  if (mensaje === undefined) invalid.push('mensaje');
  if (!accepted(input.acepto)) invalid.push('acepto');

  if (invalid.length > 0 || !nombre || !empresa || !correo || !flotilla)
    return { kind: 'invalid', fields: invalid };
  return {
    kind: 'lead',
    lead: {
      nombre,
      empresa,
      correo,
      telefono: telefono ?? '',
      flotilla,
      mensaje: mensaje ?? '',
      origen,
    },
  };
}
