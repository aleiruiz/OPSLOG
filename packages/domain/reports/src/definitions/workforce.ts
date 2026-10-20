import { daysBetween } from '../calendar.js';
import {
  DOCUMENT_STATUS_LABELS,
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  PERSON_KIND_LABELS,
  expiryStatus,
  label,
  optionsOf,
} from '../labels.js';
import type { PersonFact, PiiField, ReportSources } from '../ports.js';
import { fullName, groupBy, indexBy, onOrAfter, onOrBefore, sameText } from '../rows.js';
import type { ReportColumn, ReportContext, ReportDefinition, ReportFilter, Row } from '../types.js';

const AREA_FILTER = (field: string): ReportFilter => ({
  id: 'areaId',
  label: 'Área',
  kind: 'id',
  test: (row, value) => row[field] === value,
});

const STATUS_FILTER: ReportFilter = {
  id: 'status',
  label: 'Estatus',
  kind: 'enum',
  options: optionsOf(EMPLOYEE_STATUS_LABELS),
  test: (row, value) => row['_status'] === value,
};

const areaNames = async (sources: ReportSources, tenantId: string) =>
  indexBy(await sources.areas(tenantId), (area) => area.id);

/** Unsealed personal data, read only for the selected sensitive columns the reader may see. */
async function pii(
  ctx: ReportContext,
  needed: ReadonlySet<string>,
  sources: ReportSources,
  people: readonly PersonFact[],
  map: Readonly<Record<string, PiiField>>,
) {
  const fields = Object.entries(map)
    .filter(([column]) => needed.has(column))
    .map(([, field]) => field);
  if (fields.length === 0 || people.length === 0) return new Map();
  return sources.personPii(
    ctx.tenantId,
    people.map((p) => p.id),
    fields,
  );
}

const DRIVER_COLUMNS: readonly ReportColumn[] = [
  { id: 'name', label: 'Nombre', kind: 'text' },
  { id: 'employeeNumber', label: 'Nº de empleado', kind: 'text' },
  { id: 'area', label: 'Área', kind: 'text' },
  { id: 'position', label: 'Puesto', kind: 'text' },
  { id: 'status', label: 'Estatus', kind: 'text' },
  { id: 'licenseType', label: 'Tipo de licencia', kind: 'text' },
  { id: 'licenseNumber', label: 'Nº de licencia', kind: 'text', sensitivity: 'pii' },
  { id: 'licenseExpiresOn', label: 'Vigencia de licencia', kind: 'date' },
  { id: 'vehicle', label: 'Vehículo asignado', kind: 'text' },
  { id: 'expiredDocuments', label: 'Documentos vencidos', kind: 'integer' },
  { id: 'hireDate', label: 'Fecha de ingreso', kind: 'date', defaultVisible: false },
];

/** BRD §13.1 «Conductores». The license number is personal data (`view_pii`). */
export const DRIVERS: ReportDefinition = {
  id: 'drivers',
  family: 'workforce',
  title: 'Conductores',
  description: 'Plantilla de conductores con licencia, vehículo asignado y documentos vencidos.',
  view: 'view',
  columns: DRIVER_COLUMNS,
  filters: [
    AREA_FILTER('_areaId'),
    STATUS_FILTER,
    {
      id: 'licenseType',
      label: 'Tipo de licencia',
      kind: 'text',
      test: (row, value) => sameText(row['licenseType'], value),
    },
    {
      id: 'licenseFrom',
      label: 'Vigencia de licencia desde',
      kind: 'date',
      test: (row, value) => onOrAfter(row['licenseExpiresOn'], value),
    },
    {
      id: 'licenseTo',
      label: 'Vigencia de licencia hasta',
      kind: 'date',
      test: (row, value) => onOrBefore(row['licenseExpiresOn'], value),
    },
    {
      id: 'hasVehicle',
      label: 'Con vehículo asignado',
      kind: 'enum',
      options: [
        { value: 'yes', label: 'Sí' },
        { value: 'no', label: 'No' },
      ],
      test: (row, value) => (row['_vehicles'] === 0) === (value === 'no'),
    },
    {
      id: 'hiredFrom',
      label: 'Ingreso desde',
      kind: 'date',
      test: (row, value) => onOrAfter(row['hireDate'], value),
    },
    {
      id: 'hiredTo',
      label: 'Ingreso hasta',
      kind: 'date',
      test: (row, value) => onOrBefore(row['hireDate'], value),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'name', direction: 'asc' },
  async load(ctx, needed, sources) {
    const [people, areas, assignments, documents, vehicles] = await Promise.all([
      sources.people(ctx.tenantId, 'driver'),
      areaNames(sources, ctx.tenantId),
      sources.assignments(ctx.tenantId),
      sources.documents(ctx.tenantId, 'employee'),
      sources.vehicles(ctx.tenantId),
    ]);
    const secrets = await pii(ctx, needed, sources, people, { licenseNumber: 'licenseNumber' });
    const vehicleById = indexBy(vehicles, (v) => v.id);
    const byDriver = groupBy(assignments, (a) => a.employeeId);
    const expired = new Map<string, number>();
    for (const document of documents)
      if (document.expiresOn !== null && daysBetween(ctx.today, document.expiresOn) < 0)
        expired.set(document.ownerId, (expired.get(document.ownerId) ?? 0) + 1);
    return people.map((person): Row => {
      const assigned = (byDriver.get(person.id) ?? [])
        .map((a) => vehicleById.get(a.vehicleId)?.economicNumber)
        .filter((n): n is string => n !== undefined);
      return {
        name: fullName(person),
        employeeNumber: person.employeeNumber,
        area: areas.get(person.areaId)?.name ?? null,
        position: person.position,
        status: label(EMPLOYEE_STATUS_LABELS, person.status),
        licenseType: person.licenseType,
        licenseNumber: secrets.get(person.id)?.licenseNumber ?? null,
        licenseExpiresOn: person.licenseExpiresOn,
        vehicle: assigned.length > 0 ? assigned.join(', ') : null,
        expiredDocuments: expired.get(person.id) ?? 0,
        hireDate: person.hireDate,
        _areaId: person.areaId,
        _status: person.status,
        _vehicles: assigned.length,
      };
    });
  },
};

/** BRD §13.1 «Despachadores». Contact data is personal data (`view_pii`); the model has no shift or supervisor. */
export const DISPATCHERS: ReportDefinition = {
  id: 'dispatchers',
  family: 'workforce',
  title: 'Despachadores',
  description: 'Plantilla de despachadores con su área, puesto y contacto.',
  view: 'view',
  columns: [
    { id: 'name', label: 'Nombre', kind: 'text' },
    { id: 'employeeNumber', label: 'Nº de empleado', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'position', label: 'Puesto', kind: 'text' },
    { id: 'status', label: 'Estatus', kind: 'text' },
    { id: 'phone', label: 'Teléfono', kind: 'text', sensitivity: 'pii' },
    { id: 'email', label: 'Correo electrónico', kind: 'text', sensitivity: 'pii' },
  ],
  filters: [AREA_FILTER('_areaId'), STATUS_FILTER],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'name', direction: 'asc' },
  async load(ctx, needed, sources) {
    const [people, areas] = await Promise.all([
      sources.people(ctx.tenantId, 'dispatcher'),
      areaNames(sources, ctx.tenantId),
    ]);
    const secrets = await pii(ctx, needed, sources, people, { phone: 'phone', email: 'email' });
    return people.map(
      (person): Row => ({
        name: fullName(person),
        employeeNumber: person.employeeNumber,
        area: areas.get(person.areaId)?.name ?? null,
        position: person.position,
        status: label(EMPLOYEE_STATUS_LABELS, person.status),
        phone: secrets.get(person.id)?.phone ?? null,
        email: secrets.get(person.id)?.email ?? null,
        _areaId: person.areaId,
        _status: person.status,
      }),
    );
  },
};

/** BRD §13.1 «Áreas»: the tree with the people and vehicles that still count for each (BR-021). */
export const AREAS: ReportDefinition = {
  id: 'areas',
  family: 'workforce',
  title: 'Áreas',
  description: 'Áreas de la empresa con su área padre, responsables, conductores y vehículos.',
  view: 'view',
  columns: [
    { id: 'name', label: 'Área', kind: 'text' },
    { id: 'code', label: 'Código', kind: 'text' },
    { id: 'parent', label: 'Área padre', kind: 'text' },
    { id: 'responsibles', label: 'Responsables', kind: 'integer' },
    { id: 'drivers', label: 'Conductores', kind: 'integer' },
    { id: 'vehicles', label: 'Vehículos', kind: 'integer' },
    { id: 'state', label: 'Estado', kind: 'text' },
  ],
  filters: [
    {
      id: 'active',
      label: 'Estado',
      kind: 'enum',
      options: [
        { value: 'active', label: 'Activa' },
        { value: 'inactive', label: 'Inactiva' },
      ],
      test: (row, value) => (row['_active'] === 1) === (value === 'active'),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'name', direction: 'asc' },
  async load(ctx, _needed, sources) {
    const [areas, drivers, vehicles] = await Promise.all([
      sources.areas(ctx.tenantId),
      sources.people(ctx.tenantId, 'driver'),
      sources.vehicles(ctx.tenantId),
    ]);
    const byId = indexBy(areas, (a) => a.id);
    const liveDrivers = groupBy(
      drivers.filter((d) => d.status !== 'terminated'),
      (d) => d.areaId,
    );
    const liveVehicles = groupBy(
      vehicles.filter((v) => v.status !== 'decommissioned'),
      (v) => v.areaId,
    );
    return areas.map(
      (area): Row => ({
        name: area.name,
        code: area.code,
        parent: area.parentId === null ? null : (byId.get(area.parentId)?.name ?? null),
        responsibles: area.responsibleCount,
        drivers: liveDrivers.get(area.id)?.length ?? 0,
        vehicles: liveVehicles.get(area.id)?.length ?? 0,
        state: area.active ? 'Activa' : 'Inactiva',
        _active: area.active ? 1 : 0,
      }),
    );
  },
};

/** BRD §13.1 «Cumplimiento documental de personas»; also a PDF (FR-147). */
export const PEOPLE_COMPLIANCE: ReportDefinition = {
  id: 'people_compliance',
  family: 'workforce',
  title: 'Cumplimiento documental de personas',
  description: 'Documentos de conductores y demás personal con su vencimiento y días restantes.',
  view: 'view',
  columns: [
    { id: 'person', label: 'Persona', kind: 'text' },
    { id: 'personKind', label: 'Tipo de persona', kind: 'text', defaultVisible: false },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'document', label: 'Documento', kind: 'text' },
    { id: 'documentNumber', label: 'Nº de documento', kind: 'text' },
    { id: 'issuedOn', label: 'Emisión', kind: 'date' },
    { id: 'expiresOn', label: 'Vencimiento', kind: 'date' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'daysLeft', label: 'Días restantes', kind: 'integer' },
  ],
  filters: [
    AREA_FILTER('_areaId'),
    {
      id: 'typeCode',
      label: 'Tipo de documento',
      kind: 'enum',
      options: optionsOf(EMPLOYEE_DOCUMENT_TYPE_LABELS),
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
    const [documents, people, areas] = await Promise.all([
      sources.documents(ctx.tenantId, 'employee'),
      Promise.all(
        (['driver', 'dispatcher', 'other'] as const).map((kind) =>
          sources.people(ctx.tenantId, kind),
        ),
      ).then((groups) => groups.flat()),
      areaNames(sources, ctx.tenantId),
    ]);
    const personById = indexBy(people, (p) => p.id);
    const rows: Row[] = [];
    for (const document of documents) {
      const person = personById.get(document.ownerId);
      if (!person) continue;
      const daysLeft =
        document.expiresOn === null ? null : daysBetween(ctx.today, document.expiresOn);
      const status = expiryStatus(document.expiresOn, daysLeft);
      rows.push({
        person: fullName(person),
        personKind: label(PERSON_KIND_LABELS, person.kind),
        area: areas.get(person.areaId)?.name ?? null,
        document: label(EMPLOYEE_DOCUMENT_TYPE_LABELS, document.typeCode),
        documentNumber: document.documentNumber,
        issuedOn: document.issuedOn,
        expiresOn: document.expiresOn,
        status: label(DOCUMENT_STATUS_LABELS, status),
        daysLeft,
        _areaId: person.areaId,
        _typeCode: document.typeCode,
        _status: status,
      });
    }
    return rows;
  },
};
