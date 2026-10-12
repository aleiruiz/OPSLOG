import { describe, expect, it } from 'vitest';
import { draftOf, rebaseDraft, taskLines, type WorkSnapshot } from './workMerge';

const snapshot = (
  tasks: string[],
  parts: [string, string, string][] = [],
  prefix = 't',
): WorkSnapshot => ({
  tasks: tasks.map((description, index) => ({ id: `${prefix}${index}`, description })),
  parts: parts.map(([id, name, quantity]) => ({ id, name, quantity })),
});

describe('rebaseDraft', () => {
  it('keeps the draft and adds work other people saved meanwhile, reporting it', () => {
    const base = snapshot(['Cambio de aceite']);
    const draft = { ...draftOf(base), tasks: 'Cambio de aceite\nAjuste de freno' };
    const server = snapshot(['Cambio de aceite', 'Rotación de llantas']);
    const { draft: merged, changes } = rebaseDraft(base, server, draft);
    expect(taskLines(merged.tasks)).toEqual([
      'Cambio de aceite',
      'Rotación de llantas',
      'Ajuste de freno',
    ]);
    expect(changes).toEqual(['Otra persona agregó el trabajo «Rotación de llantas».']);
  });

  it('keeps the person’s removals and drops what others removed, saying so', () => {
    const base = snapshot(['A', 'B', 'C']);
    const draft = { ...draftOf(base), tasks: 'A\nC' };
    const server = snapshot(['A', 'B', 'D']);
    const { draft: merged, changes } = rebaseDraft(base, server, draft);
    expect(taskLines(merged.tasks)).toEqual(['A', 'D']);
    expect(changes).toEqual([
      'Otra persona agregó el trabajo «D».',
      'Otra persona quitó el trabajo «C»; ya no está en tu borrador.',
    ]);
  });

  it('does not duplicate a task both people added and reports nothing when nothing changed', () => {
    const base = snapshot([]);
    const draft = { ...draftOf(base), tasks: 'Lavado' };
    expect(taskLines(rebaseDraft(base, snapshot(['Lavado']), draft).draft.tasks)).toEqual([
      'Lavado',
    ]);
    const same = rebaseDraft(base, base, draft);
    expect(same.changes).toEqual([]);
    expect(taskLines(same.draft.tasks)).toEqual(['Lavado']);
  });

  it('merges parts by id: own edits win, concurrent additions stay, removals are respected', () => {
    const base = snapshot(
      [],
      [
        ['p1', 'Filtro', '1'],
        ['p2', 'Balata', '4'],
        ['p3', 'Aceite', '5'],
      ],
    );
    const draft = {
      tasks: '',
      parts: [
        { id: 'p1', name: 'Filtro', quantity: '2' }, // edited by the person
        { id: 'p3', name: 'Aceite', quantity: '5' }, // p2 removed by the person
        { id: undefined, name: 'Banda', quantity: '1' }, // new
      ],
    };
    const server = snapshot(
      [],
      [
        ['p1', 'Filtro', '1'],
        ['p2', 'Balata', '4'],
        ['p3', 'Aceite', '6'], // changed by someone else
        ['p4', 'Anticongelante', '2'], // added by someone else
      ],
    );
    const { draft: merged, changes } = rebaseDraft(base, server, draft);
    expect(merged.parts.map((part) => [part.id, part.name, part.quantity])).toEqual([
      ['p1', 'Filtro', '2'],
      ['p3', 'Aceite', '6'],
      ['p4', 'Anticongelante', '2'],
      [undefined, 'Banda', '1'],
    ]);
    expect(changes).toEqual([
      'Otra persona actualizó la refacción «Aceite».',
      'Otra persona agregó la refacción «Anticongelante».',
    ]);
  });

  it('handles parts changed on both sides and parts removed by someone else', () => {
    const base = snapshot(
      [],
      [
        ['p1', 'Filtro', '1'],
        ['p2', 'Balata', '4'],
        ['p3', 'Aceite', '5'],
      ],
    );
    const draft = {
      tasks: '',
      parts: [
        { id: 'p1', name: 'Filtro', quantity: '2' },
        { id: 'p2', name: 'Balata', quantity: '8' },
        { id: 'p3', name: 'Aceite', quantity: '5' },
      ],
    };
    const server = snapshot([], [['p1', 'Filtro', '3']]);
    const { draft: merged, changes } = rebaseDraft(base, server, draft);
    expect(merged.parts.map((part) => [part.id, part.quantity])).toEqual([
      ['p1', '2'],
      [undefined, '8'],
    ]);
    expect(changes).toEqual([
      'Otra persona también cambió la refacción «Filtro»; se conserva tu cambio.',
      'Otra persona quitó la refacción «Balata»; tu versión editada se conserva como nueva.',
      'Otra persona quitó la refacción «Aceite»; ya no está en tu borrador.',
    ]);
  });

  it('does not duplicate a part both people added', () => {
    const base = snapshot([]);
    const draft = { tasks: '', parts: [{ id: undefined, name: 'Filtro', quantity: '1' }] };
    const { draft: merged } = rebaseDraft(base, snapshot([], [['p9', 'Filtro', '1']]), draft);
    expect(merged.parts).toEqual([{ id: 'p9', name: 'Filtro', quantity: '1' }]);
  });
});
