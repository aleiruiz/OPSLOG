import { describe, expect, it } from 'vitest';
import { makeArea } from './fixtures';
import {
  changes,
  emptyValues,
  responsibleProblem,
  toInput,
  validate,
  valuesOf,
  type AreaFormValues,
} from './formModel';
import type { ParentChoice } from './tree';

const choices: ParentChoice[] = [
  { id: 'area-norte', label: 'Norte', unavailable: null },
  { id: 'area-viejo', label: 'Viejo', unavailable: 'inactiva' },
];
const valid: AreaFormValues = {
  name: 'Base',
  code: 'b-1',
  parentId: 'area-norte',
  responsibleIds: [],
};

describe('validate', () => {
  it('accepts a complete area and normalizes nothing it rejects', () => {
    expect(validate(valid, { mode: 'create', choices })).toEqual({});
    expect(validate(emptyValues(), { mode: 'create', choices }).name).toBe(
      'Escribe el nombre del área.',
    );
  });

  it('checks the name, the code and the number of responsibles', () => {
    const found = validate(
      {
        ...valid,
        name: 'a\u0001b',
        code: '-x',
        responsibleIds: Array.from({ length: 21 }, (_, i) => `u${i}`),
      },
      { mode: 'edit', choices },
    );
    expect(found.name).toMatch(/80 caracteres/);
    expect(found.code).toMatch(/32 caracteres/);
    expect(found.responsibles).toMatch(/hasta 20/);
    expect(validate({ ...valid, name: 'x'.repeat(81) }, { mode: 'create', choices }).name).toMatch(
      /80/,
    );
  });

  it('checks the parent only where it is edited, against the offered choices', () => {
    expect(validate({ ...valid, parentId: 'otra' }, { mode: 'create', choices }).parentId).toMatch(
      /de la lista/,
    );
    expect(
      validate({ ...valid, parentId: 'area-viejo' }, { mode: 'move', choices }).parentId,
    ).toMatch(/inactiva/);
    expect(validate({ ...valid, parentId: 'otra' }, { mode: 'edit', choices })).toEqual({});
    expect(validate({ ...valid, parentId: '' }, { mode: 'create', choices })).toEqual({});
    // Moving ignores name and code.
    expect(validate({ ...valid, name: '' }, { mode: 'move', choices })).toEqual({});
  });
});

describe('responsibleProblem', () => {
  it('rejects empty, malformed, repeated and surplus identifiers', () => {
    expect(responsibleProblem(' ', [])).toMatch(/Escribe/);
    expect(responsibleProblem('a b', [])).toMatch(/letras/);
    expect(responsibleProblem('user-1', ['user-1'])).toMatch(/ya es responsable/);
    expect(
      responsibleProblem(
        'nuevo',
        Array.from({ length: 20 }, (_, i) => `u${i}`),
      ),
    ).toMatch(/hasta 20/);
    expect(responsibleProblem(' user-2 ', ['user-1'])).toBeNull();
  });
});

describe('request bodies', () => {
  it('builds the creation body without empty optional fields', () => {
    expect(
      toInput({ name: '  Base   Norte ', code: ' nte ', parentId: '', responsibleIds: ['u1'] }),
    ).toEqual({
      name: 'Base Norte',
      code: 'NTE',
      responsibleIds: ['u1'],
    });
    expect(toInput({ ...valid, code: '' })).toEqual({
      name: 'Base',
      parentId: 'area-norte',
      responsibleIds: [],
    });
  });

  it('reads the form values of an area', () => {
    expect(valuesOf(makeArea({ code: null, parentId: 'p' }))).toEqual({
      name: 'Norte',
      code: '',
      parentId: 'p',
      responsibleIds: ['admin'],
    });
  });

  it('patches only what changed, per mode', () => {
    const area = makeArea({ responsibleIds: ['a', 'b'], code: 'NTE', parentId: null });
    const same = valuesOf(area);
    expect(changes(area, same, 'edit')).toBeNull();
    expect(changes(area, same, 'move')).toBeNull();
    expect(changes(area, { ...same, name: ' Nuevo  nombre ' }, 'edit')).toEqual({
      name: 'Nuevo nombre',
    });
    expect(changes(area, { ...same, code: '' }, 'edit')).toEqual({ code: null });
    expect(changes(area, { ...same, code: 'nte' }, 'edit')).toBeNull();
    expect(changes(area, { ...same, responsibleIds: ['b', 'a'] }, 'edit')).toBeNull();
    expect(changes(area, { ...same, responsibleIds: ['a'] }, 'edit')).toEqual({
      responsibleIds: ['a'],
    });
    expect(changes(area, { ...same, responsibleIds: ['a', 'c'] }, 'edit')).toEqual({
      responsibleIds: ['a', 'c'],
    });
    // The parent is only a change of the move form.
    expect(changes(area, { ...same, parentId: 'x' }, 'edit')).toBeNull();
    expect(changes(area, { ...same, parentId: 'x' }, 'move')).toEqual({ parentId: 'x' });
    expect(changes(makeArea({ parentId: 'x' }), { ...same, parentId: '' }, 'move')).toEqual({
      parentId: null,
    });
  });
});
