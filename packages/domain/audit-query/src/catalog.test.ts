import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_CODES,
  actionDomainOptions,
  actionLabel,
  isAllowedActionPrefix,
  isDeniedAction,
} from './catalog.js';
import { actorAlias, actorLabel } from './actor.js';
import { AUDIT_ENTITY_TYPES, entityType, entityTypeLabel, shortId } from './entities.js';

describe('action catalog', () => {
  it('has Spanish text for every known action and never shows a raw code', () => {
    for (const code of AUDIT_ACTION_CODES) expect(actionLabel(code)).not.toContain(code);
    expect(actionLabel('vehicle.created')).toBe('Vehículo creado');
    expect(actionLabel('incident.brand_new')).toBe('Siniestros: otra acción registrada');
    expect(actionLabel('zzz.thing')).toBe('Acción registrada');
  });

  it('accepts prefixes of allowlisted domains only', () => {
    expect(isAllowedActionPrefix('incident.')).toBe(true);
    expect(isAllowedActionPrefix('vehicle.status')).toBe(true);
    expect(isAllowedActionPrefix('maintenance')).toBe(true);
    expect(isAllowedActionPrefix('secret.')).toBe(false);
    expect(isAllowedActionPrefix('Incident.')).toBe(false);
    expect(isAllowedActionPrefix('incident.%')).toBe(false);
    expect(isAllowedActionPrefix('')).toBe(false);
  });

  it('offers a Spanish option per domain and recognizes denied attempts', () => {
    expect(actionDomainOptions().find((option) => option.value === 'incident.')?.label).toBe(
      'Siniestros',
    );
    expect(isDeniedAction('file.access_denied')).toBe(true);
    expect(isDeniedAction('file.downloaded')).toBe(false);
  });
});

describe('entities and actors', () => {
  it('names entity types and shortens opaque ids', () => {
    expect(AUDIT_ENTITY_TYPES).toContain('incident');
    expect(entityType('incident')?.read).toBe('incidents:view');
    expect(entityType('nope')).toBeUndefined();
    expect(entityTypeLabel('vehicle')).toBe('Vehículo');
    expect(entityTypeLabel('nope')).toBe('Registro');
    expect(shortId('abc')).toBe('abc');
    expect(shortId('0123456789abcdef')).toBe('01234567…');
  });

  it('gives stable per-company pseudonyms and role or kind labels', () => {
    expect(actorAlias('t1', 'user-1')).toBe(actorAlias('t1', 'user-1'));
    expect(actorAlias('t1', 'user-1')).not.toBe(actorAlias('t2', 'user-1'));
    expect(actorAlias('t1', 'user-1')).toMatch(/^U-[0-9A-F]{4}$/);
    expect(actorLabel('system', null)).toBe('Sistema');
    expect(actorLabel('api_key', null)).toBe('Integración');
    expect(actorLabel('user', 'Administrador')).toBe('Administrador');
    expect(actorLabel('user', null)).toBe('Usuario de la empresa');
  });
});
