import { describe, expect, it, vi } from 'vitest';
import {
  INCIDENT_ASSIGNED_EVENT,
  INCIDENT_SLA_ALERT_EVENT,
  INCIDENT_SLA_SCAN_EVENT,
  TestSinkMailer,
  registerIncidentSlaHandlers,
  selectIncidentAlertMailer,
} from './index.js';

type H = (p: unknown, e: { tenantId: string; eventId: string; type: string }) => unknown;
function setup() {
  const handlers = new Map<string, H>();
  const sla = {
    scanner: { scan: vi.fn(async () => ({})), onAssigned: vi.fn(async () => true) },
    delivery: { deliver: vi.fn(async () => ({})) },
  };
  registerIncidentSlaHandlers({ register: (t, h) => handlers.set(t, h) }, sla as never);
  const run = (type: string, payload: unknown, tenantId = 'tenant-a') =>
    handlers.get(type)?.(payload, { tenantId, eventId: 'e1', type });
  return { sla, run };
}

describe('incident SLA outbox handlers', () => {
  it('scans with the tenant of the claimed envelope, for one case or for all', async () => {
    const { sla, run } = setup();
    await run(INCIDENT_SLA_SCAN_EVENT, {});
    await run(INCIDENT_SLA_SCAN_EVENT, { incidentId: 'inc-1' }, 'tenant-b');
    expect(sla.scanner.scan.mock.calls).toEqual([
      ['tenant-a', undefined],
      ['tenant-b', 'inc-1'],
    ]);
  });
  it('refuses a tenant in the payload, extra keys and malformed ids', async () => {
    const { sla, run } = setup();
    for (const bad of [
      { tenantId: 'tenant-b' },
      { incidentId: 'inc-1', extra: 1 },
      { incidentId: 5 },
      null,
      [],
    ])
      await expect(run(INCIDENT_SLA_SCAN_EVENT, bad)).rejects.toThrow('invalid incident SLA job');
    expect(sla.scanner.scan).not.toHaveBeenCalled();
  });
  it('handles the assignment event with an exact payload', async () => {
    const { sla, run } = setup();
    await run(INCIDENT_ASSIGNED_EVENT, { incidentId: 'inc-1', version: 3 });
    expect(sla.scanner.onAssigned).toHaveBeenCalledExactlyOnceWith('tenant-a', {
      incidentId: 'inc-1',
      version: 3,
    });
    for (const bad of [
      { incidentId: 'inc-1' },
      { incidentId: 'inc-1', version: 0 },
      { incidentId: 'inc-1', version: 1.5 },
      { incidentId: 'inc-1', version: '1' },
      { incidentId: '', version: 1 },
      { incidentId: 'inc-1', version: 1, tenantId: 'x' },
    ])
      await expect(run(INCIDENT_ASSIGNED_EVENT, bad)).rejects.toThrow('invalid incident SLA job');
  });
  it('delivers a notice for the envelope tenant and lets a pending delivery propagate', async () => {
    const { sla, run } = setup();
    const payload = { incidentId: 'inc-1', alertId: 'a-1', kind: 'sla_breach', cycle: 1 };
    await run(INCIDENT_SLA_ALERT_EVENT, payload, 'tenant-b');
    expect(sla.delivery.deliver).toHaveBeenCalledExactlyOnceWith('tenant-b', payload, {
      final: false,
    });
    sla.delivery.deliver.mockRejectedValueOnce(new Error('pending'));
    await expect(run(INCIDENT_SLA_ALERT_EVENT, payload)).rejects.toThrow('pending');
  });
});

describe('alert handler on the last outbox try', () => {
  it('tells the delivery only on the last try', async () => {
    const { sla, run } = setup();
    const payload = { alertId: 'a', incidentId: 'i' };
    const handlers = new Map<string, H>();
    registerIncidentSlaHandlers({ register: (t, h) => handlers.set(t, h) }, sla as never);
    const base = { tenantId: 'tenant-a', eventId: 'e1', type: INCIDENT_SLA_ALERT_EVENT };
    const alert = handlers.get(INCIDENT_SLA_ALERT_EVENT);
    await alert?.(payload, { ...base, attempt: 5, maxAttempts: 6 } as never);
    await alert?.(payload, { ...base, attempt: 6, maxAttempts: 6 } as never);
    await run(INCIDENT_SLA_ALERT_EVENT, payload);
    expect(sla.delivery.deliver.mock.calls.map((c) => (c as unknown[])[2])).toEqual([
      { final: false },
      { final: true },
      { final: false },
    ]);
  });
});

describe('incident alert mail adapter selection', () => {
  it('uses the test sink outside production and records without sending', async () => {
    const mailer = selectIncidentAlertMailer({ environment: 'test' });
    expect(mailer).toBeInstanceOf(TestSinkMailer);
    const message = {
      tenantId: 't',
      alertId: 'a',
      recipientId: 'user-1',
      to: 'x@example.test',
      subject: 's',
      body: 'b',
    };
    await mailer.send(message);
    expect((mailer as TestSinkMailer).messages).toEqual([message]);
    expect(selectIncidentAlertMailer({})).toBeInstanceOf(TestSinkMailer);
  });
  it('requires a real adapter in production and rejects the sink there', () => {
    expect(() => selectIncidentAlertMailer({ environment: 'production' })).toThrow('required');
    expect(() =>
      selectIncidentAlertMailer({ environment: 'production', mailer: new TestSinkMailer() }),
    ).toThrow('cannot run in production');
    const real = { send: async () => undefined };
    expect(selectIncidentAlertMailer({ environment: 'production', mailer: real })).toBe(real);
    expect(selectIncidentAlertMailer({ environment: 'test', mailer: real })).toBe(real);
  });
  it('treats prod, any case, NODE_ENV and OPSLOG_ENV as production too', () => {
    for (const environment of ['prod', 'PRODUCTION', ' Prod '])
      expect(() => selectIncidentAlertMailer({ environment })).toThrow('required');
    for (const name of ['NODE_ENV', 'OPSLOG_ENV']) {
      vi.stubEnv(name, name === 'NODE_ENV' ? 'production' : 'prod');
      try {
        expect(() => selectIncidentAlertMailer({ environment: 'test' })).toThrow('required');
        expect(() =>
          selectIncidentAlertMailer({ environment: 'test', mailer: new TestSinkMailer() }),
        ).toThrow('cannot run in production');
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});
