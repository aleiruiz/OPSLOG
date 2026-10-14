import type { ApiError, BffAlertSettings, BffWorkOrder, BffWorkOrderFile } from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';

const at = '2026-10-12T12:00:00.000Z';
const fail = (status: ApiError['status'], code: string): Result<never> => ({
  ok: false,
  error: { status, code, message: 'x', correlationId: 'fake' },
});

/**
 * In-memory evidence/invoice files and company settings for the fake maintenance ports. The fake
 * only mimics the server's answers: a file counts once its status is `clean` (`release()`).
 */
export function createFakeFiles(deps: {
  find: (id: string) => BffWorkOrder | undefined;
  commit: (order: BffWorkOrder) => BffWorkOrder;
  viewCosts: () => boolean;
}) {
  const links = new Map<string, BffWorkOrderFile[]>();
  let settings: BffAlertSettings = {
    expiryWindowDays: 30,
    recipientRoles: ['admin', 'editor'],
    maintenanceEvidence: 'none',
    closeCostThreshold: null,
    timeZone: 'UTC',
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
  const of = (id: string) => links.get(id) ?? [];
  const bump = (order: BffWorkOrder) => deps.commit({ ...order, version: order.version + 1 });
  const files: MaintenancePorts['orders']['files'] = {
    list: async (id) => {
      if (!deps.find(id)) return fail(404, 'not_found');
      return {
        ok: true,
        value: structuredClone(of(id).filter((f) => f.kind === 'evidence' || deps.viewCosts())),
      };
    },
    upload: async (id, body) => {
      const order = deps.find(id);
      if (!order) return fail(404, 'not_found');
      if (body.kind === 'invoice' && !deps.viewCosts()) return fail(403, 'forbidden');
      if (['closed', 'cancelled'].includes(order.status)) return fail(409, 'invalid_transition');
      if (order.version !== body.version) return fail(409, 'stale_version');
      links.set(id, [
        ...of(id),
        {
          id: `file-${id}-${of(id).length + 1}`,
          kind: body.kind,
          displayName: body.name,
          contentType: body.contentType,
          sizeBytes: body.contentBase64.length,
          fileStatus: 'pending_scan',
          attachedBy: 'user-admin',
          attachedAt: at,
        },
      ]);
      return { ok: true, value: structuredClone(bump(order)) };
    },
    detach: async (id, fileId, version) => {
      const order = deps.find(id);
      if (!order) return fail(404, 'not_found');
      if (['closed', 'cancelled'].includes(order.status)) return fail(409, 'invalid_transition');
      if (order.version !== version) return fail(409, 'stale_version');
      links.set(
        id,
        of(id).filter((f) => f.id !== fileId),
      );
      return { ok: true, value: structuredClone(bump(order)) };
    },
    content: async (id, fileId) => {
      const file = of(id).find((f) => f.id === fileId);
      return file
        ? {
            ok: true,
            value: {
              displayName: file.displayName,
              contentType: file.contentType,
              contentBase64: 'JVBERg==',
            },
          }
        : fail(404, 'not_found');
    },
  };
  const settingsPorts: MaintenancePorts['settings'] = {
    get: async () => ({ ok: true, value: structuredClone(settings) }),
    save: async (body) => {
      if (body.version !== settings.version) return fail(409, 'stale_version');
      settings = {
        ...settings,
        expiryWindowDays: body.expiryWindowDays,
        recipientRoles: body.recipientRoles,
        maintenanceEvidence: body.maintenanceEvidence ?? settings.maintenanceEvidence,
        ...(body.closeCostThreshold === undefined
          ? settings.closeCostThreshold === undefined
            ? {}
            : { closeCostThreshold: settings.closeCostThreshold }
          : { closeCostThreshold: body.closeCostThreshold }),
        timeZone: body.timeZone ?? settings.timeZone,
        version: settings.version + 1,
        updatedBy: 'user-admin',
        updatedAt: at,
      };
      return { ok: true, value: structuredClone(settings) };
    },
  };
  return {
    files,
    settings: settingsPorts,
    /** Which files of the order count: only `clean` ones. */
    counted: (id: string) => ({
      evidence: of(id).some((f) => f.kind === 'evidence' && f.fileStatus === 'clean'),
      invoice: of(id).some((f) => f.kind === 'invoice' && f.fileStatus === 'clean'),
    }),
    required: () => settings.maintenanceEvidence,
    thresholdSet: () => settings.closeCostThreshold !== null,
    /** The scan finished: every pending file is clean. */
    release: () => {
      for (const [id, list] of links)
        links.set(
          id,
          list.map((f) => ({ ...f, fileStatus: 'clean' as const })),
        );
    },
  };
}
