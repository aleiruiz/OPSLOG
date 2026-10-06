import type { StatusTone } from '@opslog/ui';
import type { Area, AreaHistoryEntry } from '../app/types';

export { formatDateTime } from '../vehicles/labels';

export const areaStatus = (area: Pick<Area, 'active'>): { label: string; tone: StatusTone } =>
  area.active ? { label: 'Activa', tone: 'success' } : { label: 'Inactiva', tone: 'neutral' };

const fieldLabels: Record<string, string> = {
  name: 'nombre',
  code: 'código',
  parent: 'área superior',
  responsibles: 'responsables',
};

const list = (items: readonly string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : (items[0] ?? '');

export const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** One line for a history row. Only field names and opaque ids exist in the data: names come from the loaded tree. */
export function describeHistory(
  entry: AreaHistoryEntry,
  nameOf: (areaId: string) => string | null,
): string {
  const place = (id: string | null) =>
    id === null ? 'el nivel raíz' : `«${nameOf(id) ?? 'otra área'}»`;
  switch (entry.action) {
    case 'created':
      return entry.toParentId === null
        ? 'Área creada en el nivel raíz'
        : `Área creada dentro de ${place(entry.toParentId)}`;
    case 'activated':
      return 'Área activada';
    case 'deactivated':
      return 'Área desactivada';
    case 'updated': {
      const others = entry.fields.filter((field) => field !== 'parent').map((f) => fieldLabels[f] ?? f);
      const moved = entry.fields.includes('parent')
        ? `Movida de ${place(entry.fromParentId)} a ${place(entry.toParentId)}`
        : null;
      if (moved) return others.length > 0 ? `${moved}; también cambió ${list(others)}` : moved;
      return others.length > 0 ? `Datos modificados: ${list(others)}` : 'Datos modificados';
    }
  }
}
