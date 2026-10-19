import { actorAlias, actorLabel } from './actor.js';
import { actionLabel, isDeniedAction } from './catalog.js';
import { describeChange, recordOfEvent } from './diff.js';
import { entityType, entityTypeLabel, shortId } from './entities.js';
import { AuditQueryError } from './errors.js';
import { resolveAuditQuery, type AuditQueryInput } from './query.js';
import type {
  AuditEntryPage,
  AuditEntryView,
  AuditEventReader,
  AuditEventRow,
  AuditReconciler,
  AuditReconciliation,
  AuditViewer,
  ChangeRecord,
  ChangeSource,
  EntityDescriber,
  EntityDescription,
} from './types.js';

export const UNAVAILABLE_ENTITY = 'Registro no disponible';
const RESTRICTED_PERSON = 'Persona de la plantilla';

export interface AuditQueryDeps {
  readonly reader: AuditEventReader;
  readonly reconciler: AuditReconciler;
  /** Readable descriptions by entity type (vehicle: economic number, incident: folio, area: name). */
  readonly describers?: Readonly<Record<string, EntityDescriber>>;
  /** Field history of the modules that keep one (incidents, work orders). */
  readonly changeSources?: Readonly<Record<string, ChangeSource>>;
  /** Role label of a company member; null when the member no longer exists. */
  readonly roleOf: (tenantId: string, actorId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

const can = (viewer: AuditViewer, permission: string | null) =>
  permission === null || viewer.permissions.includes(permission);

/**
 * Global and per-entity audit queries (FR-171, S26). The company is always the session's; ids that belong
 * to another company simply match no row. Nothing in the answer is read from outside the audit, the
 * module descriptions and the module histories the caller may read.
 */
export class AuditQueryService {
  private readonly now: () => Date;

  public constructor(private readonly deps: AuditQueryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  public async list(
    tenantId: string,
    viewer: AuditViewer,
    input: AuditQueryInput,
  ): Promise<AuditEntryPage> {
    const { filter, page } = resolveAuditQuery(input, this.now());
    const slice = await this.deps.reader.query(tenantId, filter, page);
    const last = slice.rows[slice.rows.length - 1];
    return {
      items: await this.present(tenantId, viewer, slice.rows),
      total: slice.total,
      next: last && slice.hasMore ? { occurredAt: last.occurredAt, eventId: last.eventId } : null,
      from: filter.from,
      to: filter.to,
    };
  }

  /** The history of one record. It needs the permission that reads the record's module as well. */
  public async forEntity(
    tenantId: string,
    viewer: AuditViewer,
    type: string,
    entityId: string,
    input: Omit<AuditQueryInput, 'entityType' | 'entityId' | 'actorId'>,
  ): Promise<AuditEntryPage> {
    const known = entityType(type);
    if (!known) throw new AuditQueryError('invalid_input');
    if (!can(viewer, known.read)) throw new AuditQueryError('forbidden');
    return this.list(tenantId, viewer, { ...input, entityType: type, entityId });
  }

  public async reconciliation(
    tenantId: string,
    input: { readonly from?: string; readonly to?: string },
  ): Promise<AuditReconciliation> {
    const { filter } = resolveAuditQuery(input, this.now());
    return this.deps.reconciler.reconcile(tenantId, filter.from, filter.to, this.now());
  }

  private async present(
    tenantId: string,
    viewer: AuditViewer,
    rows: readonly AuditEventRow[],
  ): Promise<readonly AuditEntryView[]> {
    const [descriptions, history, roles] = await Promise.all([
      this.describeAll(tenantId, viewer, rows),
      this.historiesOf(tenantId, viewer, rows),
      this.rolesOf(tenantId, rows),
    ]);
    return rows.map((row) => {
      const key = `${row.entityType}\u0000${row.entityId}`;
      const record = history.get(key);
      const matched = record ? recordOfEvent(row.action, row.occurredAt, record) : null;
      return {
        eventId: row.eventId,
        occurredAt: row.occurredAt,
        action: row.action,
        actionLabel: actionLabel(row.action),
        result: isDeniedAction(row.action) ? 'denied' : 'success',
        entityType: row.entityType,
        entityTypeLabel: entityTypeLabel(row.entityType),
        entityId: row.entityId,
        ...this.entity(viewer, row, descriptions.get(key)),
        actor: {
          id: row.actor.id,
          kind: row.actor.kind,
          label: actorLabel(row.actor.kind, roles.get(row.actor.id) ?? null),
          alias: actorAlias(tenantId, row.actor.id),
        },
        correlationId: row.correlationId,
        changes: matched ? describeChange(row.entityType, matched, viewer) : null,
      };
    });
  }

  private entity(
    viewer: AuditViewer,
    row: AuditEventRow,
    described: EntityDescription | null | undefined,
  ): { entityLabel: string; entityAvailable: boolean } {
    const type = entityTypeLabel(row.entityType);
    // `undefined`: no describer for this type, so the record is only named by its type and a short id.
    if (described === undefined)
      return { entityLabel: `${type} ${shortId(row.entityId)}`, entityAvailable: true };
    if (described === null) return { entityLabel: UNAVAILABLE_ENTITY, entityAvailable: false };
    if (described.pii === true && !viewer.permissions.includes('view_pii'))
      return { entityLabel: RESTRICTED_PERSON, entityAvailable: true };
    return { entityLabel: described.label, entityAvailable: true };
  }

  private async describeAll(
    tenantId: string,
    viewer: AuditViewer,
    rows: readonly AuditEventRow[],
  ): Promise<Map<string, EntityDescription | null>> {
    const wanted = new Map<string, AuditEventRow>();
    // A record is described only to readers of its module, like its diff: others get type and short id.
    for (const row of rows)
      if (
        this.deps.describers?.[row.entityType] &&
        can(viewer, entityType(row.entityType)?.read ?? null)
      )
        wanted.set(`${row.entityType}\u0000${row.entityId}`, row);
    const found = await Promise.all(
      [...wanted].map(async ([key, row]) => {
        const describer = this.deps.describers?.[row.entityType] as EntityDescriber;
        return [key, await describer.describe(tenantId, row.entityId)] as const;
      }),
    );
    return new Map(found);
  }

  private async historiesOf(
    tenantId: string,
    viewer: AuditViewer,
    rows: readonly AuditEventRow[],
  ): Promise<Map<string, readonly ChangeRecord[]>> {
    const wanted = new Map<string, AuditEventRow>();
    for (const row of rows) {
      const source = this.deps.changeSources?.[row.entityType];
      if (source && can(viewer, entityType(row.entityType)?.read ?? null))
        wanted.set(`${row.entityType}\u0000${row.entityId}`, row);
    }
    const found = await Promise.all(
      [...wanted].map(async ([key, row]) => {
        const source = this.deps.changeSources?.[row.entityType] as ChangeSource;
        return [key, await source.changes(tenantId, row.entityId)] as const;
      }),
    );
    return new Map(found);
  }

  private async rolesOf(
    tenantId: string,
    rows: readonly AuditEventRow[],
  ): Promise<Map<string, string | null>> {
    const actors = new Set(
      rows.filter((row) => row.actor.kind === 'user').map((row) => row.actor.id),
    );
    const found = await Promise.all(
      [...actors].map(async (id) => [id, await this.deps.roleOf(tenantId, id)] as const),
    );
    return new Map(found);
  }
}
