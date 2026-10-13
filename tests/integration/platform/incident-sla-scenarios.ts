import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADDRESS,
  Cases,
  DAY,
  HOUR,
  T0,
  after,
  alertsOf,
  captureLogs,
  drainAll,
  kindsOf,
  type AlertRow,
  type SlaEnv,
} from './incident-sla-support.js';

/** Notices of one case that either the responsible or a supervisor sees, once each. */
async function noticesOf(env: SlaEnv, incidentId: string): Promise<AlertRow[]> {
  const seen = new Map<string, AlertRow>();
  for (const browser of [env.manager(), env.admin()])
    for (const row of await alertsOf(browser, `&incidentId=${incidentId}`)) seen.set(row.id, row);
  return [...seen.values()];
}
const scanA = (env: SlaEnv) => env.platform.incidentSlaModule.scanner.scan(env.tenantA);

async function setSettings(env: SlaEnv, patch: Record<string, unknown>) {
  const current = await env.admin().get('/api/alerts/settings');
  expect(current.status, current.text).toBe(200);
  const saved = await env.admin().put('/api/alerts/settings', {
    json: {
      version: current.json.version,
      expiryWindowDays: current.json.expiryWindowDays,
      recipientRoles: current.json.recipientRoles,
      ...patch,
    },
  });
  expect(saved.status, saved.text).toBe(200);
  return saved.json;
}

/**
 * Acceptance scenarios of INC-SLA that run the same on the in-memory composition and on real MySQL:
 * the case commands over HTTP, the SLA scan, the worker draining the outbox and the mail sink.
 */
export function defineSlaScenarios<E extends SlaEnv>(
  label: string,
  start: () => Promise<E>,
  /** More tests on the same world; they run before the one that revokes the responsible. */
  extra: (env: () => E) => void = () => undefined,
): void {
  let started: E | undefined;
  describe(`${label}: SLA, notices and mail`, { timeout: 120_000 }, () => {
    let env: SlaEnv;
    beforeAll(async () => {
      started = await start();
      env = started;
    }, 240_000);
    let cases: Cases;
    let casesB: Cases;
    const ready = async () => {
      cases ??= new Cases(env.manager, env.admin, env.vehicleA, env.managerId, 'a');
      casesB ??= new Cases(env.managerB, env.adminB, env.vehicleB, env.managerBId, 'b');
      await env.at(T0);
      return env;
    };

    it('warns at 80 % and breaches at 100 % exactly once, however many scans and workers (acceptance 1)', async () => {
      await ready();
      const item = await cases.assigned('high');
      const sla = (kinds: string[]) => kinds.filter((kind) => kind.startsWith('sla_'));
      await env.at(after(T0, 12 * DAY - 1000));
      await scanA(env);
      expect(sla(kindsOf(await noticesOf(env, item.id), item.id))).toEqual([]);
      await env.at(after(T0, 12 * DAY));
      await Promise.all([scanA(env), scanA(env)]);
      for (let n = 0; n < 8; n += 1) await scanA(env);
      expect(sla(kindsOf(await noticesOf(env, item.id), item.id))).toEqual(['sla_warning']);
      await env.at(after(T0, 15 * DAY - 1000));
      await scanA(env);
      expect(sla(kindsOf(await noticesOf(env, item.id), item.id))).toEqual(['sla_warning']);
      await env.at(after(T0, 15 * DAY));
      await Promise.all([scanA(env), scanA(env)]);
      for (let n = 0; n < 8; n += 1) await scanA(env);
      const rows = await noticesOf(env, item.id);
      expect(sla(kindsOf(rows, item.id))).toEqual(['sla_breach', 'sla_warning']);
      // One outbox event per notice, never more.
      expect(await env.alertEvents(env.tenantA, item.id)).toBe(rows.length);
      expect((await cases.detail(item)).sla).toMatchObject({
        cycle: 1,
        state: 'breached',
        targetDays: 15,
        elapsedPercent: 100,
      });
    });

    it('keeps the deadline at the same local hour in the tenant zone, not at midnight UTC (acceptance 2)', async () => {
      await ready();
      const item = await cases.assigned('high');
      const deadline = async () => (await cases.detail(item)).sla.deadline as string;
      await setSettings(env, { timeZone: 'America/Mexico_City' });
      expect(await deadline()).toBe('2026-11-16T16:00:00.000Z');
      await setSettings(env, { timeZone: 'UTC' });
      expect(await deadline()).toBe('2026-11-16T16:00:00.000Z');
      // A zone with a clock change inside the period keeps the local hour: 10:00 EDT is 10:00 EST.
      await env.at(new Date('2026-10-25T14:00:00.000Z'));
      const dst = await cases.assigned('high');
      await setSettings(env, { timeZone: 'America/New_York' });
      expect((await cases.detail(dst)).sla.deadline).toBe('2026-11-09T15:00:00.000Z');
      await setSettings(env, { timeZone: 'UTC' });
      expect((await cases.detail(dst)).sla.deadline).toBe('2026-11-09T14:00:00.000Z');
    });

    it('counts wall-clock hours without a responsible: 4 h, 24 h and assigning in time (acceptance 3)', async () => {
      await ready();
      const open = await cases.reported('low');
      const quick = await cases.reported('low');
      await env.at(after(T0, 3 * HOUR));
      await cases.assign(quick);
      const unassigned = async (incidentId: string) =>
        kindsOf(await noticesOf(env, incidentId), incidentId).filter((k) =>
          k.startsWith('unassigned'),
        );
      await env.at(after(T0, 4 * HOUR));
      await scanA(env);
      expect(await unassigned(open.id)).toEqual([]);
      await env.at(after(T0, 4 * HOUR + 1000));
      await scanA(env);
      expect(await unassigned(open.id)).toEqual(['unassigned']);
      await env.at(after(T0, 24 * HOUR));
      await scanA(env);
      await scanA(env);
      expect(await unassigned(open.id)).toEqual(['unassigned', 'unassigned_escalation']);
      expect(await unassigned(quick.id)).toEqual([]);
    });

    it('notices inactivity at N and 2N days and starts a new period after an edit (acceptance 4)', async () => {
      await ready();
      const item = await cases.assigned('low');
      const inactive = async () =>
        kindsOf(await noticesOf(env, item.id), item.id).filter((k) => k.startsWith('inactive'));
      await env.at(after(T0, 5 * DAY - 1000));
      await scanA(env);
      expect(await inactive()).toEqual([]);
      await env.at(after(T0, 5 * DAY));
      await scanA(env);
      expect(await inactive()).toEqual(['inactive']);
      await env.at(after(T0, 10 * DAY));
      await scanA(env);
      expect(await inactive()).toEqual(['inactive', 'inactive_escalation']);
      await env.at(after(T0, 10 * DAY + HOUR));
      await cases.edit(item, { description: 'Descripción sintética revisada' });
      await env.at(after(T0, 15 * DAY + HOUR));
      await scanA(env);
      await scanA(env);
      expect(await inactive()).toEqual(['inactive', 'inactive', 'inactive_escalation']);
    });

    it('retargets on a severity change: warning and breach of the new target once each (acceptance 5)', async () => {
      await ready();
      const item = await cases.assigned('low');
      await env.at(after(T0, 8 * DAY));
      await scanA(env);
      const sla = async () =>
        kindsOf(await noticesOf(env, item.id), item.id).filter((k) => k.startsWith('sla_'));
      expect(await sla()).toEqual([]);
      await cases.edit(item, { severity: 'critical' });
      await scanA(env);
      await Promise.all([scanA(env), scanA(env)]);
      expect(await sla()).toEqual(['sla_breach', 'sla_warning']);
      expect((await cases.detail(item)).sla).toMatchObject({ state: 'breached', targetDays: 7 });
      const timeline = await env.manager().get(`/api/v1/incidents/${item.id}/timeline`);
      expect(JSON.stringify(timeline.json)).toContain('severity');
    });

    it('keeps cycle 1 as met after a reopen, opens cycle 2 from the reopen and gives it its own notices (acceptance 6, 7)', async () => {
      await ready();
      const item = await cases.assigned('high');
      await env.at(after(T0, 10 * DAY));
      await cases.resolve(item);
      expect((await cases.detail(item)).sla).toMatchObject({ cycle: 1, state: 'met' });
      await env.at(after(T0, 11 * DAY));
      await cases.close(item);
      await scanA(env);
      // No SLA notice after the resolution, in `resolved` or `closed`.
      await env.at(after(T0, 100 * DAY));
      await scanA(env);
      const sla = async () =>
        (await noticesOf(env, item.id)).filter((row) => row.kind.startsWith('sla_'));
      expect(await sla()).toEqual([]);
      const reopenAt = after(T0, 20 * DAY);
      await env.at(reopenAt);
      await cases.reopen(item);
      const detail = await cases.detail(item);
      expect(detail.sla).toMatchObject({
        cycle: 2,
        startedAt: reopenAt.toISOString(),
        previousCycles: [{ cycle: 1, met: true }],
      });
      await env.at(after(reopenAt, 12 * DAY));
      await scanA(env);
      expect((await sla()).map((row) => [row.kind, row.cycle])).toEqual([['sla_warning', 2]]);
    });

    it('gives a closed or cancelled case no notice of any kind (acceptance 7)', async () => {
      await ready();
      const closed = await cases.assigned('critical');
      await cases.resolve(closed);
      await cases.close(closed);
      const cancelled = await cases.reported('critical');
      await cases.go(cancelled, { command: 'cancel', reason: 'Duplicado sintético' });
      await env.at(after(T0, 200 * DAY));
      await scanA(env);
      for (const item of [closed, cancelled])
        expect(await noticesOf(env, item.id), item.id).toEqual([]);
    });

    it('shows each member only their notices (acceptance 8)', async () => {
      await ready();
      const item = await cases.assigned('high');
      await env.at(after(T0, 12 * DAY));
      await scanA(env);
      const warning = (await alertsOf(env.manager(), `&incidentId=${item.id}`)).find(
        (row) => row.kind === 'sla_warning',
      ) as AlertRow;
      expect(warning).toBeDefined();
      expect(kindsOf(await alertsOf(env.viewer()), item.id)).toEqual([]);
      expect(kindsOf(await alertsOf(env.admin()), item.id)).not.toContain('sla_warning');
      await env.at(after(T0, 15 * DAY));
      await scanA(env);
      expect(kindsOf(await alertsOf(env.admin()), item.id)).toContain('sla_breach');
      expect(kindsOf(await alertsOf(env.viewer()), item.id)).toEqual([]);
    });

    it('keeps tenants apart: a scan of A reads and writes nothing of B (acceptance 10)', async () => {
      await ready();
      const mine = await cases.assigned('high');
      const theirs = await casesB.assigned('high');
      await env.at(after(T0, 12 * DAY));
      await scanA(env);
      expect(await alertsOf(env.adminB())).toEqual([]);
      expect(await env.alertEvents(env.tenantB, theirs.id)).toBe(0);
      expect(await env.alertEvents(env.tenantA, theirs.id)).toBe(0);
      expect(kindsOf(await noticesOf(env, mine.id), mine.id)).toContain('sla_warning');
      await env.platformB.incidentSlaModule.scanner.scan(env.tenantB);
      const seenByB = await alertsOf(env.managerB());
      expect(seenByB.map((row) => row.incidentId)).toEqual(expect.arrayContaining([theirs.id]));
      expect(seenByB.some((row) => row.incidentId === mine.id)).toBe(false);
      expect((await alertsOf(env.admin())).some((row) => row.incidentId === theirs.id)).toBe(false);
      expect((await env.adminB().get(`/api/v1/incidents/${mine.id}`)).status).toBe(404);
    });

    it('mails each recipient once with folio, kind and link, retries a failed port and keeps no address anywhere (acceptance 14)', async () => {
      await ready();
      const item = await cases.assigned('high');
      await env.at(after(T0, 12 * DAY));
      const logged = await captureLogs(async () => {
        await Promise.all([scanA(env), scanA(env)]);
        for (let n = 0; n < 8; n += 1) await scanA(env);
        env.mailer.failNext = 1;
        await Promise.all([drainAll(env.platform), drainAll(env.platform)]);
      });
      const warning = (await alertsOf(env.manager(), `&incidentId=${item.id}`)).find(
        (row) => row.kind === 'sla_warning',
      ) as AlertRow;
      const mailsOf = () => env.mailer.messages.filter((m) => m.alertId === warning.id);
      // The in-app notice stays whatever the port did; the failed send waits for its backoff.
      expect(warning).toBeDefined();
      await env.at(after(T0, 12 * DAY + HOUR));
      await drainAll(env.platform);
      await env.at(after(T0, 12 * DAY + 3 * HOUR));
      await drainAll(env.platform);
      const mails = mailsOf();
      expect(mails.map((m) => m.recipientId)).toEqual([`user-${env.managerId}`]);
      const [mail] = mails;
      expect(mail?.subject).toContain('SIN-');
      expect(`${mail?.subject} ${mail?.body}`).toContain(warning.folio);
      expect(mail?.body).toContain(`/incidents/${item.id}`);
      expect(`${mail?.subject} ${mail?.body}`).not.toMatch(
        /\$|MXN|importe|Calle|Descripción|Vehículo/i,
      );
      expect(env.mailer.attempts).toBeGreaterThanOrEqual(2);
      expect(logged.logs).not.toMatch(ADDRESS);
      expect(await env.dump(env.tenantA)).not.toMatch(ADDRESS);
    });

    it('notices the assignment once, to the responsible, whoever queues the event (assigned)', async () => {
      await ready();
      const item = await cases.assigned('high');
      // The MySQL case store queues the event with the assignment; the in-memory one does not.
      await env.queueAssigned?.(item.id, item.version);
      await drainAll(env.platform);
      await drainAll(env.platform);
      const assigned = (await alertsOf(env.manager(), `&incidentId=${item.id}`)).filter(
        (row) => row.kind === 'assigned',
      );
      expect(assigned).toHaveLength(1);
      const mails = env.mailer.messages.filter((m) => m.alertId === assigned[0]?.id);
      expect(mails.map((m) => m.recipientId)).toEqual([`user-${env.managerId}`]);
      expect(await alertsOf(env.viewer(), `&incidentId=${item.id}`)).toEqual([]);
    });

    extra(() => started as E);

    it('stops the notices and the mail of a revoked responsible, and the next scan creates nothing for them (acceptance 8)', async () => {
      await ready();
      const item = await cases.assigned('high');
      await env.at(after(T0, 12 * DAY));
      await scanA(env);
      const warning = (await alertsOf(env.manager(), `&incidentId=${item.id}`)).find(
        (row) => row.kind === 'sla_warning',
      ) as AlertRow;
      // The responsible is revoked: they see nothing, and the mail of what is pending skips them.
      await env.revokeManager();
      const before = env.mailer.messages.length;
      await env.at(after(T0, 16 * DAY));
      await scanA(env);
      await drainAll(env.platform);
      const sent = env.mailer.messages
        .slice(before)
        .filter((m) => m.recipientId.endsWith(env.managerId));
      expect(sent).toEqual([]);
      const forCase = env.mailer.messages.filter((m) => m.alertId === warning.id);
      expect(forCase.every((m) => !m.recipientId.endsWith(env.managerId))).toBe(true);
    });
  });
}
