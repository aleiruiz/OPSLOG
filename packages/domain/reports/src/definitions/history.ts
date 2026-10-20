import { dayInZone } from '../calendar.js';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  VEHICLE_DOCUMENT_TYPE_LABELS,
  VEHICLE_STATUS_LABELS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_STATUS_LABELS,
  label,
} from '../labels.js';
import { moneyText } from '../money.js';
import type { ReportSources, VehicleFact } from '../ports.js';
import { APPLIED, fullName, indexBy, textFilter } from '../rows.js';
import type { ReportContext, ReportDefinition, ReportFilter, Row } from '../types.js';

/** The vehicle a sheet or history names by economic number or plates (exact, ignoring case). */
export function matchVehicle(
  vehicles: readonly VehicleFact[],
  key: string | undefined,
): VehicleFact | undefined {
  if (key === undefined) return undefined;
  const wanted = key.toLocaleLowerCase('es');
  return vehicles.find(
    (v) =>
      v.economicNumber.toLocaleLowerCase('es') === wanted ||
      v.plate.toLocaleLowerCase('es') === wanted,
  );
}

export const VEHICLE_KEY_FILTER: ReportFilter = {
  id: 'vehicle',
  label: 'Nº económico o placas',
  kind: 'text',
  required: true,
  test: APPLIED,
};

const ASSIGNMENT_LABELS: Readonly<Record<string, string>> = {
  principal: 'Principal',
  secondary: 'Secundaria',
  temporary: 'Temporal',
};

interface Event {
  readonly date: string | null;
  readonly source: string;
  readonly event: string;
  readonly detail?: string | null;
  readonly maintenanceCost?: string | null;
  readonly incidentCost?: string | null;
}

/**
 * BRD §13.1 «Historial de vehículo»: one timeline built from every module through its ports. Costs
 * of orders and of cases come only with the permission that protects each; names of people are the
 * only personal data and the license number never appears.
 */
export const VEHICLE_HISTORY: ReportDefinition = {
  id: 'vehicle_history',
  family: 'vehicles',
  title: 'Historial de vehículo',
  description:
    'Línea de tiempo de un vehículo: alta, estados, asignaciones, documentos, pólizas, mantenimiento y siniestros.',
  view: 'view',
  columns: [
    { id: 'date', label: 'Fecha', kind: 'date' },
    { id: 'source', label: 'Origen', kind: 'text' },
    { id: 'event', label: 'Evento', kind: 'text' },
    { id: 'detail', label: 'Detalle', kind: 'text' },
    { id: 'maintenanceCost', label: 'Costo de mantenimiento', kind: 'text', sensitivity: 'costs' },
    {
      id: 'incidentCost',
      label: 'Costo del siniestro',
      kind: 'text',
      sensitivity: 'incident_costs',
    },
  ],
  filters: [VEHICLE_KEY_FILTER],
  formats: ['pdf', 'csv', 'xlsx'],
  defaultSort: { column: 'date', direction: 'asc' },
  async load(ctx, needed, sources, filters) {
    const vehicle = matchVehicle(
      await sources.vehicles(ctx.tenantId),
      textFilter(filters, 'vehicle'),
    );
    if (!vehicle) return [];
    const events = await timeline(ctx, needed, sources, vehicle);
    return events.map(
      (e): Row => ({
        date: e.date,
        source: e.source,
        event: e.event,
        detail: e.detail ?? null,
        maintenanceCost: e.maintenanceCost ?? null,
        incidentCost: e.incidentCost ?? null,
      }),
    );
  },
};

async function timeline(
  ctx: ReportContext,
  needed: ReadonlySet<string>,
  sources: ReportSources,
  vehicle: VehicleFact,
): Promise<Event[]> {
  const [changes, assignments, drivers, documents, policies, orders, incidents] = await Promise.all(
    [
      sources.statusHistory(ctx.tenantId, vehicle.id),
      sources.assignmentHistory(ctx.tenantId, { vehicleId: vehicle.id }),
      sources.people(ctx.tenantId, 'driver'),
      sources.documents(ctx.tenantId, 'vehicle'),
      sources.policies(ctx.tenantId, false),
      sources.workOrders(ctx, { vehicleId: vehicle.id, withCosts: needed.has('maintenanceCost') }),
      sources.incidents(ctx, { vehicleId: vehicle.id }),
    ],
  );
  const costs = needed.has('incidentCost')
    ? await sources.incidentCosts(
        ctx,
        incidents.map((i) => i.id),
      )
    : new Map();
  const driverById = indexBy(drivers, (d) => d.id);
  const day = (instant: string): string => dayInZone(new Date(instant), ctx.timeZone);
  const events: Event[] = [
    {
      date: vehicle.registeredOn,
      source: 'Vehículo',
      event: 'Alta en la flota',
      detail: `${vehicle.make} ${vehicle.model} ${vehicle.year}`,
    },
  ];
  for (const change of changes)
    events.push({
      date: day(change.at),
      source: 'Estado',
      event: 'Cambio de estado',
      detail: label(VEHICLE_STATUS_LABELS, change.to),
    });
  for (const a of assignments) {
    const driver = driverById.get(a.employeeId);
    const who = `${label(ASSIGNMENT_LABELS, a.type)}: ${driver ? fullName(driver) : 'Conductor no disponible'}`;
    events.push({ date: day(a.startedAt), source: 'Asignación', event: 'Asignación', detail: who });
    if (a.endedAt)
      events.push({
        date: day(a.endedAt),
        source: 'Asignación',
        event: 'Fin de asignación',
        detail: who,
      });
  }
  for (const d of documents.filter((doc) => doc.ownerId === vehicle.id)) {
    const name = `${label(VEHICLE_DOCUMENT_TYPE_LABELS, d.typeCode)}${d.documentNumber ? ` ${d.documentNumber}` : ''}`;
    events.push({
      date: d.issuedOn,
      source: 'Documento',
      event: 'Documento emitido',
      detail: name,
    });
    events.push({
      date: d.expiresOn,
      source: 'Documento',
      event: 'Vencimiento de documento',
      detail: name,
    });
  }
  for (const p of policies.filter((policy) => policy.vehicleId === vehicle.id)) {
    const name = `${p.insurer} ${p.policyNumber}`;
    events.push({ date: p.startsOn, source: 'Póliza', event: 'Inicio de póliza', detail: name });
    events.push({ date: p.endsOn, source: 'Póliza', event: 'Fin de póliza', detail: name });
  }
  for (const o of orders)
    events.push({
      date: o.actualDate ?? o.scheduledDate ?? day(o.createdAt),
      source: 'Mantenimiento',
      event: `Orden ${label(WORK_ORDER_KIND_LABELS, o.kind).toLocaleLowerCase('es')}`,
      detail: [label(WORK_ORDER_STATUS_LABELS, o.status), o.workshop].filter(Boolean).join(', '),
      maintenanceCost: moneyText(o.costs ?? []),
    });
  for (const i of incidents)
    events.push({
      date: i.occurredOn,
      source: 'Siniestro',
      event: `Siniestro ${i.folio}`,
      detail: `${label(INCIDENT_TYPE_LABELS, i.type)}, ${label(INCIDENT_STATUS_LABELS, i.status)}`,
      incidentCost: moneyText(
        (costs.get(i.id) ?? []).map((c: { currency: string; companyBorne: string }) => ({
          currency: c.currency,
          amountMinor: c.companyBorne,
        })),
      ),
    });
  return events.filter((e) => e.date !== null);
}
