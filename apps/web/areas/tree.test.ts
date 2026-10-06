import { describe, expect, it } from 'vitest';
import { demoAreas, makeArea } from './fixtures';
import {
  ancestors,
  buildTree,
  defaultExpanded,
  descendantIds,
  findNode,
  parentChoices,
  subtreeHeight,
  visibleIds,
} from './tree';

const areas = demoAreas();
const tree = buildTree(areas);

describe('area tree', () => {
  it('builds the forest ordered by name at every level', () => {
    expect(tree.map((node) => node.area.name)).toEqual(['Centro', 'Norte', 'Sur']);
    const norte = findNode(tree, 'area-norte');
    expect(norte?.children.map((node) => node.area.name)).toEqual(['Chihuahua', 'Monterrey']);
    expect(findNode(tree, 'no-existe')).toBeNull();
  });

  it('shows an area whose parent is not in the list as a root', () => {
    const orphan = buildTree(areas.filter((area) => area.id !== 'area-norte'));
    expect(orphan.map((node) => node.area.name)).toEqual(['Centro', 'Chihuahua', 'Monterrey', 'Sur']);
  });

  it('lists the visible items in display order, honouring what is expanded', () => {
    expect(visibleIds(tree, new Set())).toEqual(['area-centro', 'area-norte', 'area-sur']);
    expect(visibleIds(tree, defaultExpanded(tree))).toHaveLength(8);
    expect(visibleIds(tree, new Set(['area-norte', 'area-norte-mty']))).toEqual([
      'area-centro',
      'area-norte',
      'area-norte-chih',
      'area-norte-mty',
      'area-mty-apodaca',
      'area-mty-guadalupe',
      'area-sur',
    ]);
  });

  it('opens only the roots that have children by default', () => {
    const lonely = buildTree([makeArea()]);
    expect([...defaultExpanded(lonely)]).toEqual([]);
    expect([...defaultExpanded(tree)].sort()).toEqual(['area-centro', 'area-norte', 'area-sur']);
  });

  it('measures subtrees and descendants', () => {
    const norte = findNode(tree, 'area-norte');
    if (!norte) throw new Error('missing');
    expect(subtreeHeight(norte)).toBe(4);
    expect(descendantIds(norte)).toContain('area-apodaca-taller');
    expect(subtreeHeight(findNode(tree, 'area-sur-mer') as never)).toBe(1);
  });

  it('gives the chain of ancestors from the root down, and survives a cycle', () => {
    expect(ancestors(areas, 'area-apodaca-taller').map((area) => area.id)).toEqual([
      'area-norte',
      'area-norte-mty',
      'area-mty-apodaca',
    ]);
    expect(ancestors(areas, 'area-norte')).toEqual([]);
    expect(ancestors(areas, 'x')).toEqual([]);
    const loop = [
      makeArea({ id: 'a', parentId: 'b' }),
      makeArea({ id: 'b', parentId: 'a' }),
    ];
    expect(ancestors(loop, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('parent choices', () => {
  it('offers every active area for a new area, except those already at the fourth level', () => {
    const choices = parentChoices(tree, null);
    const byId = Object.fromEntries(choices.map((choice) => [choice.id, choice]));
    expect(byId['area-norte']?.unavailable).toBeNull();
    expect(byId['area-mty-apodaca']?.unavailable).toBeNull();
    expect(byId['area-apodaca-taller']?.unavailable).toBe('superaría los 4 niveles');
    expect(byId['area-mty-guadalupe']?.unavailable).toBe('inactiva');
    expect(byId['area-norte-mty']?.label).toMatch(/^ {3}Monterrey \(NTE-MTY\)$/);
    expect(byId['area-sur']?.label).toBe('Sur (SUR)');
    expect(byId['area-centro-qro']?.label).toBe('   Querétaro');
  });

  it('blocks the moved area, its sub-areas and the places that would push the subtree past four levels', () => {
    const moving = findNode(tree, 'area-norte-mty');
    const byId = Object.fromEntries(parentChoices(tree, moving).map((c) => [c.id, c]));
    expect(byId['area-norte-mty']?.unavailable).toBe('esta área o una de sus sub-áreas');
    expect(byId['area-apodaca-taller']?.unavailable).toBe('esta área o una de sus sub-áreas');
    // Monterrey's subtree has three levels: only a root can host it.
    expect(byId['area-norte']?.unavailable).toBeNull();
    expect(byId['area-sur']?.unavailable).toBeNull();
    expect(byId['area-sur-mer']?.unavailable).toBe('superaría los 4 niveles');
    const leaf = findNode(tree, 'area-apodaca-taller');
    const forLeaf = Object.fromEntries(parentChoices(tree, leaf).map((c) => [c.id, c]));
    expect(forLeaf['area-sur']?.unavailable).toBeNull();
    expect(forLeaf['area-apodaca-taller']?.unavailable).toBe('esta área o una de sus sub-áreas');
  });
});
