import { vi } from 'vitest';
import type { Browser } from '../../../apps/api/bff/src/test-support.js';
import type { Platform } from '../../../apps/api/composition/src/index.js';
import { ROLE_PERMISSIONS, type RoleName } from '../../../apps/api/composition/src/access.js';
import { SinkMailAdapter } from '../../../packages/platform/mail/src/index.js';
import {
  SafeWebhookClient,
  verifyWebhook,
  type Resolver,
  type Transport,
  type TransportRequest,
  type VerifyResult,
} from '../../../packages/platform/webhooks/src/index.js';
import { startFleetDatabase, type FleetDatabase } from '../fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../fleet/world.js';

/** The journeys run this far past the database clock, so rows it stamps are already available. */
const MARGIN_MS = 60_000;
export const API = '/api/v1';

/**
 * A receiver on this machine: the transport the safe client calls instead of the network. The client
 * still resolves, guards and signs exactly as it does for a real destination; the receiver keeps what
 * it got and checks the signature the way the documentation shows (`verifyWebhook`).
 */
export class LocalReceiver {
  public readonly received: TransportRequest[] = [];
  public status = 200;
  public readonly transport: Transport = async (request) => {
    this.received.push(request);
    return { status: this.status };
  };
  public verify(index: number, secret: string, nowMs = Date.now()): VerifyResult {
    const request = this.received[index];
    if (!request) throw new Error(`no delivery at ${index}`);
    return verifyWebhook({
      secrets: [secret],
      headers: request.headers,
      body: request.body,
      nowMs,
    });
  }
  public bodyOf(index: number): string {
    return Buffer.from(this.received[index]?.body ?? new Uint8Array()).toString('utf8');
  }
}

/**
 * A reader of the audit trail that also reads incidents but never their amounts: no shipped template
 * groups those grants (the real catalog belongs to the roles slice), so it exists only while this folder runs.
 */
const INCIDENT_AUDITOR = ['view', 'view_audit', 'incidents:view'] as const;

/** A public address for any name: the guard accepts it; the receiver above answers instead of the network. */
const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

export interface MvpWorld extends FleetWorld {
  readonly database: FleetDatabase;
  readonly mailA: SinkMailAdapter;
  readonly mailB: SinkMailAdapter;
  readonly receiverA: LocalReceiver;
  readonly receiverB: LocalReceiver;
  /** Reads and audits (`view_audit`) but does not export, and sees no costs or personal data. */
  readonly auditorA: Browser;
  /** Reads the audit trail and incidents, without incident costs. */
  readonly incidentAuditorA: Browser;
  /** Personal data reader (`view_pii`) of company A. */
  readonly piiA: Browser;
  /** Incident manager: sees incident costs. */
  readonly managerA: Browser;
  readonly managerAId: string;
  /** Company B's viewer, to look across. */
  readonly viewerB: Browser;
  stop(): Promise<void>;
}

/** The fleet harness (two MySQL databases, one composition each) with mail sinks and local receivers. */
export async function startMvpWorld(): Promise<MvpWorld> {
  const mailA = new SinkMailAdapter({ retain: 500 });
  const mailB = new SinkMailAdapter({ retain: 500 });
  const receiverA = new LocalReceiver();
  const receiverB = new LocalReceiver();
  const database = await startFleetDatabase();
  let fleet: FleetWorld;
  try {
    fleet = await startFleetWorld(database, {
      a: {
        mail: mailA,
        webhookClient: new SafeWebhookClient({
          resolve: publicResolver,
          transport: receiverA.transport,
        }),
        webhookResolver: publicResolver,
      },
      b: {
        mail: mailB,
        webhookClient: new SafeWebhookClient({
          resolve: publicResolver,
          transport: receiverB.transport,
        }),
        webhookResolver: publicResolver,
      },
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  const { worldA, worldB } = fleet;
  const templates = ROLE_PERMISSIONS as Record<string, readonly string[]>;
  templates['incident_auditor'] = INCIDENT_AUDITOR;
  await worldA.member('subject-admin-a', 'auditor', 'subject-auditor-a');
  await worldA.member('subject-admin-a', 'pii_reader', 'subject-pii-a');
  await worldA.member('subject-admin-a', 'incident_auditor' as RoleName, 'subject-iaud-a');
  const manager = await worldA.member('subject-admin-a', 'incident_manager', 'subject-manager-a');
  await worldB.member('subject-admin-b', 'viewer', 'subject-viewer-b');
  // The database stamps rows with its own clock, which is later than the fixtures': move to the journeys'
  // instant, then sign everybody in again (a session idles out when the clock jumps).
  const [clock] = await database.rows<{ ms: string | number }>(
    'SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS ms',
  );
  vi.setSystemTime(new Date(Math.round(Number(clock?.ms)) + MARGIN_MS));
  const [
    adminA,
    adminA2,
    adminB,
    viewerA,
    editorA,
    auditorA,
    incidentAuditorA,
    piiA,
    managerA,
    viewerB,
  ] = await Promise.all([
    worldA.loginAs('subject-admin-a'),
    worldA.loginAs('subject-admin-a'),
    worldB.loginAs('subject-admin-b'),
    worldA.loginAs('subject-viewer-a'),
    worldA.loginAs('subject-editor-a'),
    worldA.loginAs('subject-auditor-a'),
    worldA.loginAs('subject-iaud-a'),
    worldA.loginAs('subject-pii-a'),
    worldA.loginAs('subject-manager-a'),
    worldB.loginAs('subject-viewer-b'),
  ]);
  return {
    ...fleet,
    adminA,
    adminA2,
    adminB,
    viewerA,
    editorA,
    database,
    mailA,
    mailB,
    receiverA,
    receiverB,
    auditorA,
    incidentAuditorA,
    piiA,
    managerA,
    managerAId: manager.identityId,
    viewerB,
    async stop() {
      delete templates['incident_auditor'];
      fleet.world.dispose();
      await database.close();
    },
  };
}

export const job = (platform: Platform, name: string) => {
  const found = platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
};

/** Runs the outbox until nothing is claimable. */
export async function drain(platform: Platform): Promise<void> {
  for (let round = 0; round < 20; round += 1)
    if ((await platform.runtime.drainOutbox(500)) === 0) return;
}

/** One pass of the whole tick, as the api process runs it: the outbox, then every other job. */
export async function tick(platform: Platform): Promise<void> {
  await drain(platform);
  for (const item of platform.runtime.jobs.list()) if (item.name !== 'outbox') await item.run();
  await drain(platform);
}
