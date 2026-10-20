import { createHash } from 'node:crypto';
import {
  ExportService,
  InMemoryExportJobStore,
  type ArtifactStore,
  type ExportAuthority,
  type ExportJobStore,
} from '../../../../../packages/domain/exports/src/index.js';
import type { Permission } from '../../../../../packages/domain/identity/src/index.js';
import {
  ReportEngine,
  type ReportCatalog,
  createReportCatalog,
} from '../../../../../packages/domain/reports/src/index.js';
import { renderExport } from '../../../../../packages/platform/exports/src/index.js';
import type { ObjectStorage } from '../../../../../packages/platform/files/src/index.js';
import { ExportsApi } from '../../../exports/src/index.js';
import { ReportsApi } from '../../../reports/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import type { AnalyticsFleet } from './analytics-apis.js';
import type { IncidentServices } from './incident-apis.js';
import { ACTOR_PREFIX, type PlatformKernel } from './kernel.js';
import { sessionIdOf } from './gate.js';
import { reportSources } from './report-sources.js';
import type { OperationalInputs } from './report-ops-sources.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { MechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { PlatformAdapters } from './types.js';

/** Reports and their exports: the two APIs, the service the worker runs and its job store. */
export interface ReportsModule {
  readonly reports: ReportsApi;
  readonly exports: ExportsApi;
  readonly service: ExportService;
  readonly store: ExportJobStore;
  /** The report definitions: the BFF names a job's report and filters from them. */
  readonly catalog: ReportCatalog;
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  admin: 'Administración',
  editor: 'Edición',
  viewer: 'Consulta',
  auditor: 'Auditoría',
  pii_reader: 'Datos personales',
  incident_manager: 'Siniestros',
};

/** The files live in the object storage under `tenants/<id>/exports/<jobId>`. */
export function artifactStore(storage: ObjectStorage): ArtifactStore {
  const ref = (tenantId: string, jobId: string) =>
    ({ tenantId, area: 'exports', kind: 'original', fileId: jobId }) as const;
  return {
    put: (tenantId, jobId, bytes, contentType, sha256) =>
      storage.putIfAbsent(ref(tenantId, jobId), bytes, { contentType, sha256 }),
    get: (tenantId, jobId) => storage.get(ref(tenantId, jobId)),
    delete: (tenantId, jobId) => storage.delete(ref(tenantId, jobId)),
  };
}

/**
 * What a job re-checks when it starts: the session still stands (not revoked, not expired, same
 * company and person), the company is active, the membership holds a role, and the permissions are
 * those of that role now.
 */
export function exportAuthority(kernel: PlatformKernel): ExportAuthority {
  return {
    check: async (job) => {
      const session = await kernel.tenants.getSession(job.sessionId as never);
      if (
        !session ||
        session.revoked ||
        session.expiresAt.getTime() <= kernel.now().getTime() ||
        session.tenantId !== job.tenantId ||
        session.subjectId !== job.actorId
      )
        return null;
      if (kernel.tenants.status(job.tenantId) !== 'active') return null;
      const role = await kernel.access.effectiveRole(job.tenantId, job.actorId);
      return role ? new Set<Permission>(ROLE_PERMISSIONS[role]) : null;
    },
  };
}

/** The stores the maintenance, incident and audit reports read, beyond the fleet services. */
export type ReportStores = Omit<
  OperationalInputs,
  'assignments' | 'vehicleStore' | 'mechanicLinked' | 'now'
> & { readonly mechanics: MechanicStore };

export function buildReports(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  fleet: AnalyticsFleet,
  storage: ObjectStorage,
  stores: ReportStores,
): ReportsModule {
  const { mechanics, ...operational } = stores;
  const scope = createMechanicScope(mechanics);
  const engine = new ReportEngine(createReportCatalog(), {
    sources: reportSources({
      vehicles: services.vehicles,
      employees: services.employees,
      areas: fleet.areaService,
      assignments: services.assignments,
      documents: fleet.documentStore,
      policies: services.policies,
      vehicleStore: fleet.vehicleStore,
      now: kernel.now,
      ops: {
        ...operational,
        assignments: services.assignments,
        vehicleStore: fleet.vehicleStore,
        mechanicLinked: scope.mechanicLinked,
        now: kernel.now,
      },
    }),
    timeZone: async (tenantId) => (await services.settings.get(tenantId)).timeZone,
    now: kernel.now,
  });
  // Without a durable store the events of finished jobs go to the platform outbox.
  const store: ExportJobStore =
    adapters.exportJobs ??
    new InMemoryExportJobStore(
      (envelope) => kernel.outbox.transaction((tx) => void tx.enqueue(envelope)),
      kernel.now,
    );
  const service = new ExportService({
    store,
    engine,
    artifacts: artifactStore(storage),
    render: async (format, table) => renderExport(format, table),
    authority: exportAuthority(kernel),
    audit: (entry) =>
      kernel.auditNow(
        { tenantId: entry.tenantId, actorId: `${ACTOR_PREFIX}${entry.actorId}`, actorKind: 'user' },
        entry.action,
        'export',
        entry.jobId,
        entry.correlationId,
      ),
    company: {
      name: (tenantId) => kernel.tenantName(tenantId),
      author: async (tenantId, actorId) => {
        const role = await kernel.access.effectiveRole(tenantId, actorId);
        const alias = createHash('sha256').update(actorId).digest('hex').slice(0, 8);
        return `${ROLE_LABELS[role ?? ''] ?? 'Usuario'} (${alias})`;
      },
    },
    now: kernel.now,
  });
  const authorize = async (token: string, correlationId: string) => {
    const context = await kernel.authorize(token, correlationId, []);
    return {
      tenantId: context.tenantId,
      subject: context.actor.subject,
      sessionId: sessionIdOf(token),
      permissions: await kernel.access.resolvePermissions(context),
    };
  };
  return {
    reports: new ReportsApi({ authorize, engine }),
    exports: new ExportsApi({ authorize, service }),
    service,
    store,
    catalog: engine.catalog,
  };
}
