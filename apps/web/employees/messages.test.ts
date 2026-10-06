import { describe, expect, it } from 'vitest';
import type { ApiError } from '../app/types';
import { archiveFailure, describeFailure, RELOAD, statusFailure } from './messages';

const error = (status: ApiError['status'], code: string, field?: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
  ...(field ? { fieldErrors: [{ field, code, message: 'x' }] } : {}),
});

describe('describeFailure', () => {
  it('says nothing for a 401: the session panel takes over', () => {
    expect(describeFailure(error(401, 'unauthorized'), 'edit')).toEqual({
      alert: null,
      fields: {},
    });
  });

  it('offers to reload after a version conflict, and says what happened to the changes', () => {
    const edit = describeFailure(error(409, 'stale_version'), 'edit');
    expect(edit.alert).toMatchObject({ severity: 'error', actionLabel: RELOAD });
    expect(edit.alert?.message).toMatch(/Tus cambios no se guardaron/);
    expect(describeFailure(error(409, 'stale_version'), 'create').alert?.message).toMatch(
      /No se creó el empleado/,
    );
  });

  it('explains immutable, duplicate (with the field) and invalid_area (with the field)', () => {
    expect(describeFailure(error(409, 'immutable'), 'edit').alert?.title).toBe(
      'El empleado ya no admite cambios',
    );
    const dup = describeFailure(error(409, 'duplicate', 'email'), 'create');
    expect(dup.alert?.title).toBe('Hay datos que ya existen');
    expect(dup.fields.email).toBeDefined();
    const area = describeFailure(error(422, 'invalid_area', 'area_id'), 'create');
    expect(area.fields.areaId).toBe('El área no existe o está inactiva.');
    expect(area.alert?.title).toBe('El área no es válida');
  });

  it('maps 400, 403, 404 and anything else to a plain alert', () => {
    expect(describeFailure(error(400, 'bad_request'), 'edit').alert?.title).toBe(
      'El servidor rechazó los datos',
    );
    expect(describeFailure(error(403, 'forbidden'), 'edit').alert?.message).toMatch(
      /datos personales/,
    );
    expect(describeFailure(error(404, 'not_found'), 'edit').alert?.title).toBe(
      'El empleado ya no existe',
    );
    expect(describeFailure(error(500, 'x'), 'create').alert?.title).toBe(
      'No pudimos crear el empleado',
    );
    expect(describeFailure(error(500, 'x'), 'edit').alert?.title).toBe(
      'No pudimos guardar el empleado',
    );
  });
});

describe('action failures', () => {
  it('archive: reload on a conflict or an already archived employee, plain text otherwise', () => {
    expect(archiveFailure(error(409, 'stale_version')).errorActionLabel).toBe('Recargar datos');
    expect(archiveFailure(error(409, 'immutable')).error).toMatch(/ya estaba archivado/);
    expect(archiveFailure(error(403, 'forbidden')).error).toMatch(/permiso/);
    expect(archiveFailure(error(404, 'not_found')).error).toMatch(/ya no existe/);
    expect(archiveFailure(error(500, 'x'))).toEqual({
      error: 'No pudimos archivar al empleado. Intenta nuevamente.',
    });
  });

  it('status: reload on a conflict, a changed state or a closed record, plain text otherwise', () => {
    for (const code of ['stale_version', 'invalid_transition', 'immutable'])
      expect(statusFailure(error(409, code)).errorActionLabel).toBe('Recargar datos');
    expect(statusFailure(error(400, 'bad_request')).error).toMatch(/motivo/);
    expect(statusFailure(error(403, 'forbidden')).error).toMatch(/permiso/);
    expect(statusFailure(error(404, 'not_found')).error).toMatch(/ya no existe/);
    expect(statusFailure(error(500, 'x')).error).toMatch(/No pudimos cambiar el estado/);
  });
});
