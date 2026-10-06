import type { Area, AreaDetail, AreaHistoryEntry } from '../app/types';

/** Synthetic areas for the mock API, tests and stories. Nothing here is real data. */

export function makeArea(overrides: Partial<Area> = {}): Area {
  return {
    id: 'area-norte',
    name: 'Norte',
    code: 'NTE',
    parentId: null,
    depth: 1,
    active: true,
    responsibleIds: ['user-admin'],
    version: 3,
    createdAt: '2026-01-12T15:00:00.000Z',
    updatedAt: '2026-09-20T18:30:00.000Z',
    deactivatedAt: null,
    ...overrides,
  };
}

export function makeAreaDetail(
  overrides: Partial<Area> = {},
  counts: AreaDetail['resourceCounts'] = { vehicles: 0, people: 0 },
): AreaDetail {
  return { ...makeArea(overrides), resourceCounts: counts };
}

const CREATED = '2026-02-10T15:00:00.000Z';

const child = (
  id: string,
  name: string,
  code: string | null,
  parent: Area,
  overrides: Partial<Area> = {},
): Area =>
  makeArea({
    id,
    name,
    code,
    parentId: parent.id,
    depth: parent.depth + 1,
    responsibleIds: [],
    version: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  });

/** Thirteen areas over four levels, with one inactive area. Ids of the first level match the demo fleet. */
export function demoAreas(): Area[] {
  const norte = makeArea();
  const centro = makeArea({
    id: 'area-centro',
    name: 'Centro',
    code: 'CEN',
    responsibleIds: ['user-dispatch'],
    version: 2,
  });
  const sur = makeArea({
    id: 'area-sur',
    name: 'Sur',
    code: 'SUR',
    responsibleIds: [],
    version: 1,
  });
  const monterrey = child('area-norte-mty', 'Monterrey', 'NTE-MTY', norte, {
    responsibleIds: ['user-admin', 'user-dispatch'],
    version: 4,
  });
  const chihuahua = child('area-norte-chih', 'Chihuahua', 'NTE-CHI', norte);
  const cdmx = child('area-centro-cdmx', 'Ciudad de México', 'CEN-CDMX', centro);
  const queretaro = child('area-centro-qro', 'Querétaro', null, centro);
  const merida = child('area-sur-mer', 'Mérida', 'SUR-MER', sur);
  const apodaca = child('area-mty-apodaca', 'Base Apodaca', 'APO', monterrey, {
    responsibleIds: ['user-dispatch'],
  });
  const guadalupe = child('area-mty-guadalupe', 'Base Guadalupe', 'GPE', monterrey, {
    active: false,
    version: 5,
    deactivatedAt: '2026-08-30T17:00:00.000Z',
  });
  const cuautitlan = child('area-cdmx-cuautitlan', 'Base Cuautitlán', null, cdmx);
  const patio = child(
    'area-apodaca-patio',
    'Patio de maniobras y resguardo de unidades refrigeradas del corredor industrial',
    'APO-P1',
    apodaca,
  );
  const taller = child('area-apodaca-taller', 'Taller', 'APO-TAL', apodaca);
  return [
    norte,
    centro,
    sur,
    monterrey,
    chihuahua,
    cdmx,
    queretaro,
    merida,
    apodaca,
    guadalupe,
    cuautitlan,
    patio,
    taller,
  ];
}

export function makeHistoryEntry(overrides: Partial<AreaHistoryEntry> = {}): AreaHistoryEntry {
  return {
    id: 'hist-001',
    action: 'created',
    fields: [],
    fromParentId: null,
    toParentId: null,
    actorId: 'user-admin',
    version: 1,
    at: '2026-01-12T15:00:00.000Z',
    ...overrides,
  };
}

/** A believable history, newest first: creation, edits, a move and a deactivation/activation cycle. */
export function demoHistory(): AreaHistoryEntry[] {
  return [
    makeHistoryEntry({
      id: 'hist-006',
      action: 'activated',
      actorId: 'user-admin',
      version: 6,
      at: '2026-09-20T18:30:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-005',
      action: 'deactivated',
      actorId: 'user-admin',
      version: 5,
      at: '2026-09-18T14:10:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-004',
      action: 'updated',
      fields: ['parent'],
      fromParentId: 'area-centro',
      toParentId: 'area-norte',
      actorId: 'user-dispatch',
      version: 4,
      at: '2026-06-03T16:45:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-003',
      action: 'updated',
      fields: ['name', 'code'],
      actorId: 'user-admin',
      version: 3,
      at: '2026-04-21T09:05:00.000Z',
    }),
    makeHistoryEntry({
      id: 'hist-002',
      action: 'updated',
      fields: ['responsibles'],
      actorId: 'user-admin',
      version: 2,
      at: '2026-02-02T11:20:00.000Z',
    }),
    makeHistoryEntry({ id: 'hist-001', toParentId: 'area-centro' }),
  ];
}
