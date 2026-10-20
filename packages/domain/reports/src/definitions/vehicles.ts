import { daysBetween, dayInZone } from '../calendar.js';
import {
  COVERAGE_LABELS,
  DOCUMENT_STATUS_LABELS,
  POLICY_STATUS_LABELS,
  VEHICLE_DOCUMENT_TYPE_LABELS,
  VEHICLE_STATUS_LABELS,
  expiryStatus,
  label,
  optionsOf,
} from '../labels.js';
import type { PolicyFact } from '../ports.js';
import {
  containsText,
  fullName,
  groupBy,
  indexBy,
  onOrAfter,
  onOrBefore,
  sameText,
} from '../rows.js';
import type { ReportDefinition, ReportFilter, Row } from '../types.js';

const vehicleLabel = (v: { economicNumber: string; plate: string }): string =>
  `${v.economicNumber} (${v.plate})`;

const AREA: ReportFilter = {
  id: 'areaId',
  label: 'Área',
  kind: 'id',
  test: (row, value) => row['_areaId'] === value,
};

const VEHICLE_STATUS: ReportFilter = {
  id: 'status',
  label: 'Estado',
  kind: 'enum',
  options: optionsOf(VEHICLE_STATUS_LABELS),
  test: (row, value) => row['_status'] === value,
};

/** Digits an ISO 4217 currency has after the point, so a minor-unit amount becomes an exact decimal. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits as number;
  } catch {
    return 2;
  }
}

/** BRD §13.1 «Inventario». The model has no vehicle type or ownership, so those filters do not exist. */
export const VEHICLE_INVENTORY: ReportDefinition = {
  id: 'vehicle_inventory',
  family: 'vehicles',
  title: 'Inventario de vehículos',
  description: 'Vehículos con su identificación, área, estado, conductor y kilometraje.',
  view: 'view',
  columns: [
    { id: 'economicNumber', label: 'Nº económico', kind: 'text' },
    { id: 'plate', label: 'Placas', kind: 'text' },
    { id: 'vin', label: 'VIN', kind: 'text' },
    { id: 'make', label: 'Marca', kind: 'text' },
    { id: 'model', label: 'Modelo', kind: 'text' },
    { id: 'year', label: 'Año', kind: 'integer' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'driver', label: 'Conductor', kind: 'text' },
    { id: 'odometerKm', label: 'Kilometraje (km)', kind: 'integer' },
    { id: 'registeredOn', label: 'Fecha de alta', kind: 'date' },
  ],
  filters: [
    AREA,
    VEHICLE_STATUS,
    {
      id: 'make',
      label: 'Marca',
      kind: 'text',
      test: (row, value) => sameText(row['make'], value),
    },
    {
      id: 'yearFrom',
      label: 'Año desde',
      kind: 'number',
      test: (row, value) => typeof row['year'] === 'number' && row['year'] >= (value as number),
    },
    {
      id: 'yearTo',
      label: 'Año hasta',
      kind: 'number',
      test: (row, value) => typeof row['year'] === 'number' && row['year'] <= (value as number),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'economicNumber', direction: 'asc' },
  async load(ctx, _needed, sources) {
    const [vehicles, areas, assignments, drivers] = await Promise.all([
      sources.vehicles(ctx.tenantId),
      sources.areas(ctx.tenantId),
      sources.assignments(ctx.tenantId),
      sources.people(ctx.tenantId, 'driver'),
    ]);
    const areaById = indexBy(areas, (a) => a.id);
    const driverById = indexBy(drivers, (d) => d.id);
    const byVehicle = groupBy(assignments, (a) => a.vehicleId);
    return vehicles.map((v): Row => {
      // The principal driver; a vehicle with only secondary or temporary drivers shows the first of them.
      const current = byVehicle.get(v.id) ?? [];
      const chosen = current.find((a) => a.type === 'principal') ?? current[0];
      const driver = chosen ? driverById.get(chosen.employeeId) : undefined;
      return {
        economicNumber: v.economicNumber,
        plate: v.plate,
        vin: v.vin,
        make: v.make,
        model: v.model,
        year: v.year,
        area: areaById.get(v.areaId)?.name ?? null,
        status: label(VEHICLE_STATUS_LABELS, v.status),
        driver: driver ? fullName(driver) : null,
        odometerKm: v.odometerKm,
        registeredOn: v.registeredOn,
        _areaId: v.areaId,
        _status: v.status,
      };
    });
  },
};

/** BRD §13.1 «Estado de flota»: how long each vehicle has been in its state, counted in the company's zone. */
export const FLEET_STATUS: ReportDefinition = {
  id: 'fleet_status',
  family: 'vehicles',
  title: 'Estado de flota',
  description: 'Estado actual de cada vehículo, su motivo y los días que lleva en él.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'reason', label: 'Motivo', kind: 'text' },
    { id: 'since', label: 'Desde', kind: 'date' },
    { id: 'daysInState', label: 'Días en estado', kind: 'integer' },
  ],
  filters: [
    AREA,
    VEHICLE_STATUS,
    {
      id: 'reason',
      label: 'Motivo (contiene)',
      kind: 'text',
      test: (row, value) => containsText(row['reason'], value),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'daysInState', direction: 'desc' },
  async load(ctx, _needed, sources) {
    const [vehicles, areas] = await Promise.all([
      sources.vehicles(ctx.tenantId),
      sources.areas(ctx.tenantId),
    ]);
    const since = await sources.statusSince(
      ctx.tenantId,
      vehicles.map((v) => v.id),
    );
    const areaById = indexBy(areas, (a) => a.id);
    return vehicles.map((v): Row => {
      const instant = since.get(v.id);
      const day = instant === undefined ? null : dayInZone(new Date(instant), ctx.timeZone);
      return {
        vehicle: vehicleLabel(v),
        area: areaById.get(v.areaId)?.name ?? null,
        status: label(VEHICLE_STATUS_LABELS, v.status),
        reason: v.statusReason === '' ? null : v.statusReason,
        since: day,
        daysInState: day === null ? null : Math.max(0, daysBetween(day, ctx.today)),
        _areaId: v.areaId,
        _status: v.status,
      };
    });
  },
};

function deductibleCells(policy: PolicyFact): Row {
  const d = policy.deductible;
  if (!d) return { deductible: null, deductibleCurrency: null, deductiblePercent: null };
  if (d.kind === 'percent')
    return { deductible: null, deductibleCurrency: null, deductiblePercent: d.basisPoints / 100 };
  return {
    deductible: d.amountMinor / 10 ** currencyDigits(d.currency),
    deductibleCurrency: d.currency,
    deductiblePercent: null,
  };
}

/** BRD §13.1 «Seguros». The deductible is financial data (`view_costs`), by amount and currency or by percentage. */
export const INSURANCE: ReportDefinition = {
  id: 'insurance',
  family: 'vehicles',
  title: 'Seguros',
  description: 'Pólizas vigentes de la flota con su cobertura, vigencia y días restantes.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'insurer', label: 'Aseguradora', kind: 'text' },
    { id: 'policyNumber', label: 'Nº de póliza', kind: 'text' },
    { id: 'coverage', label: 'Cobertura', kind: 'text' },
    { id: 'startsOn', label: 'Inicio', kind: 'date' },
    { id: 'endsOn', label: 'Fin', kind: 'date' },
    { id: 'deductible', label: 'Deducible', kind: 'number', sensitivity: 'costs' },
    { id: 'deductibleCurrency', label: 'Moneda del deducible', kind: 'text', sensitivity: 'costs' },
    { id: 'deductiblePercent', label: 'Deducible (%)', kind: 'number', sensitivity: 'costs' },
    { id: 'daysLeft', label: 'Días restantes', kind: 'integer' },
    { id: 'status', label: 'Estado de póliza', kind: 'text' },
  ],
  filters: [
    AREA,
    {
      id: 'insurer',
      label: 'Aseguradora (contiene)',
      kind: 'text',
      test: (row, value) => containsText(row['insurer'], value),
    },
    {
      id: 'endsFrom',
      label: 'Vigencia hasta desde',
      kind: 'date',
      test: (row, value) => onOrAfter(row['endsOn'], value),
    },
    {
      id: 'endsTo',
      label: 'Vigencia hasta el',
      kind: 'date',
      test: (row, value) => onOrBefore(row['endsOn'], value),
    },
    {
      id: 'status',
      label: 'Estado de póliza',
      kind: 'enum',
      options: optionsOf(POLICY_STATUS_LABELS),
      test: (row, value) => row['_status'] === value,
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'endsOn', direction: 'asc' },
  async load(ctx, needed, sources) {
    const withDeductible = ['deductible', 'deductibleCurrency', 'deductiblePercent'].some((id) =>
      needed.has(id),
    );
    const [policies, vehicles, areas] = await Promise.all([
      sources.policies(ctx.tenantId, withDeductible),
      sources.vehicles(ctx.tenantId),
      sources.areas(ctx.tenantId),
    ]);
    const vehicleById = indexBy(vehicles, (v) => v.id);
    const areaById = indexBy(areas, (a) => a.id);
    const rows: Row[] = [];
    for (const policy of policies) {
      const vehicle = vehicleById.get(policy.vehicleId);
      if (!vehicle) continue;
      const daysLeft = daysBetween(ctx.today, policy.endsOn);
      const status = expiryStatus(policy.endsOn, daysLeft);
      rows.push({
        vehicle: vehicleLabel(vehicle),
        area: areaById.get(vehicle.areaId)?.name ?? null,
        insurer: policy.insurer,
        policyNumber: policy.policyNumber,
        coverage: label(COVERAGE_LABELS, policy.coverageType),
        startsOn: policy.startsOn,
        endsOn: policy.endsOn,
        ...(withDeductible
          ? deductibleCells(policy)
          : { deductible: null, deductibleCurrency: null, deductiblePercent: null }),
        daysLeft,
        status: label(POLICY_STATUS_LABELS, status),
        _areaId: vehicle.areaId,
        _status: status,
      });
    }
    return rows;
  },
};

/** BRD §13.1 «Documentación» de vehículos; also a PDF (FR-147). */
export const VEHICLE_DOCUMENTS: ReportDefinition = {
  id: 'vehicle_documents',
  family: 'vehicles',
  title: 'Documentación de vehículos',
  description: 'Documentos de la flota con su vencimiento, estado y días restantes.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'document', label: 'Documento', kind: 'text' },
    { id: 'documentNumber', label: 'Nº de documento', kind: 'text' },
    { id: 'issuedOn', label: 'Emisión', kind: 'date' },
    { id: 'expiresOn', label: 'Vencimiento', kind: 'date' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'daysLeft', label: 'Días restantes', kind: 'integer' },
  ],
  filters: [
    AREA,
    {
      id: 'typeCode',
      label: 'Tipo de documento',
      kind: 'enum',
      options: optionsOf(VEHICLE_DOCUMENT_TYPE_LABELS),
      test: (row, value) => row['_typeCode'] === value,
    },
    {
      id: 'status',
      label: 'Estado',
      kind: 'enum',
      options: optionsOf(DOCUMENT_STATUS_LABELS),
      test: (row, value) => row['_status'] === value,
    },
  ],
  formats: ['csv', 'xlsx', 'pdf'],
  defaultSort: { column: 'expiresOn', direction: 'asc' },
  async load(ctx, _needed, sources) {
    const [documents, vehicles, areas] = await Promise.all([
      sources.documents(ctx.tenantId, 'vehicle'),
      sources.vehicles(ctx.tenantId),
      sources.areas(ctx.tenantId),
    ]);
    const vehicleById = indexBy(vehicles, (v) => v.id);
    const areaById = indexBy(areas, (a) => a.id);
    const rows: Row[] = [];
    for (const document of documents) {
      const vehicle = vehicleById.get(document.ownerId);
      if (!vehicle) continue;
      const daysLeft =
        document.expiresOn === null ? null : daysBetween(ctx.today, document.expiresOn);
      const status = expiryStatus(document.expiresOn, daysLeft);
      rows.push({
        vehicle: vehicleLabel(vehicle),
        area: areaById.get(vehicle.areaId)?.name ?? null,
        document: label(VEHICLE_DOCUMENT_TYPE_LABELS, document.typeCode),
        documentNumber: document.documentNumber,
        issuedOn: document.issuedOn,
        expiresOn: document.expiresOn,
        status: label(DOCUMENT_STATUS_LABELS, status),
        daysLeft,
        _areaId: vehicle.areaId,
        _typeCode: document.typeCode,
        _status: status,
      });
    }
    return rows;
  },
};
