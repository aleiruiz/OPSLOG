import { describe, expect, it } from 'vitest';
import {
  BFF_LIST_CATALOG,
  BFF_LIST_DEFAULT_LIMIT,
  BFF_LIST_LIMITS,
  BFF_LIST_MODULES,
  BFF_VIEWS_PER_USER_AND_MODULE,
  isBffListModule,
  isValidFilterValue,
  listModuleSpec,
} from './index.js';

describe('list catalog', () => {
  it('knows the six lists of BRD 14.2 and nothing else', () => {
    expect([...BFF_LIST_MODULES]).toEqual([
      'vehicles',
      'employees',
      'documents',
      'insurance',
      'maintenance',
      'incidents',
    ]);
    expect(isBffListModule('vehicles')).toBe(true);
    expect(isBffListModule('users')).toBe(false);
    expect(isBffListModule(7)).toBe(false);
    expect(listModuleSpec('incidents')).toBe(BFF_LIST_CATALOG.incidents);
    expect(BFF_LIST_LIMITS).toEqual([25, 50, 100]);
    expect(BFF_LIST_DEFAULT_LIMIT).toBe(25);
    expect(BFF_VIEWS_PER_USER_AND_MODULE).toBe(50);
  });

  it('keeps unique keys, locked identifiers and one gate per cost', () => {
    for (const module of BFF_LIST_MODULES) {
      const spec = listModuleSpec(module);
      const keys = spec.columns.map((column) => column.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(spec.columns.some((column) => column.locked)).toBe(true);
      expect(spec.access).toBe(module === 'incidents' ? 'incidents:view' : 'view');
    }
    expect(listModuleSpec('maintenance').filters['costFrom']?.permission).toBe('view_costs');
    expect(
      listModuleSpec('maintenance').columns.find((column) => column.key === 'cost')?.permission,
    ).toBe('view_costs');
  });

  it('validates every kind of value the same way on the client and the server', () => {
    const f = (module: Parameters<typeof listModuleSpec>[0], key: string) =>
      listModuleSpec(module).filters[key]!.spec;
    expect(isValidFilterValue(f('vehicles', 'status'), 'active')).toBe(true);
    expect(isValidFilterValue(f('vehicles', 'status'), 'flying')).toBe(false);
    expect(isValidFilterValue(f('incidents', 'status'), 'draft,reported')).toBe(true);
    expect(isValidFilterValue(f('incidents', 'status'), 'draft,draft')).toBe(false);
    expect(isValidFilterValue(f('incidents', 'status'), 'draft,nope')).toBe(false);
    expect(isValidFilterValue(f('vehicles', 'areaId'), 'area-norte_1')).toBe(true);
    expect(isValidFilterValue(f('vehicles', 'areaId'), 'a b')).toBe(false);
    expect(isValidFilterValue(f('employees', 'hiredFrom'), '2026-02-28')).toBe(true);
    expect(isValidFilterValue(f('employees', 'hiredFrom'), '2026-02-30')).toBe(false);
    expect(isValidFilterValue(f('employees', 'hiredFrom'), '26-02-28')).toBe(false);
    expect(isValidFilterValue(f('maintenance', 'month'), '2026-10')).toBe(true);
    expect(isValidFilterValue(f('maintenance', 'month'), '2026-13')).toBe(false);
    expect(isValidFilterValue(f('vehicles', 'yearFrom'), '1949')).toBe(false);
    expect(isValidFilterValue(f('vehicles', 'yearFrom'), '2020')).toBe(true);
    expect(isValidFilterValue(f('vehicles', 'kmFrom'), '12.5')).toBe(false);
    expect(isValidFilterValue(f('vehicles', 'includeArchived'), 'true')).toBe(true);
    expect(isValidFilterValue(f('vehicles', 'includeArchived'), 'false')).toBe(false);
  });
});
