import { describe, expect, it } from 'vitest';
import { parseLead } from './lead.js';

const valid = {
  nombre: '  Ana López ',
  empresa: 'Transportes del Norte',
  correo: 'Ana@Example.MX',
  telefono: '+52 (81) 1234-5678',
  flotilla: '21-50',
  mensaje: 'Linea 1\r\nLinea 2',
  origen: 'facebook',
  acepto: 'on',
};

describe('parseLead', () => {
  it('accepts and normalizes a complete request', () => {
    expect(parseLead(valid)).toEqual({
      kind: 'lead',
      lead: {
        nombre: 'Ana López',
        empresa: 'Transportes del Norte',
        correo: 'ana@example.mx',
        telefono: '+52 (81) 1234-5678',
        flotilla: '21-50',
        mensaje: 'Linea 1\nLinea 2',
        origen: 'facebook',
      },
    });
  });

  it('accepts the optional fields missing and a JSON boolean consent', () => {
    const result = parseLead({
      nombre: 'Ana',
      empresa: 'X',
      correo: 'a@b.mx',
      flotilla: '201+',
      acepto: true,
    });
    expect(result).toMatchObject({ kind: 'lead', lead: { telefono: '', mensaje: '', origen: '' } });
  });

  it('names every invalid field', () => {
    const result = parseLead({
      nombre: ' ',
      empresa: 7,
      correo: 'no-es-correo',
      telefono: 'llámame',
      flotilla: '1000',
      mensaje: 'x'.repeat(2001),
      acepto: 'off',
    });
    expect(result).toEqual({
      kind: 'invalid',
      fields: ['nombre', 'empresa', 'correo', 'telefono', 'flotilla', 'mensaje', 'acepto'],
    });
  });

  it('rejects values over their limit and strips control characters', () => {
    expect(parseLead({ ...valid, nombre: 'x'.repeat(121) })).toMatchObject({ fields: ['nombre'] });
    expect(parseLead({ ...valid, nombre: 'Ana\u0000\tLópez' })).toMatchObject({
      lead: { nombre: 'Ana  López' },
    });
  });

  it('flags a filled honeypot as a bot', () => {
    expect(parseLead({ ...valid, sitio: 'http://spam' })).toEqual({ kind: 'bot' });
    expect(parseLead({ ...valid, sitio: '' }).kind).toBe('lead');
  });
});
