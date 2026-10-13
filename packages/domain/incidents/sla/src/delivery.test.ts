import { describe, expect, it } from 'vitest';
import { DeliveryPendingError, MAX_DELIVERY_ATTEMPTS } from './delivery.js';
import { INCIDENT_SLA_ALERT_EVENT } from './events.js';
import {
  ADMIN,
  DAY,
  HOUR,
  MANAGER,
  REPORTED_AT,
  TENANT_A,
  TENANT_B,
  VIEWER,
  at,
  reportedCase,
  slaWorld,
  type SlaWorld,
} from './test-support.js';

const payloadOf = (world: SlaWorld, kind: string) => {
  const event = world.events.find((e) => e.payload['kind'] === kind);
  if (!event) throw new Error(`no ${kind} event`);
  return event.payload;
};
const warn = async (world: SlaWorld, patch = {}) => {
  const incident = await reportedCase(world, { responsibleId: MANAGER.id, ...patch });
  world.clock.current = at(REPORTED_AT, 12 * DAY);
  await world.scanner.scan(TENANT_A);
  return { incident, payload: payloadOf(world, 'sla_warning') };
};

describe('e-mail of a notice (acceptance 14)', () => {
  it('sends one message with the folio, kind, severity and link, and nothing else of the case', async () => {
    const world = slaWorld();
    const { incident, payload } = await warn(world);
    expect(await world.delivery().deliver(TENANT_A, payload)).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
      pending: 0,
    });
    expect(world.mailer.sent).toHaveLength(1);
    const [mail] = world.mailer.sent;
    expect(mail).toMatchObject({
      tenantId: TENANT_A,
      recipientId: MANAGER.id,
      to: `${MANAGER.id}@tenant-a.example.test`,
    });
    expect(mail?.subject).toContain(incident.folio);
    expect(mail?.body).toBe(
      [
        `Folio: ${incident.folio}`,
        'Aviso: El SLA del siniestro alcanzó el 80 %',
        'Severidad: Alta',
        `Enlace: /incidents/${incident.id}`,
      ].join('\n'),
    );
    // None of the free text, names or places of the synthetic case reaches the message.
    for (const text of ['Choque lateral', 'Av. Sintética', 'Sin cámara', 'Ana Pérez'])
      expect(`${mail?.subject}\n${mail?.body}`).not.toContain(text);
    expect(await world.slaStore.deliveries(TENANT_A, String(payload['alertId']))).toEqual([
      {
        tenantId: TENANT_A,
        alertId: payload['alertId'],
        recipientId: MANAGER.id,
        channel: 'email',
        status: 'sent',
        attempts: 1,
        nextAttemptAt: null,
      },
    ]);
  });

  it('does not send twice for a rerun, a retry or two workers at once', async () => {
    const world = slaWorld();
    const { payload } = await warn(world);
    const results = await Promise.allSettled([
      world.delivery().deliver(TENANT_A, payload),
      world.delivery().deliver(TENANT_A, payload),
    ]);
    // The loser either found the row final or was told to come back; it never sent.
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(DeliveryPendingError);
    await world.delivery().deliver(TENANT_A, payload);
    await world.delivery().deliver(TENANT_A, payload);
    expect(world.mailer.sent).toHaveLength(1);
  });

  it('retries a failing port without touching the notice, then sends once', async () => {
    const world = slaWorld();
    const { payload } = await warn(world);
    world.mailer.failNext = 1;
    await expect(world.delivery().deliver(TENANT_A, payload)).rejects.toBeInstanceOf(
      DeliveryPendingError,
    );
    expect(world.slaStore.all(TENANT_A).some((a) => a.kind === 'sla_warning')).toBe(true);
    const [row] = await world.slaStore.deliveries(TENANT_A, String(payload['alertId']));
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row?.nextAttemptAt).not.toBeNull();
    // The retry runs once the lease is over.
    world.clock.current = at(REPORTED_AT, 12 * DAY + 10 * 60_000);
    await world.delivery().deliver(TENANT_A, payload);
    expect(world.mailer.sent).toHaveLength(1);
    expect(world.mailer.attempts).toBe(2);
  });

  it('marks the row failed after the attempts are used up, and keeps the notice', async () => {
    const world = slaWorld();
    const { payload } = await warn(world);
    world.mailer.failNext = 99;
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      world.clock.current = at(REPORTED_AT, 12 * DAY + attempt * HOUR);
      await expect(world.delivery().deliver(TENANT_A, payload)).rejects.toBeInstanceOf(
        DeliveryPendingError,
      );
    }
    world.clock.current = at(REPORTED_AT, 12 * DAY + 10 * HOUR);
    expect(await world.delivery().deliver(TENANT_A, payload)).toMatchObject({
      failed: 1,
      pending: 0,
    });
    const [row] = await world.slaStore.deliveries(TENANT_A, String(payload['alertId']));
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS });
    expect(world.mailer.sent).toHaveLength(0);
    // Final: another run neither sends nor asks for a retry.
    world.mailer.failNext = 0;
    await world.delivery().deliver(TENANT_A, payload);
    expect(world.mailer.sent).toHaveLength(0);
    expect(world.slaStore.all(TENANT_A).length).toBeGreaterThan(0);
  });

  it('asks the outbox to come back while another worker holds the row', async () => {
    const world = slaWorld();
    const { payload } = await warn(world);
    const key = {
      tenantId: TENANT_A,
      alertId: String(payload['alertId']),
      recipientId: MANAGER.id,
      channel: 'email',
    } as const;
    expect(
      await world.slaStore.claimDelivery(key, world.clock.current.toISOString(), 300_000),
    ).toEqual({
      result: 'claimed',
      attempt: 1,
    });
    await expect(world.delivery().deliver(TENANT_A, payload)).rejects.toBeInstanceOf(
      DeliveryPendingError,
    );
    expect(world.mailer.sent).toHaveLength(0);
  });

  it('skips a recipient who was revoked, lost the right, is mechanic-scoped or has no address', async () => {
    for (const change of [
      (w: SlaWorld) => w.directory.revoke(TENANT_A, MANAGER.id),
      (w: SlaWorld) => w.directory.set(TENANT_A, MANAGER.id, ['view', 'incidents:edit']),
      (w: SlaWorld) => w.directory.set(TENANT_A, MANAGER.id, ['incidents:view'], true),
      (w: SlaWorld) => w.addresses.missing.add(MANAGER.id),
    ]) {
      const world = slaWorld();
      const { payload } = await warn(world);
      change(world);
      expect(await world.delivery().deliver(TENANT_A, payload)).toMatchObject({
        sent: 0,
        skipped: 1,
      });
      expect(world.mailer.sent).toHaveLength(0);
      const rows = await world.slaStore.deliveries(TENANT_A, String(payload['alertId']));
      expect(rows.map((row) => row.status)).toEqual(['skipped']);
    }
  });

  it('records skipped, and sends nothing, for a case that is terminal by the time it runs', async () => {
    const world = slaWorld();
    const { incident, payload } = await warn(world);
    const current = (await world.store.get(TENANT_A, incident.id))!;
    await world.store.apply({
      incident: { ...current, status: 'closed', version: current.version + 1 },
      expectedVersion: current.version,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    expect(await world.delivery().deliver(TENANT_A, payload)).toMatchObject({
      sent: 0,
      skipped: 1,
    });
    expect(world.mailer.sent).toHaveLength(0);
  });

  it('sends the escalations to the supervisors and the managers, once each, in the right tenant', async () => {
    const world = slaWorld();
    world.directory.set(TENANT_B, 'user-b-admin', ['incidents:view', 'incidents:approve']);
    await reportedCase(world);
    world.clock.current = at(REPORTED_AT, 25 * HOUR);
    await world.scanner.scan(TENANT_A);
    const payload = payloadOf(world, 'unassigned_escalation');
    await world.delivery().deliver(TENANT_A, payload);
    // Managers (edit) and supervisors (approve) get it; a viewer and the other tenant do not.
    expect(world.mailer.sent.map((m) => m.recipientId).sort()).toEqual(
      [ADMIN.id, MANAGER.id].sort(),
    );
    expect(world.mailer.sent.some((m) => m.recipientId === VIEWER.id)).toBe(false);
    expect(world.mailer.sent.every((m) => m.tenantId === TENANT_A)).toBe(true);
    // The same payload read in another tenant names nothing.
    expect(await world.delivery().deliver(TENANT_B, payload)).toMatchObject({ sent: 0 });
  });

  it('sends the assignment notice to the new responsible only while they still are', async () => {
    const world = slaWorld();
    const incident = await reportedCase(world, { responsibleId: MANAGER.id });
    await world.scanner.onAssigned(TENANT_A, { incidentId: incident.id, version: 2 });
    const payload = payloadOf(world, 'assigned');
    const current = (await world.store.get(TENANT_A, incident.id))!;
    await world.store.apply({
      incident: { ...current, responsibleId: ADMIN.id, version: current.version + 1 },
      expectedVersion: current.version,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    expect(await world.delivery().deliver(TENANT_A, payload)).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
    });
  });

  it('falls back to the case managers while a quiet or overdue case has no responsible', async () => {
    const world = slaWorld();
    await reportedCase(world, { status: 'under_review' });
    world.clock.current = at(REPORTED_AT, 5 * DAY);
    await world.scanner.scan(TENANT_A);
    await world.delivery().deliver(TENANT_A, payloadOf(world, 'inactive'));
    expect(world.mailer.sent.map((m) => m.recipientId).sort()).toEqual(
      [ADMIN.id, MANAGER.id].sort(),
    );
  });

  it('names nothing for an unknown notice or one of another case, and rejects a bad payload', async () => {
    const world = slaWorld();
    const { payload } = await warn(world);
    expect(
      await world.delivery().deliver(TENANT_A, { ...payload, alertId: 'sla-unknown' }),
    ).toMatchObject({ sent: 0 });
    expect(
      await world.delivery().deliver(TENANT_A, { ...payload, incidentId: 'other-case' }),
    ).toMatchObject({ sent: 0 });
    for (const bad of [
      null,
      [],
      { ...payload, extra: 1 },
      { ...payload, kind: 'nope' },
      { ...payload, cycle: 0 },
    ])
      await expect(world.delivery().deliver(TENANT_A, bad)).rejects.toThrow();
    expect(world.mailer.sent).toHaveLength(0);
    expect(INCIDENT_SLA_ALERT_EVENT).toBe('incident.sla_alert');
  });
});
