import { timingSafeEqual, createHash } from 'node:crypto';
import type { StoredLead } from './store.js';

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Checks an `Authorization: Basic` header for user `admin` in constant time. */
export function isAdmin(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return timingSafeEqual(digest(decoded), digest(`admin:${password}`));
}

const FLEET_LABEL: Record<string, string> = {
  '1-20': '1 a 20',
  '21-50': '21 a 50',
  '51-200': '51 a 200',
  '201+': 'Más de 200',
};

const mexicoTime = (iso: string): string =>
  new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date(iso));

/** The private list of demo requests, newest first. */
export function renderLeadsPage(leads: readonly StoredLead[]): string {
  const rows = leads
    .map(
      (lead) => `<tr>
  <td>${escapeHtml(mexicoTime(lead.recibido))}</td>
  <td>${escapeHtml(lead.nombre)}</td>
  <td>${escapeHtml(lead.empresa)}</td>
  <td><a href="mailto:${escapeHtml(lead.correo)}">${escapeHtml(lead.correo)}</a></td>
  <td>${escapeHtml(lead.telefono)}</td>
  <td>${escapeHtml(FLEET_LABEL[lead.flotilla] ?? lead.flotilla)}</td>
  <td class="msg">${escapeHtml(lead.mensaje)}</td>
  <td>${escapeHtml(lead.origen)}</td>
</tr>`,
    )
    .join('\n');
  const body =
    leads.length === 0
      ? '<p>Todavía no hay solicitudes.</p>'
      : `<table>
<thead><tr><th>Recibido</th><th>Nombre</th><th>Empresa</th><th>Correo</th><th>Teléfono</th><th>Vehículos</th><th>Mensaje</th><th>Origen</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Solicitudes de demo · OPSLOG</title>
<link rel="stylesheet" href="/admin.css">
</head>
<body>
<header><h1>Solicitudes de demo</h1><a href="/admin/leads.csv">Descargar CSV</a></header>
<p class="count">${leads.length} ${leads.length === 1 ? 'solicitud' : 'solicitudes'}</p>
${body}
</body>
</html>
`;
}
