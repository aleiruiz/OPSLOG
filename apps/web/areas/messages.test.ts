import { describe, expect, it } from 'vitest';
import type { ApiError } from '../app/types';
import { describeHistory } from './labels';
import { makeHistoryEntry } from './fixtures';
import {
  activateFailure,
  blockerOf,
  deactivateFailure,
  describeFailure,
  duplicateErrors,
} from './messages';

const err = (status: ApiError['status'], code: string, field?: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
  ...(field ? { fieldErrors: [{ field, code, message: 'x' }] } : {}),
});

describe('describeFailure', () => {
  it('says nothing for an expired session (the shell handles it)', () => {
    expect(describeFailure(err(401, 'unauthorized'), 'edit')).toEqual({ alert: null, fields: {} });
  });

  it('offers to reload after a version conflict and says whether anything was saved', () => {
    const created = describeFailure(err(409, 'stale_version'), 'create');
    expect(created.alert).toMatchObject({ title: 'Otra persona modificó esta área', actionLabel: 'Cargar datos actuales' });
    expect(created.alert?.message).toContain('No se creó el área.');
    expect(describeFailure(err(409, 'stale_version'), 'edit').alert?.message).toContain(
      'Tus cambios no se guardaron.',
    );
  });

  it('explains an inactive area, field duplicates, invalid hierarchy and invalid responsibles', () => {
    expect(describeFailure(err(409, 'immutable'), 'edit').alert?.title).toBe('El área ya no admite cambios');
    const duplicate = describeFailure(err(409, 'duplicate', 'name'), 'create');
    expect(duplicate.fields.name).toMatch(/mismo nombre|este nombre/);
    expect(duplicate.alert?.title).toBe('Hay datos que ya existen');
    const moved = describeFailure(err(409, 'duplicate', 'name'), 'move');
    expect(moved.fields).toEqual({ parentId: expect.stringContaining('esa área superior') });
    expect(moved.alert?.title).toBe('Ya hay un área con ese nombre allí');
    const hierarchy = describeFailure(err(422, 'invalid_hierarchy'), 'move');
    expect(hierarchy.fields.parentId).toBe('Elige otra área superior.');
    expect(hierarchy.alert?.actionLabel).toBe('Cargar datos actuales');
    const responsible = describeFailure(err(422, 'invalid_responsible'), 'edit');
    expect(responsible.fields.responsibles).toMatch(/miembro activo/);
  });

  it('maps the remaining statuses', () => {
    expect(describeFailure(err(400, 'bad_request'), 'edit').alert?.title).toBe('El servidor rechazó los datos');
    expect(describeFailure(err(403, 'forbidden'), 'edit').alert?.title).toBe('No tienes permiso');
    expect(describeFailure(err(404, 'not_found'), 'edit').alert?.title).toBe('El área ya no existe');
    expect(describeFailure(err(500, 'internal_error'), 'create').alert?.title).toBe('No pudimos crear el área');
    expect(describeFailure(err(500, 'internal_error'), 'edit').alert?.title).toBe('No pudimos guardar el área');
    expect(describeFailure(err(500, 'internal_error'), 'move').alert?.title).toBe('No pudimos mover el área');
  });
});

describe('duplicateErrors', () => {
  it('marks the colliding fields and ignores unknown ones', () => {
    expect(
      duplicateErrors({
        ...err(409, 'duplicate'),
        fieldErrors: [
          { field: 'name', code: 'duplicate', message: 'x' },
          { field: 'code', code: 'duplicate', message: 'x' },
          { field: 'otro', code: 'duplicate', message: 'x' },
        ],
      }),
    ).toEqual({
      name: expect.stringContaining('nombre'),
      code: expect.stringContaining('código'),
    });
    expect(duplicateErrors(err(409, 'duplicate'))).toEqual({});
  });
});

describe('deactivation and activation failures', () => {
  it('names what blocks a deactivation: sub-areas, vehicles or people', () => {
    expect(blockerOf(err(409, 'area_in_use', 'vehicles'))).toBe('vehicles');
    expect(blockerOf(err(409, 'stale_version'))).toBeNull();
    expect(blockerOf(err(409, 'area_in_use'))).toBe('');
    expect(deactivateFailure(err(409, 'area_in_use', 'sub_areas')).error).toMatch(/sub-áreas activas/);
    expect(deactivateFailure(err(409, 'area_in_use', 'vehicles')).error).toMatch(/vehículos activos/);
    expect(deactivateFailure(err(409, 'area_in_use', 'people')).error).toMatch(/personas activas/);
    expect(deactivateFailure(err(409, 'area_in_use')).error).toMatch(/recursos activos/);
    expect(deactivateFailure(err(409, 'area_in_use', 'nuevo')).error).toMatch(/recursos activos/);
    expect(deactivateFailure(err(409, 'area_in_use', 'vehicles')).errorActionLabel).toBe('Recargar datos');
  });

  it('handles conflicts, permissions and failures of both actions', () => {
    expect(deactivateFailure(err(409, 'stale_version')).errorActionLabel).toBe('Recargar datos');
    expect(deactivateFailure(err(409, 'invalid_transition')).error).toBe('Esta área ya estaba inactiva.');
    expect(deactivateFailure(err(403, 'forbidden')).error).toMatch(/permiso/);
    expect(deactivateFailure(err(404, 'not_found')).error).toMatch(/ya no existe/);
    expect(deactivateFailure(err(500, 'internal_error')).error).toMatch(/No pudimos desactivar/);
    expect(activateFailure(err(422, 'invalid_hierarchy')).error).toMatch(/área superior está inactiva/);
    expect(activateFailure(err(409, 'stale_version')).errorActionLabel).toBe('Recargar datos');
    expect(activateFailure(err(409, 'invalid_transition')).error).toBe('Esta área ya estaba activa.');
    expect(activateFailure(err(403, 'forbidden')).error).toMatch(/permiso/);
    expect(activateFailure(err(404, 'not_found')).error).toMatch(/ya no existe/);
    expect(activateFailure(err(500, 'internal_error')).error).toMatch(/No pudimos activar/);
  });
});

describe('describeHistory', () => {
  const names = new Map([['a', 'Norte'], ['b', 'Sur']]);
  const nameOf = (id: string) => names.get(id) ?? null;
  it('describes each action with names from the tree, never from the entry', () => {
    expect(describeHistory(makeHistoryEntry(), nameOf)).toBe('Área creada en el nivel raíz');
    expect(describeHistory(makeHistoryEntry({ toParentId: 'a' }), nameOf)).toBe('Área creada dentro de «Norte»');
    expect(describeHistory(makeHistoryEntry({ action: 'activated' }), nameOf)).toBe('Área activada');
    expect(describeHistory(makeHistoryEntry({ action: 'deactivated' }), nameOf)).toBe('Área desactivada');
    expect(describeHistory(makeHistoryEntry({ action: 'updated', fields: ['name'] }), nameOf)).toBe(
      'Datos modificados: nombre',
    );
    expect(
      describeHistory(makeHistoryEntry({ action: 'updated', fields: ['name', 'code', 'responsibles'] }), nameOf),
    ).toBe('Datos modificados: nombre, código y responsables');
    expect(describeHistory(makeHistoryEntry({ action: 'updated', fields: [] }), nameOf)).toBe('Datos modificados');
    expect(
      describeHistory(
        makeHistoryEntry({ action: 'updated', fields: ['parent'], fromParentId: 'a', toParentId: 'b' }),
        nameOf,
      ),
    ).toBe('Movida de «Norte» a «Sur»');
    expect(
      describeHistory(
        makeHistoryEntry({ action: 'updated', fields: ['parent', 'name'], fromParentId: null, toParentId: 'zz' }),
        nameOf,
      ),
    ).toBe('Movida de el nivel raíz a «otra área»; también cambió nombre');
  });
});
