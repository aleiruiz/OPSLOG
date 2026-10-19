import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  sanitizeAuditEvent,
  type AuditEvent,
} from '../../../../packages/platform/audit/src/index.js';
import { ExportError } from './types.js';

/** Opaque handles only: a person's name or e-mail does not belong in an audit trail. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export const AUDIT_FILE = 'export-audit.jsonl';

export interface ExportHandles {
  /** Opaque reference of the operator running the export (a handle, never a name or an e-mail). */
  readonly operatorRef: string;
  /** Opaque reference of the request that justifies it (a ticket id, never free text). */
  readonly reasonRef: string;
}

export function requireHandles(handles: ExportHandles): ExportHandles {
  if (!HANDLE.test(handles.operatorRef) || !HANDLE.test(handles.reasonRef))
    throw new ExportError('bad_arguments');
  return handles;
}

export type ExportAuditAction =
  | 'tenant.export.started'
  | 'tenant.export.completed'
  | 'tenant.export.incomplete'
  | 'tenant.export.failed';

/**
 * Append-only audit trail of the administrative export, one JSON line per event in the shape of the
 * platform audit event (`sanitizeAuditEvent`). The backup account cannot write to the database
 * (it only reads), so the trail lives beside the archive and is also logged; loading it into
 * `opslog_audit_log` is a separate administrative step with the audit account.
 */
export class ExportAuditTrail {
  public constructor(
    private readonly directory: string,
    private readonly tenantId: string,
    private readonly handles: ExportHandles,
    private readonly now: () => Date,
    private readonly correlationId: string = randomUUID(),
  ) {}

  public record(
    action: ExportAuditAction,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): AuditEvent {
    const event: AuditEvent = {
      eventId: randomUUID(),
      tenantId: this.tenantId,
      action,
      entityType: 'tenant',
      entityId: this.tenantId,
      occurredAt: this.now().toISOString(),
      actor: { id: 'worker-tenant-export', kind: 'system' },
      correlationId: this.correlationId,
      data: {},
    };
    // Validate against the platform's own shape before writing; the extra context sits beside it.
    sanitizeAuditEvent(event);
    const file = join(this.directory, AUDIT_FILE);
    const created = !existsSync(file);
    appendFileSync(
      file,
      `${JSON.stringify({ ...event, context: { ...this.handles, ...detail } })}\n`,
      {
        mode: 0o600,
      },
    );
    if (created) chmodSync(file, 0o600);
    return event;
  }
}
