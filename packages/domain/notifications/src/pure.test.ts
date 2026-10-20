import { describe, expect, it } from 'vitest';
import { holds, kindsFor, meets } from './access.js';
import { dayIn, isQuiet, notBefore } from './calendar.js';
import { EVENT_KINDS, KINDS, isChannel } from './catalog.js';
import {
  EXPIRY_SOURCE_LABELS,
  cleanLabel,
  exportTitle,
  expiryTitle,
  incidentCreatedTitle,
  incidentStatusTitle,
  maintenanceTitle,
  membershipTitle,
  outOfServiceTitle,
  titled,
  workOrderTitle,
} from './titles.js';
import { SEVERITY_LABELS, absoluteLink, composeEmail } from './templates.js';
import { SEVERITIES } from './catalog.js';

describe('catalog and access', () => {
  it('declares what each kind needs and which are mandatory', () => {
    expect(EVENT_KINDS.filter((kind) => KINDS[kind].mandatory)).toEqual([
      'incident_sla',
      'work_order_assigned',
      'membership_created',
      'membership_role_changed',
      'export_ready',
      'export_failed',
    ]);
    expect(isChannel('email')).toBe(true);
    expect(isChannel('sms')).toBe(false);
  });

  it('evaluates the rights a kind needs', () => {
    const viewer = { permissions: ['view'], mechanicLinked: false } as const;
    const incidents = { permissions: ['incidents:view'], mechanicLinked: false } as const;
    const mechanic = { permissions: ['view', 'incidents:view'], mechanicLinked: true } as const;
    const lead = {
      permissions: ['view', 'incidents:view', 'incidents:edit'],
      mechanicLinked: true,
    } as const;
    expect(meets(viewer, 'view')).toBe(true);
    expect(meets(viewer, 'incidents')).toBe(false);
    expect(meets(incidents, 'view')).toBe(false);
    expect(meets(incidents, 'incidents')).toBe(true);
    expect(meets(mechanic, 'incidents')).toBe(false);
    expect(meets(lead, 'incidents')).toBe(true);
    expect(meets(viewer, null)).toBe(true);
    expect(holds(viewer, 'view')).toBe(true);
    expect(kindsFor(viewer)).not.toContain('incident_sla');
    expect(kindsFor(viewer)).toContain('export_ready');
    expect(kindsFor(incidents)).toContain('incident_sla');
  });
});

describe('calendar', () => {
  it('names the day in the zone of the company', () => {
    expect(dayIn(new Date('2026-10-20T03:00:00Z'), 'America/Mexico_City')).toBe('2026-10-19');
    expect(dayIn(new Date('2026-10-20T07:00:00Z'), 'America/Mexico_City')).toBe('2026-10-20');
  });

  it('finds the quiet hours and the next 07:00', () => {
    const zone = 'America/Mexico_City';
    expect(isQuiet(new Date('2026-10-20T04:00:00Z'), zone)).toBe(true); // 22:00
    expect(isQuiet(new Date('2026-10-20T12:59:59Z'), zone)).toBe(true); // 06:59
    expect(isQuiet(new Date('2026-10-20T13:00:00Z'), zone)).toBe(false); // 07:00
    expect(isQuiet(new Date('2026-10-20T03:59:59Z'), zone)).toBe(false); // 21:59
    const day = new Date('2026-10-19T18:00:00Z');
    expect(notBefore(day, zone, true)).toEqual(day);
    expect(notBefore(new Date('2026-10-20T05:00:00Z'), zone, false)).toEqual(
      new Date('2026-10-20T05:00:00Z'),
    );
    // 23:00 local waits for 07:00 of the next day; 02:00 local for 07:00 of the same day.
    expect(notBefore(new Date('2026-10-20T05:00:00Z'), zone, true).toISOString()).toBe(
      '2026-10-20T13:00:00.000Z',
    );
    expect(notBefore(new Date('2026-10-20T08:00:00Z'), zone, true).toISOString()).toBe(
      '2026-10-20T13:00:00.000Z',
    );
  });

  it('follows daylight saving time', () => {
    const zone = 'America/New_York';
    // 23:00 EDT on 2026-11-01 (the night the clocks go back): 07:00 that morning is EST.
    expect(notBefore(new Date('2026-11-01T03:30:00Z'), zone, true).toISOString()).toBe(
      '2026-11-01T12:00:00.000Z',
    );
    // 22:30 EST on 2026-11-01: 07:00 on the 2nd is EST too.
    expect(notBefore(new Date('2026-11-02T03:30:00Z'), zone, true).toISOString()).toBe(
      '2026-11-02T12:00:00.000Z',
    );
    // Spring forward: 02:30 local on 2026-03-08 does not exist, 07:00 does.
    expect(notBefore(new Date('2026-03-08T06:30:00Z'), zone, true).toISOString()).toBe(
      '2026-03-08T11:00:00.000Z',
    );
    // A zone whose 07:00 lands in a gap moves to the first instant after it.
    expect(
      notBefore(new Date('2026-10-04T14:30:00Z'), 'Australia/Lord_Howe', true).toISOString(),
    ).toBe('2026-10-04T20:00:00.000Z');
  });
});

describe('titles', () => {
  it('cleans and bounds the label of a record', () => {
    expect(cleanLabel('  ECO\t12\u0000\n ')).toBe('ECO 12');
    expect(titled('Siniestro nuevo')).toBe('Siniestro nuevo');
    expect(titled('Siniestro nuevo', ' SIN-1 ')).toBe('Siniestro nuevo · SIN-1');
    expect(titled('Aviso', 'x'.repeat(300))).toHaveLength(160);
  });

  it('composes the title of each event from fixed texts and a label', () => {
    expect(expiryTitle('insurance_policy', 7, 'ECO-1')).toBe('Seguro vence en 7 días · ECO-1');
    expect(expiryTitle('employee_license', 0, '')).toBe(
      'Licencia de conductor vence hoy o ya venció',
    );
    expect(Object.keys(EXPIRY_SOURCE_LABELS)).toHaveLength(3);
    expect(incidentStatusTitle('under_review', 'SIN-1')).toBe('Siniestro En revisión · SIN-1');
    expect(incidentStatusTitle('mystery', 'SIN-1')).toBe('Siniestro actualizado · SIN-1');
    expect(incidentCreatedTitle('SIN-1')).toBe('Siniestro nuevo · SIN-1');
    expect(maintenanceTitle(true, 'ECO-1')).toBe('Mantenimiento vencido · ECO-1');
    expect(maintenanceTitle(false, 'ECO-1')).toBe('Mantenimiento próximo · ECO-1');
    expect(outOfServiceTitle('ECO-1')).toBe('Vehículo fuera de servicio · ECO-1');
    expect(workOrderTitle('ECO-1')).toBe('Orden de mantenimiento asignada · ECO-1');
    expect(membershipTitle(true)).toBe('Usuario nuevo en la empresa');
    expect(membershipTitle(false)).toBe('Cambió el rol de un usuario');
    expect(exportTitle(true, 'Conductores')).toBe('Exportación lista · Conductores');
    expect(exportTitle(false, 'Conductores')).toBe('Exportación fallida · Conductores');
  });
});

describe('e-mail templates', () => {
  const source = (kind: (typeof EVENT_KINDS)[number]) => ({
    eventKind: kind,
    title: 'Aviso · ECO-1',
    link: '/flota/vehiculos/v1',
    severity: 'important' as const,
  });

  it('builds an absolute link only when the web host is known', () => {
    expect(absoluteLink(undefined, '/x')).toBe('/x');
    expect(absoluteLink('https://a.test///', '/x')).toBe('https://a.test/x');
    expect(absoluteLink('https://a.test', 'x')).toBe('https://a.test/x');
  });

  it.each(EVENT_KINDS)(
    'the %s template carries only the company, the title, the importance and links',
    (kind) => {
      const email = composeEmail(source(kind), 'Empresa Alfa', { baseUrl: 'https://opslog.test' });
      expect(email.template).toBe(kind);
      expect(email.subject).toBe('OPSLOG · Empresa Alfa: Aviso · ECO-1');
      expect(email.text.split('\n')).toEqual([
        'Empresa Alfa',
        '',
        'Aviso · ECO-1',
        'Importancia: Importante',
        'Ver en OPSLOG: https://opslog.test/flota/vehiculos/v1',
        '',
        `Recibes este aviso por «${KINDS[kind].label}». Puedes cambiar tus avisos en https://opslog.test/notificaciones/preferencias`,
      ]);
      // No amounts, no digits beyond the identifiers we passed in, no addresses.
      expect(`${email.subject}${email.text}${email.html}`).not.toMatch(/[$€]|@/);
      expect(`${email.subject}${email.text}`).not.toMatch(/\d{3,}/);
    },
  );

  it('escapes every value in the HTML', () => {
    const email = composeEmail(
      { ...source('export_ready'), title: '<b>"x"</b> & \'y\'', link: '/a?b="1"&c=<2>' },
      '<Empresa & Co>',
    );
    expect(email.html).not.toContain('<b>');
    expect(email.html).not.toContain('<Empresa');
    expect(email.html).toContain('&#60;b&#62;&#34;x&#34;&#60;/b&#62; &#38; &#39;y&#39;');
    expect(email.html).toContain('href="/a?b=&#34;1&#34;&#38;c=&#60;2&#62;"');
    for (const severity of SEVERITIES)
      expect(composeEmail({ ...source('export_ready'), severity }, 'E').text).toContain(
        SEVERITY_LABELS[severity],
      );
  });
});
