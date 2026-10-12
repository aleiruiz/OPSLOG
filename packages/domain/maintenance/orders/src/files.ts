import { WorkOrderServiceBase } from './base.js';
import { WorkOrderError } from './errors.js';
import { opaqueId, record, version } from './rules.js';
import {
  WORK_ORDER_FILE_KINDS,
  type WorkOrder,
  type WorkOrderAttachment,
  type WorkOrderFileChange,
  type WorkOrderFileCommand,
  type WorkOrderFileKind,
  type WorkOrderFileStatus,
} from './types.js';
import {
  EDITABLE_STATUSES,
  can,
  requireCommand,
  requireVersion,
  type WorkOrderActor,
} from './workflow.js';

/** Most files of each kind one order keeps. */
export const MAX_FILES_PER_KIND = 20;

/** An attachment as shown to a caller: the link plus the lifecycle status of the file behind it. */
export type WorkOrderAttachmentView = Omit<WorkOrderAttachment, 'tenantId'> & {
  readonly fileStatus: WorkOrderFileStatus | 'missing';
};

export function fileKind(value: unknown): WorkOrderFileKind {
  if (!(WORK_ORDER_FILE_KINDS as readonly unknown[]).includes(value))
    throw new WorkOrderError('invalid_input');
  return value as WorkOrderFileKind;
}

/**
 * Evidence and invoice files of a work order (G3 H3). The link is a row of this module; the file
 * itself belongs to the files module. Only a file the files module reports as `clean` counts as
 * persisted evidence: an upload intent or a file still in quarantine does not.
 */
export abstract class WorkOrderFilesBase extends WorkOrderServiceBase {
  /** Requirements that the configured evidence/invoice policy adds to `complete` and `close`. */
  protected async fileRequirements(
    tenantId: string,
    order: WorkOrder,
  ): Promise<Readonly<Record<string, boolean>>> {
    const required = await this.refs.fileRequirements(tenantId);
    if (!required.evidence && !required.invoice) return {};
    const released = new Set<WorkOrderFileKind>();
    for (const link of await this.store.attachments(tenantId, order.id))
      if ((await this.refs.fileRecord(tenantId, link.fileId))?.status === 'clean')
        released.add(link.kind);
    return {
      ...(required.evidence ? { evidence: released.has('evidence') } : {}),
      ...(required.invoice ? { invoice: released.has('invoice') } : {}),
    };
  }

  /** Loads the order and checks the caller, the status and the version before any file is stored. */
  public async prepareFileChange(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
    kind: WorkOrderFileKind,
    expected: unknown,
  ): Promise<WorkOrder> {
    const order = await this.get(tenantId, actor, id);
    requireCommand(actor, kind, order);
    // Closed and cancelled orders are immutable, evidence included.
    if (!EDITABLE_STATUSES.includes(order.status)) throw new WorkOrderError('invalid_transition');
    requireVersion(order, version(expected));
    return order;
  }

  public async listFiles(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
  ): Promise<readonly WorkOrderAttachmentView[]> {
    const order = await this.get(tenantId, actor, id);
    const links = await this.store.attachments(tenantId, order.id);
    const views: WorkOrderAttachmentView[] = [];
    for (const stored of links) {
      const { tenantId: _tenant, ...link } = stored;
      void _tenant;
      // Invoices are cost data: without `view_costs` they are not even listed.
      if (link.kind === 'invoice' && !can(actor, 'view_costs')) continue;
      const file = await this.refs.fileRecord(tenantId, link.fileId);
      views.push({ ...link, fileStatus: file?.status ?? 'missing' });
    }
    return views;
  }

  /** The link of one file for a download: the caller must see the order and, for an invoice, hold `view_costs`. */
  public async fileLink(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
    attachmentId: string,
  ): Promise<WorkOrderAttachment> {
    const order = await this.get(tenantId, actor, id);
    const link = (await this.store.attachments(tenantId, order.id)).find(
      (candidate) => candidate.id === opaqueId(attachmentId),
    );
    if (!link || (link.kind === 'invoice' && !can(actor, 'view_costs')))
      throw new WorkOrderError('not_found');
    return link;
  }

  public async attachFile(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
    input: unknown,
  ): Promise<WorkOrder> {
    const data = record(input, ['version', 'kind', 'fileId']);
    const kind = fileKind(data['kind']);
    const order = await this.prepareFileChange(tenantId, actor, id, kind, data['version']);
    const fileId = opaqueId(data['fileId']);
    const file = await this.refs.fileRecord(tenantId, fileId);
    // A file of another tenant or one the caller did not upload looks the same as an unknown one.
    if (!file || file.createdBy !== actor.id) throw new WorkOrderError('not_found');
    if (file.kind !== 'original' || file.sensitivity !== 'standard')
      throw new WorkOrderError('invalid_input');
    // An upload intent or a rejected file is not evidence.
    if (file.status !== 'pending_scan' && file.status !== 'clean')
      throw new WorkOrderError('invalid_association');
    const links = await this.store.attachments(tenantId, order.id);
    if (links.some((link) => link.fileId === fileId)) throw new WorkOrderError('duplicate');
    if (links.filter((link) => link.kind === kind).length >= MAX_FILES_PER_KIND)
      throw new WorkOrderError('invalid_input');
    const attachment: WorkOrderAttachment = {
      id: this.newId(),
      tenantId,
      orderId: order.id,
      fileId,
      kind,
      displayName: file.displayName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      attachedBy: actor.id,
      attachedAt: this.now().toISOString(),
    };
    return this.applyFileChange(order, actor, `${kind}_attached`, { op: 'attach', attachment });
  }

  public async detachFile(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
    input: unknown,
  ): Promise<WorkOrder> {
    const data = record(input, ['version', 'attachmentId']);
    const attachmentId = opaqueId(data['attachmentId']);
    const order = await this.get(tenantId, actor, id);
    const link = (await this.store.attachments(tenantId, order.id)).find(
      (candidate) => candidate.id === attachmentId,
    );
    if (!link) throw new WorkOrderError('not_found');
    await this.prepareFileChange(tenantId, actor, id, link.kind, data['version']);
    return this.applyFileChange(order, actor, `${link.kind}_detached`, {
      op: 'detach',
      attachmentId,
    });
  }

  private async applyFileChange(
    order: WorkOrder,
    actor: WorkOrderActor,
    command: WorkOrderFileCommand,
    file: WorkOrderFileChange,
  ): Promise<WorkOrder> {
    const next: WorkOrder = {
      ...order,
      version: order.version + 1,
      updatedAt: this.now().toISOString(),
      updatedBy: actor.id,
    };
    const applied = await this.store.apply({
      order: next,
      expectedVersion: order.version,
      transition: this.timeline(next, command, order, actor, null, null),
      auditAction: `maintenance.work_order.${command}`,
      events: [],
      file,
    });
    if (!applied) {
      const current = await this.store.get(order.tenantId, order.id);
      throw new WorkOrderError(current?.version === order.version ? 'duplicate' : 'stale_version');
    }
    return next;
  }
}
