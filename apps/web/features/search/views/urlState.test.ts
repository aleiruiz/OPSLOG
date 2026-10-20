import { describe, expect, it } from 'vitest';
import { BFF_LIST_CATALOG, BFF_LIST_MODULES } from '@opslog/contracts';
import { hasFilters, listLink, listSearch, parseSort, pickFilters, readListUrl } from './urlState';

const read = (module: Parameters<typeof readListUrl>[0], query: string, can = () => true) =>
  readListUrl(module, new URLSearchParams(query), can);

describe('list address', () => {
  it('reads only the allowlisted keys with valid values', () => {
    const url = read(
      'vehicles',
      'status=active&status2=x&areaId=area-norte&yearFrom=1900&yearTo=2024&kmFrom=-1&includeArchived=false&limit=77&evil=1',
    );
    expect(url.filters).toEqual({ status: 'active', areaId: 'area-norte', yearTo: '2024' });
    expect(url.limit).toBe(25);
    expect(url.sort).toBeNull();
    expect(hasFilters(url)).toBe(true);
    expect(read('vehicles', '').filters).toEqual({});
    expect(hasFilters(read('vehicles', ''))).toBe(false);
  });

  it('drops a filter that needs a permission the reader lacks', () => {
    const query = 'status=assigned&costFrom=1000';
    expect(read('maintenance', query).filters).toEqual({ status: 'assigned', costFrom: '1000' });
    expect(read('maintenance', query, () => false).filters).toEqual({ status: 'assigned' });
  });

  it('reads sort and page size', () => {
    expect(read('incidents', 'sort=-createdAt&limit=100').sort).toEqual({
      field: 'createdAt',
      direction: 'desc',
    });
    expect(read('incidents', 'limit=100').limit).toBe(100);
    expect(parseSort('incidents', 'folio')).toEqual({ field: 'folio', direction: 'asc' });
    expect(parseSort('incidents', 'nothing')).toBeNull();
    expect(parseSort('vehicles', 'plate')).toBeNull();
    expect(parseSort('incidents', null)).toBeNull();
  });

  it('writes a canonical address without defaults', () => {
    expect(listSearch(read('vehicles', 'yearFrom=2020&status=active'))).toBe(
      '?status=active&yearFrom=2020',
    );
    expect(listSearch(read('vehicles', 'limit=25'))).toBe('');
    expect(listSearch(read('incidents', 'sort=-folio&limit=50&severity=critical'))).toBe(
      '?severity=critical&sort=-folio&limit=50',
    );
  });

  it('builds the drill-down links of the dashboards from the catalog', () => {
    expect(listLink('vehicles', { status: 'in_maintenance' })).toBe(
      '/flota/vehiculos?status=in_maintenance',
    );
    expect(listLink('documents', { status: 'expired', ownerType: 'vehicle' })).toBe(
      '/flota/documentos?ownerType=vehicle&status=expired',
    );
    expect(listLink('maintenance', { overdue: 'true' })).toBe('/flota/mantenimiento?overdue=true');
    expect(
      listLink(
        'incidents',
        { severity: 'critical' },
        { sort: { field: 'createdAt', direction: 'desc' }, limit: 50 },
      ),
    ).toBe('/incidents?severity=critical&sort=-createdAt&limit=50');
    // Keys and values outside the catalog never reach a link.
    expect(listLink('vehicles', { status: 'flying', nope: '1' })).toBe('/flota/vehiculos');
  });

  it('keeps the keys a screen asks for', () => {
    expect(pickFilters({ a: '1', b: '', c: '3' }, ['a', 'b', 'z'])).toEqual({ a: '1' });
  });

  it('has the same paths as the app routes and a label for every filter and column', () => {
    for (const module of BFF_LIST_MODULES) {
      const spec = BFF_LIST_CATALOG[module];
      expect(spec.path.startsWith('/')).toBe(true);
      for (const filter of Object.values(spec.filters)) expect(filter.label).not.toBe('');
      for (const column of spec.columns) expect(column.label).not.toBe('');
    }
  });
});
