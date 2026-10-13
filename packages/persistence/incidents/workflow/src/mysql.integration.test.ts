import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  IncidentService,
  type IncidentActor,
  type IncidentReferences,
} from '../../../../domain/incidents/cases/src/index.js';
import {
  FAIL_CLOSED_COSTS,
  FAIL_CLOSED_REPAIRS,
  FAIL_CLOSED_TOTALS,
  IncidentProcessService,
  IncidentWorkflowService,
  NO_CLOSURE_COSTS,
  type IncidentClosureCosts,
  type WorkflowPorts,
} from '../../../../domain/incidents/workflow/src/index.js';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import { TypeOrmIncidentStore } from '../../cases/src/store.js';
import {
  adminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../cases/src/test-support/mysql.js';
import { TypeOrmIncidentClosures } from './closures.js';
import {
  createIncidentWorkflowMigrationDataSource,
  runIncidentWorkflowMigrations,
} from './data-source.js';
import { INCIDENT_WORKFLOW_TABLES as T } from './entities.js';

const suite = adminUrl ? describe : describe.skip;
const actor = (permissions: string[]): IncidentActor => {
  const subject = randomUUID();
  return { id: `user-${subject}`, subject, permissions, mechanicLinked: false };
};
const MANAGER = actor([
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
]);
const DRAFT = {
  vehicleId: 'vehicle-1',
  type: 'other',
  severity: 'low',
  occurredAt: '2026-10-13T12:00:00.000Z',
  location: { text: 'Calle Sintética' },
  description: 'Descripción sintética',
  vehicleOperable: true,
  noDriverReason: 'Vehículo estacionado',
  noPhotoJustification: 'Sin foto disponible',
};
const refs: IncidentReferences = {
  vehicle: async (_tenant, id) =>
    id === 'vehicle-1' ? { id, areaId: 'area-1', registeredOn: '2026-01-01' } : null,
  driver: async () => null,
  assignments: async () => [],
  policyRevisions: async () => [],
  timeZone: async () => 'UTC',
};

class Costs implements IncidentClosureCosts {
  public fail = false;
  public readonly taken: string[] = [];
  public async snapshot(request: { incidentId: string; cycle: number }) {
    if (this.fail) throw new Error('cost snapshot failed');
    this.taken.push(`${request.incidentId}:${request.cycle}`);
  }
}

suite('incident closures on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date('2026-10-13T18:00:00.000Z');
  const costs = new Costs();

  const world = (source: DataSource, closureCosts: IncidentClosureCosts = costs) => {
    const store = new TypeOrmIncidentStore(source);
    const closures = new TypeOrmIncidentClosures(source);
    const ports: WorkflowPorts = {
      references: refs,
      evidence: { evidence: async () => [] },
      settings: {
        reportPhoto: async () => 'photo_or_justification',
        closeCostThreshold: async () => null,
      },
      members: { permissionsOf: async () => ['incidents:view', 'incidents:edit'] },
      repairs: FAIL_CLOSED_REPAIRS,
      costs: FAIL_CLOSED_COSTS,
      totals: FAIL_CLOSED_TOTALS,
      blocks: { blocked: async () => false },
      closures,
      closureCosts,
    };
    const options = { now: () => now };
    return {
      store,
      closures,
      incidents: new IncidentService(store, refs, options),
      workflow: new IncidentWorkflowService(store, ports, options),
      process: new IncidentProcessService(store, ports, options),
    };
  };
  const count = async (table: string, column: string, tenant: string, extra = '1=1') => {
    const [row] = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=? AND ${extra}`,
      [tenant],
    );
    return Number(row?.n);
  };
  const snapshot = async (id: string) => ({
    closures: await count(T.closures, 'company_id', tenantA, `incident_id='${id}'`),
    transitions: await count(
      INCIDENT_TABLES.transitions,
      'company_id',
      tenantA,
      `incident_id='${id}'`,
    ),
    audit: await count(AUDIT_TABLES.local, 'tenant_id', tenantA, `entity_id='${id}'`),
    outbox: await count(AUDIT_TABLES.outbox, 'tenant_id', tenantA, `entity_id='${id}'`),
    row: (
      await db.rows<{ status: string; version: number }>(
        `SELECT status, version FROM ${INCIDENT_TABLES.incidents} WHERE company_id=? AND id=?`,
        [tenantA, id],
      )
    )[0],
  });

  /** A case taken by the commands to `resolved`, as a user would. */
  async function resolved(w: ReturnType<typeof world>, tenant = tenantA) {
    const created = await w.incidents.create(tenant, MANAGER, DRAFT);
    const run = (current: { id: string; version: number }, command: string, extra = {}) =>
      w.workflow.execute(tenant, MANAGER, current.id, {
        command,
        version: current.version,
        ...extra,
      });
    let current = await run(created, 'report');
    current = await run(current, 'assign', { responsibleId: MANAGER.subject });
    current = await run(current, 'review');
    current = await w.process.updateResolution(tenant, MANAGER, current.id, {
      version: current.version,
      resolutionSummary: 'Resuelto de forma sintética',
      vehicleStatusDecision: 'restricted',
    });
    return run(current, 'resolve');
  }
  const close = (
    w: ReturnType<typeof world>,
    incident: { id: string; version: number },
    key: string,
  ) =>
    w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      { command: 'close', version: incident.version },
      key,
    );

  beforeAll(async () => {
    db = await startIncidentDatabase('closures', {
      migrate: async (owner) => {
        const source = createIncidentWorkflowMigrationDataSource(owner);
        await source.initialize();
        try {
          await runIncidentWorkflowMigrations(source);
        } finally {
          await source.destroy();
        }
      },
      grants: [{ table: T.closures, privileges: 'SELECT, INSERT' }],
    });
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('closes, reopens and closes again: two intact rows, one event per transition and the full timeline (case 12)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    const closed = await close(w, incident, 'key-close-cycle-one');
    expect(closed).toMatchObject({ status: 'closed', cycle: 1 });
    const [first] = await w.closures.list(tenantA, incident.id);
    expect(first).toMatchObject({
      cycle: 1,
      statusBefore: 'resolved',
      resolvedFrom: 'under_review',
      resolutionSummary: 'Resuelto de forma sintética',
      vehicleStatusDecision: 'restricted',
      orders: [],
      closedBy: MANAGER.id,
    });
    const reopened = await w.workflow.execute(
      tenantA,
      MANAGER,
      incident.id,
      { command: 'reopen', version: closed.version, reason: 'Falta un dato' },
      'key-reopen-cycle-one',
    );
    expect(reopened).toMatchObject({
      status: 'reopened',
      cycle: 2,
      reopenCount: 1,
      closedAt: null,
    });
    let current = await w.workflow.execute(tenantA, MANAGER, incident.id, {
      command: 'review',
      version: reopened.version,
    });
    current = await w.process.updateResolution(tenantA, MANAGER, incident.id, {
      version: current.version,
      resolutionSummary: 'Segunda resolución',
    });
    current = await w.workflow.execute(tenantA, MANAGER, incident.id, {
      command: 'resolve',
      version: current.version,
    });
    await close(w, current, 'key-close-cycle-two');

    const rows = await world(sourceA2).closures.list(tenantA, incident.id);
    expect(rows.map((row) => [row.cycle, row.resolutionSummary])).toEqual([
      [1, 'Resuelto de forma sintética'],
      [2, 'Segunda resolución'],
    ]);
    expect(rows[0]).toEqual(first);
    expect(costs.taken.filter((entry) => entry.startsWith(incident.id))).toEqual([
      `${incident.id}:1`,
      `${incident.id}:2`,
    ]);
    expect((await w.store.history(tenantA, incident.id)).map((entry) => entry.command)).toEqual([
      'create',
      'coverage_none',
      'report',
      'assign',
      'review',
      'resolution_updated',
      'resolve',
      'close',
      'reopen',
      'review',
      'resolution_updated',
      'resolve',
      'close',
    ]);
    const events = await db.rows<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type IN ('incident.closed','incident.reopened') ORDER BY occurred_at, event_id`,
      [tenantA, incident.id],
    );
    expect(events.map((event) => event.type).sort()).toEqual([
      'incident.closed',
      'incident.closed',
      'incident.reopened',
    ]);
    for (const event of events)
      expect(Object.keys(event.payload).sort().join()).toMatch(
        /^(cycle,incidentId,version|incidentId,vehicleId,version)$/,
      );
  });

  it('writes one closure, one event and the same answer for two concurrent closes with the same key (case 9)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    const [one, two] = await Promise.all([
      close(w, incident, 'key-close-twin-race'),
      close(world(sourceA2), incident, 'key-close-twin-race'),
    ]);
    expect(one).toEqual(two);
    const state = await snapshot(incident.id);
    expect(state.closures).toBe(1);
    expect(state.row).toMatchObject({ status: 'closed' });
    const closedEvents = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=? AND type='incident.closed'`,
      [tenantA, incident.id],
    );
    expect(Number(closedEvents[0]?.n)).toBe(1);
    await expect(
      w.workflow.execute(
        tenantA,
        MANAGER,
        incident.id,
        { command: 'close', version: incident.version, comment: 'otro cuerpo' },
        'key-close-twin-race',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('leaves nothing behind when the cost snapshot, the audit or the outbox fails (case 16)', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    const before = await snapshot(incident.id);

    costs.fail = true;
    await expect(close(w, incident, 'key-close-cost-fail')).rejects.toThrow('cost snapshot failed');
    costs.fail = false;
    expect(await snapshot(incident.id)).toEqual(before);

    // A routine the runtime account loses fails inside the transaction, after the closure row.
    for (const routine of [
      'opslog_append_local_audit_and_delivery',
      'opslog_enqueue_tenant_outbox',
    ]) {
      await db.rows(`REVOKE EXECUTE ON PROCEDURE ${routine} FROM '${db.runtimeUserA}'@'%'`);
      try {
        await expect(close(w, incident, `key-close-${routine.slice(6, 12)}`)).rejects.toBeDefined();
      } finally {
        await db.rows(`GRANT EXECUTE ON PROCEDURE ${routine} TO '${db.runtimeUserA}'@'%'`);
      }
      expect(await snapshot(incident.id)).toEqual(before);
    }
    expect((await close(w, incident, 'key-close-after-faults')).status).toBe('closed');
    expect((await snapshot(incident.id)).closures).toBe(1);
  });

  it('refuses a second closure of a cycle, and gives the runtime account no way to change a snapshot', async () => {
    const w = world(sourceA);
    const incident = await resolved(w);
    await close(w, incident, 'key-close-for-dup');
    const [row] = await w.closures.list(tenantA, incident.id);
    await expect(
      sourceA.transaction(async (manager) => w.closures.record(row as never, manager)),
    ).resolves.toBe(false);
    await expect(
      sourceA.query(`UPDATE ${T.closures} SET resolution_summary='x' WHERE company_id=?`, [
        tenantA,
      ]),
    ).rejects.toThrow(/denied|privilege/i);
    await expect(
      sourceA.query(`DELETE FROM ${T.closures} WHERE company_id=?`, [tenantA]),
    ).rejects.toThrow(/denied|privilege/i);
  });

  it('does not show or take closures across tenants (case 15)', async () => {
    const wA = world(sourceA);
    const incident = await resolved(wA);
    await close(wA, incident, 'key-close-tenant-iso');
    expect(await wA.closures.list(tenantB, incident.id)).toEqual([]);
    expect((await wA.closures.list(tenantA, incident.id)).length).toBe(1);
    const wB = world(sourceB);
    await expect(
      wB.workflow.execute(
        tenantA,
        MANAGER,
        incident.id,
        { command: 'reopen', version: 3, reason: 'x' },
        'key-reopen-foreign',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await wB.closures.list(tenantA, incident.id)).toEqual([]);
    expect(NO_CLOSURE_COSTS).toBeDefined();
  });
});
