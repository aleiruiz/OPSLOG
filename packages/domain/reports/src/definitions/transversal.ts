import { addDays, daysBetween, momentInZone, startOfDay } from '../calendar.js';
import { ReportError } from '../errors.js';
import {
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  SOURCE_LABELS,
  VEHICLE_DOCUMENT_TYPE_LABELS,
  label,
} from '../labels.js';
import { APPLIED, fullName, indexBy, textFilter, vehicleLabel } from '../rows.js';
import type { ReportDefinition, Row } from '../types.js';
import { AREA, FROM, TO } from './period.js';

const RANGES = [
  { value: '7', max: 7 },
  { value: '15', max: 15 },
  { value: '30', max: 30 },
  { value: '60', max: 60 },
  { value: '90', max: 90 },
] as const;

/** Where a due date falls: expired, or the smallest of the 7/15/30/60/90-day windows that holds it. */
function rangeLabel(daysLeft: number): string {
  if (daysLeft < 0) return 'Vencido';
  const range = RANGES.find((r) => daysLeft <= r.max);
  return range ? `Hasta ${range.value} días` : 'Más de 90 días';
}

/** BRD §13.1 «Vencimientos consolidados»: documents, policies, licenses and maintenance plans in one list. */
export const EXPIRATIONS: ReportDefinition = {
  id: 'expirations',
  family: 'transversal',
  title: 'Vencimientos consolidados',
  description:
    'Documentos de vehículos y personas, pólizas, licencias y planes de mantenimiento por fecha de vencimiento.',
  view: 'view',
  columns: [
    { id: 'category', label: 'Categoría', kind: 'text' },
    { id: 'subject', label: 'Vehículo o persona', kind: 'text' },
    { id: 'item', label: 'Concepto', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'dueOn', label: 'Vence', kind: 'date' },
    { id: 'daysLeft', label: 'Días restantes', kind: 'integer' },
    { id: 'range', label: 'Rango', kind: 'text' },
  ],
  filters: [
    AREA,
    {
      id: 'category',
      label: 'Categoría',
      kind: 'enum',
      options: Object.entries(SOURCE_LABELS).map(([value, text]) => ({ value, label: text })),
      test: (row, value) => row['_category'] === value,
    },
    {
      id: 'window',
      label: 'Vence en',
      kind: 'enum',
      options: [
        { value: 'overdue', label: 'Ya vencidos' },
        ...RANGES.map((r) => ({ value: r.value, label: `Próximos ${r.value} días` })),
      ],
      test: (row, value) => {
        const left = row['daysLeft'];
        if (typeof left !== 'number') return false;
        return value === 'overdue' ? left < 0 : left >= 0 && left <= Number(value);
      },
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'dueOn', direction: 'asc' },
  async load(ctx, _needed, sources) {
    const [vehicles, areas, vdocs, edocs, policies, plans, drivers, dispatchers, others] =
      await Promise.all([
        sources.vehicles(ctx.tenantId),
        sources.areas(ctx.tenantId),
        sources.documents(ctx.tenantId, 'vehicle'),
        sources.documents(ctx.tenantId, 'employee'),
        sources.policies(ctx.tenantId, false),
        sources.plans(ctx),
        sources.people(ctx.tenantId, 'driver'),
        sources.people(ctx.tenantId, 'dispatcher'),
        sources.people(ctx.tenantId, 'other'),
      ]);
    const vehicleById = indexBy(vehicles, (v) => v.id);
    const people = indexBy([...drivers, ...dispatchers, ...others], (p) => p.id);
    const areaName = new Map(areas.map((a) => [a.id, a.name]));
    const rows: Row[] = [];
    const add = (
      category: keyof typeof SOURCE_LABELS,
      subject: string,
      item: string,
      areaId: string,
      dueOn: string | null,
    ): void => {
      if (dueOn === null) return;
      const daysLeft = daysBetween(ctx.today, dueOn);
      rows.push({
        category: SOURCE_LABELS[category],
        subject,
        item,
        area: areaName.get(areaId) ?? null,
        dueOn,
        daysLeft,
        range: rangeLabel(daysLeft),
        _areaId: areaId,
        _category: category,
      });
    };
    for (const d of vdocs) {
      const v = vehicleById.get(d.ownerId);
      if (v)
        add(
          'vehicleDocument',
          vehicleLabel(v),
          label(VEHICLE_DOCUMENT_TYPE_LABELS, d.typeCode),
          v.areaId,
          d.expiresOn,
        );
    }
    for (const d of edocs) {
      const p = people.get(d.ownerId);
      if (p)
        add(
          'personDocument',
          fullName(p),
          label(EMPLOYEE_DOCUMENT_TYPE_LABELS, d.typeCode),
          p.areaId,
          d.expiresOn,
        );
    }
    for (const policy of policies) {
      const v = vehicleById.get(policy.vehicleId);
      if (v)
        add(
          'policy',
          vehicleLabel(v),
          `${policy.insurer} ${policy.policyNumber}`,
          v.areaId,
          policy.endsOn,
        );
    }
    for (const driver of drivers)
      if (driver.status !== 'terminated')
        add(
          'license',
          fullName(driver),
          `Licencia${driver.licenseType ? ` ${driver.licenseType}` : ''}`,
          driver.areaId,
          driver.licenseExpiresOn,
        );
    for (const plan of plans) {
      const v = vehicleById.get(plan.vehicleId);
      if (v && plan.state === 'active')
        add('plan', vehicleLabel(v), 'Servicio preventivo', v.areaId, plan.nextTargetDate);
    }
    return rows;
  },
};

const AUDIT_ENTITIES = [
  ['vehicle', 'Vehículo'],
  ['employee', 'Empleado'],
  ['area', 'Área'],
  ['document', 'Documento'],
  ['insurance_policy', 'Póliza'],
  ['incident', 'Siniestro'],
  ['maintenance_work_order', 'Orden de trabajo'],
  ['maintenance_plan', 'Plan de mantenimiento'],
  ['company_settings', 'Ajustes de la empresa'],
] as const;

const MAX_AUDIT_DAYS = 366;
const DEFAULT_AUDIT_DAYS = 30;

/**
 * BRD §13.1 «Audit log»: the trail of a range, masked exactly as the audit screen masks it for the
 * reader (personal data and amounts stay out of the diff unless the reader may see them).
 */
export const AUDIT_LOG: ReportDefinition = {
  id: 'audit_log',
  family: 'transversal',
  title: 'Bitácora de auditoría',
  description:
    'Acciones registradas en la empresa con fecha, actor, registro y cambios enmascarados.',
  view: 'view_audit',
  columns: [
    { id: 'occurredAt', label: 'Fecha y hora', kind: 'text' },
    { id: 'action', label: 'Acción', kind: 'text' },
    { id: 'result', label: 'Resultado', kind: 'text' },
    { id: 'entityType', label: 'Tipo de registro', kind: 'text' },
    { id: 'entity', label: 'Registro', kind: 'text' },
    { id: 'actor', label: 'Actor', kind: 'text' },
    { id: 'alias', label: 'Alias del actor', kind: 'text' },
    { id: 'correlationId', label: 'Correlación', kind: 'text', defaultVisible: false },
    { id: 'changes', label: 'Cambios', kind: 'text', defaultVisible: false },
  ],
  filters: [
    { ...FROM, label: 'Desde (últimos 30 días por omisión)' },
    TO,
    {
      id: 'entityType',
      label: 'Tipo de registro',
      kind: 'enum',
      options: AUDIT_ENTITIES.map(([value, text]) => ({ value, label: text })),
      test: APPLIED,
    },
    {
      id: 'result',
      label: 'Resultado',
      kind: 'enum',
      options: [
        { value: 'success', label: 'Correcto' },
        { value: 'denied', label: 'Denegado' },
      ],
      test: APPLIED,
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'occurredAt', direction: 'desc' },
  async load(ctx, _needed, sources, filters) {
    const from = textFilter(filters, 'from');
    const to = textFilter(filters, 'to');
    const toDay = to ?? addDays(ctx.today, 0);
    const fromDay = from ?? addDays(toDay, -DEFAULT_AUDIT_DAYS);
    const days = daysBetween(fromDay, toDay) + 1;
    if (days < 1 || days > MAX_AUDIT_DAYS) throw new ReportError('invalid_input', 'to');
    const entityType = textFilter(filters, 'entityType');
    const result = textFilter(filters, 'result');
    const facts = await sources.auditLog(ctx, {
      from: startOfDay(fromDay, ctx.timeZone).toISOString(),
      to: startOfDay(addDays(toDay, 1), ctx.timeZone).toISOString(),
      ...(entityType === undefined ? {} : { entityType }),
      ...(result === 'success' || result === 'denied' ? { result } : {}),
    });
    return facts.map(
      (f): Row => ({
        occurredAt: momentInZone(new Date(f.occurredAt), ctx.timeZone),
        action: f.actionLabel,
        result: f.result === 'denied' ? 'Denegado' : 'Correcto',
        entityType: f.entityTypeLabel,
        entity: f.entityLabel,
        actor: f.actorLabel,
        alias: f.actorAlias,
        correlationId: f.correlationId,
        changes: f.changes,
      }),
    );
  },
};
