import type { Browser } from '../../../apps/api/bff/src/test-support.js';
import { expect } from 'vitest';
import { P, type IncidentsWorld } from './world.js';

export interface Case {
  readonly id: string;
  readonly version: number;
}

/** What the journeys write as free text: it must never reach the audit trail or the outbox. */
export const FREE_TEXT = 'Texto libre sintético del recorrido';
export const MXN = (amountMinor: string) => ({ amountMinor, currency: 'MXN' });

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(512, 7),
]);

/** The steps every journey repeats, over the HTTP surface of a company: nothing reaches into the stores. */
export function journeySteps(w: IncidentsWorld) {
  const today = () => w.now().toISOString().slice(0, 10);
  const ok = <T extends { status: number; text: string }>(reply: T, status = 200): T => {
    expect(reply.status, reply.text).toBe(status);
    return reply;
  };

  const draft = async (browser: Browser = w.reporter, over: Record<string, unknown> = {}) => {
    const created = ok(
      await browser.post(P, {
        json: {
          vehicleId: w.vehicleA,
          type: 'collision',
          severity: 'medium',
          occurredAt: w.now().toISOString(),
          location: { text: 'Calle Sintética' },
          description: FREE_TEXT,
          vehicleOperable: true,
          noDriverReason: 'Vehículo estacionado',
          noPhotoJustification: 'Sin foto disponible',
          policyId: w.policyA,
          ...over,
        },
      }),
      201,
    );
    return created.json as Case & { folio: string };
  };

  const go = (browser: Browser, id: string, json: Record<string, unknown>, keyed = false) =>
    browser.post(`${P}/${id}/transitions`, {
      json,
      ...(keyed ? { headers: w.key() } : {}),
    });
  const step = async (
    browser: Browser,
    id: string,
    version: number,
    command: string,
    extra: Record<string, unknown> = {},
    keyed = false,
  ): Promise<Case> => {
    const reply = ok(await go(browser, id, { command, version, ...extra }, keyed));
    return { id, version: reply.json.version as number };
  };

  const put = async (
    browser: Browser,
    id: string,
    section: 'insurance' | 'resolution',
    version: number,
    body: Record<string, unknown>,
  ): Promise<Case> => {
    const reply = ok(await browser.put(`${P}/${id}/${section}`, { json: { version, ...body } }));
    return { id, version: reply.json.version as number };
  };

  const costs = async (
    browser: Browser,
    id: string,
    version: number,
    lines: readonly Record<string, unknown>[],
  ): Promise<Case> => {
    const reply = ok(
      await browser.put(`${P}/${id}/costs`, { json: { version, lines }, headers: w.key() }),
    );
    return { id, version: reply.json.version as number };
  };
  const expense = (category: string, amountMinor: string) => ({
    kind: 'expense',
    category,
    amount: MXN(amountMinor),
  });

  const evidence = async (
    browser: Browser,
    id: string,
    version: number,
    category: string,
    stage = 'other',
  ): Promise<Case> => {
    const reply = ok(
      await browser.post(`${P}/${id}/evidence`, {
        json: {
          version,
          category,
          stage,
          name: `${category}.png`,
          contentType: 'image/png',
          clientCompressed: true,
          contentBase64: PNG.toString('base64'),
        },
      }),
      201,
    );
    return { id, version: reply.json.version as number };
  };
  /** The antivirus pipeline marks the quarantined evidence clean, as the worker does. */
  const scan = async (): Promise<void> => {
    await w.platformA.pipeline.processScans();
  };

  /** Reported by its author, assigned to the manager and under review: the common start of every route. */
  const underReview = async (over: Record<string, unknown> = {}): Promise<Case> => {
    const created = await draft(w.reporter, over);
    const reported = await step(w.reporter, created.id, created.version, 'report');
    const assigned = await step(w.manager, created.id, reported.version, 'assign', {
      responsibleId: w.managerId,
    });
    return step(w.manager, created.id, assigned.version, 'review');
  };

  /** Sets (or clears) the D20 threshold of company A; amounts are read with the administrator. */
  const threshold = async (amountMinor: string | null): Promise<void> => {
    const current = ok(await w.adminA.get('/api/alerts/settings'));
    ok(
      await w.adminA.put('/api/alerts/settings', {
        json: {
          version: current.json.version,
          expiryWindowDays: 7,
          recipientRoles: ['admin'],
          closeCostThreshold: amountMinor === null ? null : MXN(amountMinor),
        },
      }),
    );
  };

  const read = async (browser: Browser, id: string) =>
    ok(await browser.get(`${P}/${id}`)).json as Record<string, any>;
  const nextSteps = async (browser: Browser, id: string) =>
    (ok(await browser.get(`${P}/${id}/next-steps`)).json.items as { command: string }[]).map(
      (item) => item.command,
    );
  const timeline = (id: string) =>
    w.database.rows<{ command: string }>(
      'SELECT command FROM opslog_incident_transitions WHERE incident_id = ? ORDER BY sequence',
      [id],
    );

  /**
   * No free text, amount or note reached the audit trail or the outbox of company A. The timeline of the
   * case (its transitions) is where comments live, so it is the one place that may hold them.
   */
  const expectNoLeak = async (secrets: readonly string[]): Promise<void> => {
    for (const table of ['opslog_audit_local', 'opslog_tenant_outbox']) {
      const dump = JSON.stringify(await w.database.rows(`SELECT * FROM ${table}`));
      for (const secret of secrets) expect(dump, `${table} ${secret}`).not.toContain(secret);
    }
  };

  return {
    today,
    ok,
    draft,
    go,
    step,
    put,
    costs,
    expense,
    evidence,
    scan,
    underReview,
    threshold,
    read,
    nextSteps,
    timeline,
    expectNoLeak,
  };
}
export type JourneySteps = ReturnType<typeof journeySteps>;
