import { describe, expect, it } from 'vitest';
import { describeChangeSide, formatChangeValue, resultView } from './labels';

describe('audit labels', () => {
  it('translates codes and booleans, and never prints a raw code or null', () => {
    expect(formatChangeValue('severity', 'high', 'incident')).toBe('Alta');
    expect(formatChangeValue('status', 'in_progress', 'maintenance_work_order')).not.toBe(
      'in_progress',
    );
    expect(formatChangeValue('x', true, 'incident')).toBe('Sí');
    expect(formatChangeValue('x', false, 'incident')).toBe('No');
    expect(formatChangeValue('x', null, 'incident')).toBe('Sin dato');
    expect(formatChangeValue('x', 3, 'incident')).toBe('3');
    expect(formatChangeValue('x', 'texto', 'incident')).toBe('texto');
  });

  it('never exposes a value of a restricted or unrecorded field', () => {
    const base = { field: 'description', label: 'Descripción' } as const;
    expect(
      describeChangeSide({ ...base, state: 'restricted', before: 'secreto' }, 'before', 'incident'),
    ).toBe('valor restringido');
    expect(describeChangeSide({ ...base, state: 'not_recorded' }, 'after', 'incident')).toBe(
      'no registrado',
    );
  });

  it('presents the result of an event', () => {
    expect(resultView('denied')).toEqual({ label: 'Denegada', tone: 'danger' });
    expect(resultView('success').label).toBe('Realizada');
  });
});
