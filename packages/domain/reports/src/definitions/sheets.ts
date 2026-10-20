import { daysBetween } from '../calendar.js';
import {
  COVERAGE_LABELS,
  DOCUMENT_STATUS_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  VEHICLE_DOCUMENT_TYPE_LABELS,
  VEHICLE_STATUS_LABELS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_STATUS_LABELS,
  expiryStatus,
  label,
} from '../labels.js';
import { dayInZone } from '../calendar.js';
import { moneyText } from '../money.js';
import { fullName, groupDigits, indexBy, textFilter } from '../rows.js';
import type { DocumentFact } from '../ports.js';
import type { ReportDefinition } from '../types.js';
import { matchVehicle } from './history.js';
import { SHEET_COLUMNS, SHEET_SORT, SheetRows, sheetFilter } from './sheet-support.js';

const RECENT = 5;

const documentLine = (
  d: DocumentFact,
  names: Readonly<Record<string, string>>,
  today: string,
): string => {
  const days = d.expiresOn === null ? null : daysBetween(today, d.expiresOn);
  const status = label(DOCUMENT_STATUS_LABELS, expiryStatus(d.expiresOn, days));
  return `${label(names, d.typeCode)}${d.documentNumber ? ` ${d.documentNumber}` : ''}: ${
    d.expiresOn ? `vence ${d.expiresOn}` : 'sin vencimiento'
  } (${status})`;
};

const deductibleText = (
  d:
    | { kind: string; amountMinor?: number; currency?: string; basisPoints?: number }
    | null
    | undefined,
): string | null => {
  if (!d) return null;
  if (d.kind === 'percent') return `${(d.basisPoints ?? 0) / 100} %`;
  return moneyText([{ amountMinor: String(d.amountMinor ?? 0), currency: d.currency ?? 'MXN' }]);
};

/** FR-147 «Ficha de vehículo»: identification, drivers, documents, policies and recent work, as a PDF. */
export const VEHICLE_SHEET: ReportDefinition = {
  id: 'vehicle_sheet',
  family: 'vehicles',
  title: 'Ficha de vehículo',
  description:
    'Ficha de un vehículo: identificación, conductores, documentos, seguros, mantenimiento y siniestros.',
  view: 'view',
  columns: SHEET_COLUMNS,
  filters: [sheetFilter('vehicle', 'Nº económico o placas')],
  formats: ['pdf'],
  defaultSort: SHEET_SORT,
  async load(ctx, _needed, sources, filters) {
    const [vehicles, areas] = await Promise.all([
      sources.vehicles(ctx.tenantId),
      sources.areas(ctx.tenantId),
    ]);
    const v = matchVehicle(vehicles, textFilter(filters, 'vehicle'));
    if (!v) return [];
    const money = ctx.permissions.has('view_costs');
    const [assignments, drivers, documents, policies, orders, incidents] = await Promise.all([
      sources.assignments(ctx.tenantId),
      sources.people(ctx.tenantId, 'driver'),
      sources.documents(ctx.tenantId, 'vehicle'),
      sources.policies(ctx.tenantId, money),
      sources.workOrders(ctx, { vehicleId: v.id, withCosts: money }),
      sources.incidents(ctx, { vehicleId: v.id }),
    ]);
    const costs = ctx.permissions.has('incidents:view_costs')
      ? await sources.incidentCosts(
          ctx,
          incidents.map((i) => i.id),
        )
      : new Map();
    const driverById = indexBy(drivers, (d) => d.id);
    const day = (instant: string): string => dayInZone(new Date(instant), ctx.timeZone);
    return new SheetRows()
      .section('Identificación', [
        ['Nº económico', v.economicNumber],
        ['Placas', v.plate],
        ['VIN', v.vin],
        ['Marca y modelo', `${v.make} ${v.model}`],
        ['Año', v.year],
        ['Área', areas.find((a) => a.id === v.areaId)?.name],
        ['Estado', label(VEHICLE_STATUS_LABELS, v.status)],
        ['Motivo del estado', v.statusReason],
        ['Kilometraje (km)', groupDigits(v.odometerKm)],
        ['Fecha de alta', v.registeredOn],
      ])
      .list(
        'Conductores asignados',
        assignments
          .filter((a) => a.vehicleId === v.id)
          .map((a) => {
            const d = driverById.get(a.employeeId);
            return `${a.type}: ${d ? fullName(d) : 'Conductor no disponible'}`;
          }),
      )
      .list(
        'Documentos',
        documents
          .filter((d) => d.ownerId === v.id)
          .map((d) => documentLine(d, VEHICLE_DOCUMENT_TYPE_LABELS, ctx.today)),
      )
      .list(
        'Seguros',
        policies
          .filter((p) => p.vehicleId === v.id)
          .map((p) => {
            const base = `${p.insurer} ${p.policyNumber}, ${label(COVERAGE_LABELS, p.coverageType)}, ${p.startsOn} a ${p.endsOn}`;
            const deductible = money ? deductibleText(p.deductible) : null;
            return deductible ? `${base}, deducible ${deductible}` : base;
          }),
      )
      .list(
        'Mantenimiento reciente',
        orders
          .filter((o) => o.status !== 'cancelled')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, RECENT)
          .map((o) => {
            const cost = money ? moneyText(o.costs ?? []) : null;
            return `${o.actualDate ?? o.scheduledDate ?? day(o.createdAt)}: ${label(WORK_ORDER_KIND_LABELS, o.kind)}, ${label(WORK_ORDER_STATUS_LABELS, o.status)}${cost ? `, ${cost}` : ''}`;
          }),
      )
      .list(
        `Siniestros (${incidents.length})`,
        [...incidents]
          .sort((a, b) => (b.occurredOn ?? '').localeCompare(a.occurredOn ?? ''))
          .slice(0, RECENT)
          .map((i) => {
            const cost = moneyText(
              (costs.get(i.id) ?? []).map((c: { currency: string; companyBorne: string }) => ({
                currency: c.currency,
                amountMinor: c.companyBorne,
              })),
            );
            return `${i.folio}, ${i.occurredOn ?? 'sin fecha'}: ${label(INCIDENT_TYPE_LABELS, i.type)}, ${label(INCIDENT_STATUS_LABELS, i.status)}${cost ? `, a cargo ${cost}` : ''}`;
          }),
      )
      .build();
  },
};
