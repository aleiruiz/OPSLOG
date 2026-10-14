import mysql from 'mysql2/promise';
import type { Browser } from '../../../apps/api/bff/src/test-support.js';
import { ROLE_PERMISSIONS, type RoleName } from '../../../apps/api/composition/src/access.js';
import type { Permission } from '../../../packages/domain/identity/src/index.js';
import { startFleetDatabase, type FleetDatabase } from '../fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../fleet/world.js';

/**
 * Synthetic roles with the ADR-0014 permissions that no shipped template groups: the real catalog
 * belongs to the roles slice. They exist only while a suite of this folder runs.
 */
export const SYNTHETIC_ROLES = {
  /** Approves the D20 costs, closes and reopens, and sees amounts. Edits nothing by itself. */
  incident_supervisor: [
    'view',
    'incidents:view',
    'incidents:approve',
    'incidents:close',
    'incidents:reopen',
    'incidents:view_costs',
  ],
  /** Reports what happened: creates and reports its own drafts. No amounts, no edits of others. */
  incident_reporter: ['view', 'incidents:view', 'incidents:create', 'incidents:report'],
} as const satisfies Record<string, readonly Permission[]>;

export type SyntheticRole = keyof typeof SYNTHETIC_ROLES;

function registerSyntheticRoles(): void {
  const templates = ROLE_PERMISSIONS as Record<string, readonly Permission[]>;
  for (const [name, permissions] of Object.entries(SYNTHETIC_ROLES)) templates[name] = permissions;
}

export const P = '/api/v1/incidents';
export const W = '/api/v1/work-orders';

export interface IncidentsWorld extends FleetWorld {
  readonly database: FleetDatabase;
  readonly manager: Browser;
  readonly managerId: string;
  readonly supervisor: Browser;
  readonly supervisorId: string;
  readonly reporter: Browser;
  readonly reporterId: string;
  readonly managerB: Browser;
  readonly managerBId: string;
  readonly vehicleA: string;
  readonly vehicleB: string;
  /** A policy of tenant A that covers every day from 2020 to 2099. */
  readonly policyA: string;
  /**
   * Moves the deterministic clock of both companies. Sessions idle for longer than their limit would
   * expire, so every browser of the world signs in again at the new time and keeps its identity.
   */
  advance(ms: number): Promise<void>;
  now(): Date;
  /** An `Idempotency-Key` header that never repeats within the run. */
  key(): { readonly 'idempotency-key': string };
  /** Opens a connection with the exact-grants runtime account of the incidents module of tenant A. */
  connectAsRuntime(): Promise<mysql.Connection>;
  stop(): Promise<void>;
}

let sequence = 0;
const label = (prefix: string): string => `${prefix}${(sequence += 1)}`;

/**
 * The fleet harness (two physical MySQL databases, exact-grants runtime accounts, one composition
 * per company) plus the people and the clock every incident journey needs.
 */
export async function startIncidentsWorld(): Promise<IncidentsWorld> {
  registerSyntheticRoles();
  const database = await startFleetDatabase();
  const fleet = await startFleetWorld(database);
  const { worldA, worldB } = fleet;
  const manager = await worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  const supervisor = await worldA.member(
    'subject-admin-a',
    'incident_supervisor' as RoleName,
    'subject-supervisor-a',
  );
  const reporter = await worldA.member(
    'subject-admin-a',
    'incident_reporter' as RoleName,
    'subject-reporter-a',
  );
  const managerB = await worldB.member('subject-admin-b', 'incident_manager', 'subject-manager-b');
  const [managerBrowser, supervisorBrowser, reporterBrowser, managerBBrowser] = await Promise.all([
    worldA.loginAs('subject-manager-a'),
    worldA.loginAs('subject-supervisor-a'),
    worldA.loginAs('subject-reporter-a'),
    worldB.loginAs('subject-manager-b'),
  ]);
  const vehicleA = await fleet.vehicle(fleet.adminA, await fleet.area(fleet.adminA), 'IJ-A');
  const vehicleB = await fleet.vehicle(fleet.adminB, await fleet.area(fleet.adminB), 'IJ-B');
  const policy = await fleet.adminA.post('/api/insurance-policies', {
    json: {
      vehicleId: vehicleA,
      insurer: 'Aseguradora Sintética',
      policyNumber: 'SYNTH-POL-IJ',
      coverageType: 'comprehensive',
      startsOn: '2020-01-01',
      endsOn: '2099-12-31',
    },
  });
  if (policy.status !== 201) throw new Error(`policy fixture failed: ${policy.status}`);

  const sessions: readonly (readonly [Browser, string, 'a' | 'b'])[] = [
    [managerBrowser, 'subject-manager-a', 'a'],
    [supervisorBrowser, 'subject-supervisor-a', 'a'],
    [reporterBrowser, 'subject-reporter-a', 'a'],
    [managerBBrowser, 'subject-manager-b', 'b'],
    [fleet.adminA, 'subject-admin-a', 'a'],
    [fleet.adminB, 'subject-admin-b', 'b'],
  ];

  return {
    ...fleet,
    database,
    manager: managerBrowser,
    managerId: manager.identityId,
    supervisor: supervisorBrowser,
    supervisorId: supervisor.identityId,
    reporter: reporterBrowser,
    reporterId: reporter.identityId,
    managerB: managerBBrowser,
    managerBId: managerB.identityId,
    vehicleA,
    vehicleB,
    policyA: policy.json.id as string,
    async advance(ms) {
      worldA.advance(ms);
      for (const [browser, subject, side] of sessions) {
        const fresh = await (side === 'a' ? worldA : worldB).loginAs(subject);
        browser.jar.clear();
        for (const [name, value] of fresh.jar) browser.jar.set(name, value);
        browser.csrf = fresh.csrf;
      }
    },
    now: () => new Date(),
    key: () => ({ 'idempotency-key': `${label('key-ij-')}-${Date.now()}` }),
    async connectAsRuntime() {
      const account = database.accounts.incidents;
      return mysql.createConnection({
        host: database.host,
        port: database.port,
        user: account.username,
        password: account.password,
        database: database.databaseName,
      });
    },
    async stop() {
      fleet.world.dispose();
      await database.close();
    },
  };
}
