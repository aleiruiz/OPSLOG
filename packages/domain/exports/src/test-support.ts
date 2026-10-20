import type { Permission } from '../../identity/src/index.js';
import { renderExport } from '../../../platform/exports/src/index.js';
import { createReportCatalog, ReportEngine } from '../../reports/src/index.js';
import {
  MemorySources,
  companyA,
  companyB,
  type TenantData,
} from '../../reports/src/test-support.js';
import { InMemoryExportJobStore, type ExportEnvelope } from './store.js';
import type { ArtifactStore, ExportAuditEntry } from './ports.js';
import { ExportService, type ExportActor } from './service.js';

export class MemoryArtifacts implements ArtifactStore {
  public readonly files = new Map<string, Uint8Array>();
  public failPut = 0;
  public async put(tenantId: string, jobId: string, bytes: Uint8Array) {
    if (this.failPut > 0) {
      this.failPut -= 1;
      throw new Error('storage_unavailable');
    }
    this.files.set(`tenants/${tenantId}/exports/${jobId}`, bytes);
  }
  public async get(tenantId: string, jobId: string) {
    return this.files.get(`tenants/${tenantId}/exports/${jobId}`) ?? null;
  }
  public async delete(tenantId: string, jobId: string) {
    this.files.delete(`tenants/${tenantId}/exports/${jobId}`);
  }
}

export interface Harness {
  readonly service: ExportService;
  readonly store: InMemoryExportJobStore;
  readonly artifacts: MemoryArtifacts;
  readonly sources: MemorySources;
  readonly events: ExportEnvelope[];
  readonly audit: ExportAuditEntry[];
  readonly clock: { now: Date; elapsed: number; step: number };
  /** What the authority answers for a job's person; null means the session ended. */
  readonly grants: Map<string, ReadonlySet<Permission> | null>;
  renderFailures: { count: number };
}

export const FULL: readonly Permission[] = ['view', 'export', 'view_pii', 'view_costs'];
export const BASIC: readonly Permission[] = ['view', 'export'];

export function actor(
  permissions: readonly Permission[],
  over: Partial<ExportActor> = {},
): ExportActor {
  return {
    tenantId: 'A',
    actorId: 'u1',
    sessionId: 'session-1',
    permissions: new Set(permissions),
    correlationId: 'corr-1',
    ...over,
  };
}

export function harness(
  tenants: Record<string, TenantData> = { A: companyA(), B: companyB() },
  options: { directMaxRows?: number; pdfMaxRows?: number } = {},
): Harness {
  const sources = new MemorySources(tenants);
  const events: ExportEnvelope[] = [];
  const audit: ExportAuditEntry[] = [];
  const clock = { now: new Date('2026-10-19T16:00:00.000Z'), elapsed: 0, step: 0 };
  const store = new InMemoryExportJobStore(
    (envelope) => void events.push(envelope),
    () => clock.now,
  );
  const artifacts = new MemoryArtifacts();
  const grants = new Map<string, ReadonlySet<Permission> | null>();
  const renderFailures = { count: 0 };
  const engine = new ReportEngine(createReportCatalog(), {
    sources,
    timeZone: async () => 'America/Mexico_City',
    now: () => clock.now,
  });
  let ticks = 0;
  const service = new ExportService({
    store,
    engine,
    artifacts,
    render: async (format, table) => {
      if (renderFailures.count > 0) {
        renderFailures.count -= 1;
        throw new Error('render failed');
      }
      return renderExport(format, table);
    },
    authority: { check: async (job) => grants.get(`${job.tenantId}:${job.actorId}`) ?? null },
    audit: async (entry) => void audit.push(entry),
    company: {
      name: (tenantId) => (tenantId === 'A' ? 'Transportes Ñandú' : 'Otra Empresa'),
      author: async () => 'Administrador (u1)',
    },
    now: () => clock.now,
    newId: () => `job-${(ticks += 1)}`,
    clock: () => (clock.elapsed += clock.step),
    ...(options.directMaxRows === undefined ? {} : { directMaxRows: options.directMaxRows }),
    ...(options.pdfMaxRows === undefined ? {} : { pdfMaxRows: options.pdfMaxRows }),
  });
  grants.set('A:u1', new Set(FULL));
  return { service, store, artifacts, sources, events, audit, clock, grants, renderFailures };
}

/** A company with `count` vehicles, to cross the 5.000-row boundary. */
export function bigCompany(count: number): TenantData {
  const base = companyA();
  return {
    ...base,
    vehicles: Array.from({ length: count }, (_, i) => ({
      id: `big-${i}`,
      economicNumber: `E-${String(i).padStart(5, '0')}`,
      plate: `P-${i}`,
      vin: null,
      make: 'Kenworth',
      model: 'T680',
      year: 2020,
      areaId: 'a1',
      status: 'active',
      statusReason: '',
      odometerKm: i,
      registeredOn: '2024-01-15',
    })),
    assignments: [],
    documents: [],
    policies: [],
    statusSince: {},
  };
}
