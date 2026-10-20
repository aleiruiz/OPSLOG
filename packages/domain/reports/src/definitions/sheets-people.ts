import { dayInZone, daysBetween } from '../calendar.js';
import {
  COVERAGE_STATUS_LABELS,
  DOCUMENT_STATUS_LABELS,
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  SEVERITY_LABELS,
  SLA_STATE_LABELS,
  expiryStatus,
  label,
} from '../labels.js';
import { decimalText } from '../money.js';
import { fullName, indexBy, textFilter, vehicleLabel } from '../rows.js';
import type { ReportDefinition } from '../types.js';
import { SHEET_COLUMNS, SHEET_SORT, SheetRows, sheetFilter } from './sheet-support.js';

const RECENT = 5;
const sameKey = (a: string | null, b: string | undefined): boolean =>
  a !== null && b !== undefined && a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es');

/** FR-147 «Ficha de conductor». The license number appears only for a reader with `view_pii`. */
export const DRIVER_SHEET: ReportDefinition = {
  id: 'driver_sheet',
  family: 'workforce',
  title: 'Ficha de conductor',
  description:
    'Ficha de un conductor: datos laborales, licencia, vehículos, documentos y siniestros.',
  view: 'view',
  columns: SHEET_COLUMNS,
  filters: [sheetFilter('employee', 'Nº de empleado')],
  formats: ['pdf'],
  defaultSort: SHEET_SORT,
  async load(ctx, _needed, sources, filters) {
    const [drivers, areas] = await Promise.all([
      sources.people(ctx.tenantId, 'driver'),
      sources.areas(ctx.tenantId),
    ]);
    const key = textFilter(filters, 'employee');
    const driver = drivers.find((d) => sameKey(d.employeeNumber, key));
    if (!driver) return [];
    const [assignments, vehicles, documents, incidents] = await Promise.all([
      sources.assignments(ctx.tenantId),
      sources.vehicles(ctx.tenantId),
      sources.documents(ctx.tenantId, 'employee'),
      sources.incidents(ctx, { driverId: driver.id }),
    ]);
    // The number is read only for a reader of personal data, and only for this person.
    const license = ctx.permissions.has('view_pii')
      ? ((await sources.personPii(ctx.tenantId, [driver.id], ['licenseNumber'])).get(driver.id)
          ?.licenseNumber ?? null)
      : undefined;
    const vehicleById = indexBy(vehicles, (v) => v.id);
    const left = driver.licenseExpiresOn ? daysBetween(ctx.today, driver.licenseExpiresOn) : null;
    return new SheetRows()
      .section('Identificación', [
        ['Nombre', fullName(driver)],
        ['Nº de empleado', driver.employeeNumber],
        ['Puesto', driver.position],
        ['Área', areas.find((a) => a.id === driver.areaId)?.name],
        ['Estatus', label(EMPLOYEE_STATUS_LABELS, driver.status)],
        ['Fecha de ingreso', driver.hireDate],
      ])
      .section('Licencia', [
        ['Tipo', driver.licenseType],
        ['Vigencia', driver.licenseExpiresOn],
        ['Días restantes', left],
        ...(license === undefined ? [] : ([['Nº de licencia', license]] as const)),
      ])
      .list(
        'Vehículos asignados',
        assignments
          .filter((a) => a.employeeId === driver.id)
          .map((a) => {
            const v = vehicleById.get(a.vehicleId);
            return `${v ? vehicleLabel(v) : 'Vehículo no disponible'}, ${a.type}`;
          }),
      )
      .list(
        'Documentos',
        documents
          .filter((d) => d.ownerId === driver.id)
          .map((d) => {
            const days = d.expiresOn === null ? null : daysBetween(ctx.today, d.expiresOn);
            return `${label(EMPLOYEE_DOCUMENT_TYPE_LABELS, d.typeCode)}${d.documentNumber ? ` ${d.documentNumber}` : ''}: ${
              d.expiresOn ? `vence ${d.expiresOn}` : 'sin vencimiento'
            } (${label(DOCUMENT_STATUS_LABELS, expiryStatus(d.expiresOn, days))})`;
          }),
      )
      .list(
        `Siniestros (${incidents.length})`,
        [...incidents]
          .sort((a, b) => (b.occurredOn ?? '').localeCompare(a.occurredOn ?? ''))
          .slice(0, RECENT)
          .map(
            (i) =>
              `${i.folio}, ${i.occurredOn ?? 'sin fecha'}: ${label(INCIDENT_TYPE_LABELS, i.type)}, ${label(INCIDENT_STATUS_LABELS, i.status)}`,
          ),
      )
      .build();
  },
};

/** FR-147 «Ficha de siniestro». The amounts appear only for a reader with `incidents:view_costs`. */
export const INCIDENT_SHEET: ReportDefinition = {
  id: 'incident_sheet',
  family: 'incidents',
  title: 'Ficha de siniestro',
  description: 'Ficha de un siniestro: evento, cobertura, seguimiento, plazo y costos.',
  view: 'incidents:view',
  columns: SHEET_COLUMNS,
  filters: [sheetFilter('folio', 'Folio del siniestro')],
  formats: ['pdf'],
  defaultSort: SHEET_SORT,
  async load(ctx, _needed, sources, filters) {
    const key = textFilter(filters, 'folio');
    const incident = (await sources.incidents(ctx, {})).find((i) => sameKey(i.folio, key));
    if (!incident) return [];
    const wantsCosts = ctx.permissions.has('incidents:view_costs');
    const [vehicles, drivers, areas, slas, costs] = await Promise.all([
      sources.vehicles(ctx.tenantId),
      sources.people(ctx.tenantId, 'driver'),
      sources.areas(ctx.tenantId),
      sources.incidentSla(ctx, [incident.id]),
      wantsCosts ? sources.incidentCosts(ctx, [incident.id]) : Promise.resolve(new Map()),
    ]);
    const vehicle = vehicles.find((v) => v.id === incident.vehicleId);
    const driver = drivers.find((d) => d.id === incident.driverId);
    const sla = slas.get(incident.id);
    const day = (instant: string | null): string | null =>
      instant === null ? null : dayInZone(new Date(instant), ctx.timeZone);
    const sheet = new SheetRows()
      .section('Siniestro', [
        ['Folio', incident.folio],
        ['Tipo', label(INCIDENT_TYPE_LABELS, incident.type)],
        ['Severidad', incident.severity ? label(SEVERITY_LABELS, incident.severity) : null],
        ['Estado', label(INCIDENT_STATUS_LABELS, incident.status)],
        ['Ciclo', incident.cycle],
        ['Reaperturas', incident.reopenCount],
        ['Pérdida total', incident.totalLoss === null ? null : incident.totalLoss ? 'Sí' : 'No'],
      ])
      .section('Evento', [
        ['Fecha del evento', incident.occurredOn],
        ['Vehículo', vehicle ? vehicleLabel(vehicle) : null],
        ['Conductor', driver ? fullName(driver) : null],
        ['Área', areas.find((a) => a.id === incident.areaId)?.name],
      ])
      .section('Cobertura', [['Cobertura', label(COVERAGE_STATUS_LABELS, incident.coverageStatus)]])
      .section('Seguimiento', [
        ['Reportado', day(incident.reportedAt)],
        ['Resuelto', day(incident.resolvedAt)],
        ['Cerrado', day(incident.closedAt)],
      ])
      .section('Plazo', [
        ['Estado del plazo', sla ? label(SLA_STATE_LABELS, sla.state) : null],
        ['Plazo objetivo (días)', sla?.targetDays ?? null],
        ['Fecha límite', day(sla?.deadline ?? null)],
      ]);
    if (wantsCosts)
      for (const c of costs.get(incident.id) ?? [])
        sheet.section(`Costos en ${c.currency}`, [
          ['Reparaciones (órdenes vinculadas)', decimalText(c.repairs, c.currency)],
          ['Gastos propios', decimalText(c.expenses, c.currency)],
          ['Recuperaciones', decimalText(c.recoveries, c.currency)],
          ['A cargo de la empresa', decimalText(c.companyBorne, c.currency)],
        ]);
    return sheet.build();
  },
};
