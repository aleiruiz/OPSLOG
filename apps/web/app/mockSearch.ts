import type { BffSearchGroup, BffSearchHit } from '@opslog/contracts';
import type { SearchPorts } from '../features/search/ports';
import { ok } from './mockApiErrors';
import type { Guarded } from './mockApiTypes';
import type { MockEmployeeStore } from './mockEmployees';
import type { MockVehicleStore } from './mockVehicles';

/** Same folding as the server: lowercase, no accents, hyphens, spaces or dots. */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s.-]/g, '');

const group = (
  type: BffSearchGroup['type'],
  q: string,
  rows: readonly { hit: BffSearchHit; text: string }[],
): BffSearchGroup[] => {
  const found = rows.filter((row) => fold(row.text).includes(q));
  return found.length === 0
    ? []
    : [{ type, total: found.length, items: found.slice(0, 10).map((row) => row.hit) }];
};

/** Search over the vehicles and people of the mock stores; any signed-in user may search. */
export function createMockSearchPorts(
  guarded: Guarded,
  fleet: MockVehicleStore,
  staff: MockEmployeeStore,
): SearchPorts {
  return {
    query: (raw) =>
      guarded('search', 'view', async () => {
        const q = fold(raw);
        if (q.length < 2) return ok({ groups: [] });
        const vehicles = await fleet.port.list({ limit: 100 });
        const people = await staff.port.list({ limit: 100 });
        const groups: BffSearchGroup[] = vehicles.ok
          ? group(
              'vehicle',
              q,
              vehicles.value.items.map((v) => ({
                hit: {
                  id: v.id,
                  label: `${v.economicNumber} · ${v.plate}`,
                  href: `/flota/vehiculos/${v.id}`,
                },
                text: `${v.economicNumber} ${v.plate}`,
              })),
            )
          : [];
        if (people.ok) {
          for (const kind of ['driver', 'dispatcher'] as const)
            groups.push(
              ...group(
                kind,
                q,
                people.value.items
                  .filter((e) => e.kind === kind)
                  .map((e) => ({
                    hit: {
                      id: e.id,
                      label: `${e.firstName} ${e.lastName}`,
                      href: `/plantilla/empleados/${e.id}`,
                    },
                    text: `${e.firstName} ${e.lastName} ${e.employeeNumber ?? ''}`,
                  })),
              ),
            );
        }
        return ok({ groups });
      }),
  };
}
