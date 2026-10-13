import { expect, vi } from 'vitest';
import type { Platform } from '../../../apps/api/composition/src/index.js';
import type { Browser } from '../../../apps/api/bff/src/test-support.js';
import { TestSinkMailer } from '../../../apps/worker/incident-sla/src/index.js';
import type { AlertMessage } from '../../../packages/domain/incidents/sla/src/index.js';

export const P = '/api/v1/incidents';
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** 2026-11-01 10:00 in America/Mexico_City (UTC-6): the report instant of the acceptance cases. */
export const T0 = new Date('2026-11-01T16:00:00.000Z');
export const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** The sink of the composition, told to fail the next sends: the mail port going down. */
export class FlakyMailer extends TestSinkMailer {
  public failNext = 0;
  public attempts = 0;
  public override async send(message: AlertMessage): Promise<void> {
    this.attempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mail port down');
    }
    await super.send(message);
  }
}

export interface AlertRow {
  readonly id: string;
  readonly incidentId: string;
  readonly folio: string;
  readonly kind: string;
  readonly cycle: number;
  readonly createdAt: string;
  readonly severity: string | null;
  readonly deadline: string | null;
}

/** What the scenarios need from a world: in memory (one platform) or on MySQL (one per tenant). */
export interface SlaEnv {
  readonly platform: Platform;
  readonly platformB: Platform;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly vehicleA: string;
  readonly vehicleB: string;
  readonly managerId: string;
  readonly managerBId: string;
  readonly mailer: FlakyMailer;
  readonly mailerB: FlakyMailer;
  manager(): Browser;
  admin(): Browser;
  viewer(): Browser;
  managerB(): Browser;
  adminB(): Browser;
  /** Moves the clock and signs everybody in again (sessions idle out). */
  at(date: Date): Promise<void>;
  /** Removes the responsible from the company (a revoked membership). */
  revokeManager(): Promise<void>;
  /** Queues the assignment event by hand where the case store does not (in memory). */
  queueAssigned?(incidentId: string, version: number): Promise<void>;
  /** Number of `incident.sla_alert` events written for a case, in the tenant's outbox. */
  alertEvents(tenantId: string, incidentId: string): Promise<number>;
  /** Everything the tenant's outbox and delivery tables hold, as text (to look for addresses). */
  dump(tenantId: string): Promise<string>;
}

export const ADDRESS = /@/;

export interface Case {
  readonly id: string;
  version: number;
}

/** A case of the SLA scenarios, driven over HTTP as the manager (and the administrator for reopen). */
export class Cases {
  private keys = 0;
  public constructor(
    private readonly browser: () => Browser,
    private readonly admin: () => Browser,
    private readonly vehicleId: string,
    private readonly responsibleId: string,
    private readonly tag: string,
  ) {}
  private key = () => `key-sla-${this.tag}-${(this.keys += 1)}-${Date.now()}`;

  public async draft(severity = 'high'): Promise<Case> {
    const created = await this.browser().post(P, {
      json: {
        vehicleId: this.vehicleId,
        type: 'other',
        severity,
        occurredAt: new Date().toISOString(),
        location: { text: 'Calle Sintética' },
        description: 'Descripción sintética',
        vehicleOperable: true,
        noDriverReason: 'Vehículo estacionado',
        noPhotoJustification: 'Sin foto disponible',
      },
    });
    expect(created.status, created.text).toBe(201);
    return { id: created.json.id, version: created.json.version };
  }
  public async go(
    item: Case,
    json: Record<string, unknown>,
    browser: Browser = this.browser(),
  ): Promise<void> {
    const reply = await browser.post(`${P}/${item.id}/transitions`, {
      json: { version: item.version, ...json },
      headers: { 'idempotency-key': this.key() },
    });
    expect(reply.status, reply.text).toBe(200);
    item.version = reply.json.version;
  }
  public async reported(severity = 'high'): Promise<Case> {
    const item = await this.draft(severity);
    await this.go(item, { command: 'report' });
    return item;
  }
  public async assigned(severity = 'high'): Promise<Case> {
    const item = await this.reported(severity);
    await this.assign(item);
    return item;
  }
  public assign(item: Case) {
    return this.go(item, { command: 'assign', responsibleId: this.responsibleId });
  }
  public async edit(item: Case, patch: Record<string, unknown>): Promise<void> {
    const reply = await this.browser().send('PATCH', `${P}/${item.id}`, {
      json: { version: item.version, ...patch },
    });
    expect(reply.status, reply.text).toBe(200);
    item.version = reply.json.version;
  }
  public async resolve(item: Case): Promise<void> {
    await this.go(item, { command: 'review' });
    const filled = await this.browser().put(`${P}/${item.id}/resolution`, {
      json: {
        version: item.version,
        resolutionSummary: 'Resuelto de forma sintética',
        vehicleStatusDecision: 'restricted',
      },
    });
    expect(filled.status, filled.text).toBe(200);
    item.version = filled.json.version;
    await this.go(item, { command: 'resolve' });
  }
  public close(item: Case) {
    return this.go(item, { command: 'close' });
  }
  public reopen(item: Case) {
    return this.go(item, { command: 'reopen', reason: 'Reapertura sintética' }, this.admin());
  }
  public async detail(item: Case) {
    const reply = await this.browser().get(`${P}/${item.id}`);
    expect(reply.status, reply.text).toBe(200);
    return reply.json;
  }
}

/** The notices a member sees, newest first, all pages. */
export async function alertsOf(browser: Browser, query = ''): Promise<AlertRow[]> {
  const reply = await browser.get(`${P}/alerts?limit=100${query}`);
  expect(reply.status, reply.text).toBe(200);
  return reply.json.items as AlertRow[];
}
export const kindsOf = (rows: readonly AlertRow[], incidentId: string) =>
  rows
    .filter((row) => row.incidentId === incidentId)
    .map((row) => row.kind)
    .sort();

/** Runs the outbox until nothing is claimable; failed jobs wait for their backoff. */
export async function drainAll(platform: Platform): Promise<void> {
  for (let round = 0; round < 20; round += 1)
    if ((await platform.runtime.drainOutbox(500)) === 0) return;
}

/** Console output of a block, as text. */
export async function captureLogs<T>(work: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      );
    }),
  );
  try {
    return { result: await work(), logs: lines.join('\n') };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
