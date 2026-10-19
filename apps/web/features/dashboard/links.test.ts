import { describe, expect, it } from 'vitest';
import type { BffDashboardWidget, BffWidgetId } from '@opslog/contracts';
import { createFakeDashboard } from './fakePorts';
import { drilldownLinks, widgetNote } from './links';

const widgets = async (areaId?: string): Promise<Map<BffWidgetId, BffDashboardWidget>> => {
  const api = createFakeDashboard({ can: () => true });
  const result = await api.get(areaId ? { areaId } : {});
  if (!result.ok) throw new Error('fake failed');
  return new Map(result.value.widgets.map((w) => [w.id, w]));
};

describe('drill-down links', () => {
  it('map every widget to the URL keys each list accepts', async () => {
    const all = await widgets();
    const to = (id: BffWidgetId) =>
      drilldownLinks(all.get(id) as BffDashboardWidget).map((l) => l.to);
    expect(to('vehicles_active')).toEqual(['/flota/vehiculos?status=active']);
    expect(to('vehicles_out_of_service')).toEqual([
      '/flota/vehiculos?status=out_of_service',
      '/flota/vehiculos?status=in_maintenance',
    ]);
    expect(to('drivers_active')).toEqual(['/plantilla/empleados?kind=driver&status=active']);
    expect(to('documents_expiring')).toEqual(['/flota/documentos?status=expiring']);
    expect(to('insurance_expiring')).toEqual(['/flota/seguros?status=expiring']);
    expect(to('documents_valid_pct')).toEqual(['/flota/documentos?status=expired']);
    expect(to('maintenance_on_time')).toEqual([
      '/flota/mantenimiento?kind=preventive&status=closed',
    ]);
    expect(to('incidents_open')[0]).toMatch(/^\/incidents\?status=reported%2C/);
    expect(to('incidents_critical')[0]).toContain('severity=critical');
    expect(to('incidents_monthly')[0]).toMatch(/occurredFrom=2026-09-07&occurredTo=2026-10-06/);
  });

  it('carry the area only to the lists that filter by it, and report widgets have no link yet', async () => {
    const all = await widgets('area-1');
    const to = (id: BffWidgetId) =>
      drilldownLinks(all.get(id) as BffDashboardWidget).map((l) => l.to);
    expect(to('vehicles_active')).toEqual(['/flota/vehiculos?areaId=area-1&status=active']);
    expect(to('documents_expiring')).toEqual(['/flota/documentos?status=expiring']);
    expect(to('incidents_resolution_time')).toEqual([]);
    expect(to('maintenance_cost')).toEqual([]);
  });

  it('warns when the list a widget opens cannot filter by the chosen area', async () => {
    const all = await widgets('area-norte');
    const note = (id: BffWidgetId) => widgetNote(all.get(id) as BffDashboardWidget) ?? '';
    const warning = 'El listado no filtra por área; muestra toda la empresa.';
    for (const id of [
      'documents_expiring',
      'insurance_expiring',
      'maintenance_upcoming',
      'maintenance_on_time',
      'incidents_open',
      'incidents_critical',
      'incidents_monthly',
    ] as const)
      expect(note(id), id).toContain(warning);
    for (const id of ['vehicles_active', 'drivers_active', 'availability'] as const)
      expect(note(id), id).not.toContain(warning);
    expect(note('incidents_resolution_time')).toBe('');
    const company = await widgets();
    expect(widgetNote(company.get('documents_expiring') as BffDashboardWidget)).toBeUndefined();
  });
});
