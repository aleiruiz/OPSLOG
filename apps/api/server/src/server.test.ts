import { afterEach, describe, expect, it, vi } from 'vitest';
import descriptor from '../../../../infra/runtime/staging.json' with { type: 'json' };
import type { RuntimeDescriptor } from '../../../../infra/runtime/src/index.js';
import { readConfig } from './config.js';
import { startServer, type RunningServer } from './server.js';
import { startWorkerLoop } from './worker-loop.js';
import {
  createLogger,
  WorkerHeartbeat,
} from '../../../../packages/platform/observability/src/index.js';

const env = {
  OPSLOG_ENV: 'staging',
  OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
  OPSLOG_BFF_SECRET: 'b'.repeat(32),
  OPSLOG_GRANT_SECRET: 'g'.repeat(32),
  PORT: '0',
  HOST: '127.0.0.1',
};
const staging = descriptor as RuntimeDescriptor;
const parse = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  vi.useRealTimers();
});

describe('startServer', () => {
  it('serves the health check and the BFF on one port', async () => {
    const lines: string[] = [];
    running = await startServer(env, readConfig(env), staging, (line) => lines.push(line));
    const base = `http://127.0.0.1:${running.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const csrf = await fetch(`${base}/api/auth/csrf`);
    expect(csrf.status).toBe(200);
    expect(await csrf.json()).toHaveProperty('csrfToken');
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    // The in-process worker finds its stores: a full tick reports no failure.
    await running.tick();
    expect(parse(lines).filter((line) => line.msg === 'worker_job_failed')).toEqual([]);
  });

  it('writes every line as JSON with ts, level and msg, and never the query or a body value', async () => {
    const lines: string[] = [];
    running = await startServer(env, readConfig(env), staging, (line) => lines.push(line));
    const base = `http://127.0.0.1:${running.port}`;
    const pii = 'ana.lopez@example.com';
    await fetch(`${base}/api/employees?email=${pii}&curp=GOMA800101HDFRRN09`);
    await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: pii, token: 'secret-token-value' }),
    });
    await fetch(`${base}/api/vehicles/9b2f4c1e-aaaa-bbbb-cccc-0123456789ab`);
    const events = parse(lines);
    expect(events.every((e) => e.ts && e.level && e.msg)).toBe(true);
    const requests = events.filter((e) => e.msg === 'http_request');
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((e) => typeof e.correlationId === 'string')).toBe(true);
    expect(requests.map((e) => e.route)).toContain('GET /api/vehicles/:id');
    const text = lines.join('\n');
    for (const secret of [pii, 'GOMA800101HDFRRN09', 'secret-token-value'])
      expect(text).not.toContain(secret);
  });

  it('answers /readyz 200 when ready and 503 worker_stalled when no tick finished for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    running = await startServer(env, readConfig(env), staging, () => undefined);
    const base = `http://127.0.0.1:${running.port}`;
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ status: 'ready' });
    vi.setSystemTime(Date.now() + 61_000);
    const stalled = await fetch(`${base}/readyz`);
    expect(stalled.status).toBe(503);
    expect(await stalled.json()).toEqual({ status: 'unready', code: 'worker_stalled' });
    // Liveness is independent of readiness.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await running.tick();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('does not serve /readyz for other methods and logs the cause of a failed probe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines: string[] = [];
    running = await startServer(env, readConfig(env), staging, (line) => lines.push(line));
    const base = `http://127.0.0.1:${running.port}`;
    expect((await fetch(`${base}/readyz`, { method: 'POST' })).status).not.toBe(200);
    vi.setSystemTime(Date.now() + 61_000);
    await fetch(`${base}/readyz`);
    expect(parse(lines).find((e) => e.msg === 'readyz_failed')).toMatchObject({
      level: 'warn',
      mode: 'worker_stalled',
    });
  });

  it('emits no ops_stats without a database', async () => {
    const lines: string[] = [];
    running = await startServer(env, readConfig(env), staging, (l) => lines.push(l), {
      statsIntervalMs: 10,
    });
    await running.stats();
    expect(parse(lines).some((e) => e.msg === 'ops_stats')).toBe(false);
  });

  it('bootstraps the first company on start and logs it without personal data', async () => {
    const lines: string[] = [];
    const boot = {
      OPSLOG_BOOTSTRAP_COMPANY: 'Demo SA',
      OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-secret-1',
    };
    const withBoot = { ...env, ...boot };
    running = await startServer(withBoot, readConfig(withBoot), staging, (l) => lines.push(l));
    expect(parse(lines).filter((e) => e.msg === 'bootstrap_created')).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('sub-secret-1');
    expect(lines.join('\n')).not.toContain('Demo SA');
  });

  it('starts in cognito mode without contacting the identity provider', async () => {
    const cognito = {
      ...env,
      OPSLOG_AUTH_MODE: 'cognito',
      OPSLOG_OIDC_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
      OPSLOG_OIDC_DOMAIN: 'https://demo.auth.us-east-1.amazoncognito.com',
      OPSLOG_OIDC_CLIENT_ID: 'client-id',
      OPSLOG_OIDC_CLIENT_SECRET: 'client-secret-value',
      OPSLOG_OIDC_REDIRECT_URI: 'http://localhost:8081/auth/callback',
      OPSLOG_BOOTSTRAP_COMPANY: 'Demo SA',
      OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-1',
    };
    const lines: string[] = [];
    running = await startServer(cognito, readConfig(cognito), staging, (l) => lines.push(l));
    expect(parse(lines).some((e) => e.msg === 'bootstrap_created')).toBe(true);
    const base = `http://127.0.0.1:${running.port}`;
    expect((await fetch(`${base}/api/auth/csrf`)).status).toBe(200);
  });

  it('refuses to start outside staging or with cloud credentials', async () => {
    await expect(
      startServer({ ...env, OPSLOG_ENV: 'production' }, readConfig(env), staging),
    ).rejects.toThrow('OPSLOG_ENV must be staging');
    await expect(
      startServer({ ...env, NODE_ENV: 'production' }, readConfig(env), staging),
    ).rejects.toThrow('production mode');
    await expect(
      startServer({ ...env, AWS_PROFILE: 'x' }, readConfig(env), staging),
    ).rejects.toThrow('AWS_PROFILE');
  });
});

describe('startWorkerLoop', () => {
  const runtime = (fail: boolean) => {
    const calls: string[] = [];
    const job = (name: string, call: string, failing = false) => ({
      name,
      run: async () => {
        calls.push(call);
        if (failing) throw new Error('boom');
        return 0;
      },
    });
    return {
      calls,
      value: {
        jobs: {
          list: () => [
            job('outbox', 'drain', fail),
            job('scans', 'scans'),
            job('audit-relay', 'relay'),
            job('exports.run', 'exports'),
          ],
        },
        periodic: { start: () => calls.push('start'), stop: () => calls.push('stop') },
      } as never,
    };
  };

  it('runs every stage each tick and stops the timers', async () => {
    vi.useFakeTimers();
    const { calls, value } = runtime(false);
    const loop = startWorkerLoop(
      value,
      createLogger(() => undefined),
      undefined,
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(['start', 'drain', 'scans', 'relay', 'exports']);
    await loop.stop();
    expect(calls.at(-1)).toBe('stop');
  });

  it('reports a failing job by name and class only, runs the others and keeps ticking', async () => {
    vi.useFakeTimers();
    const { calls, value } = runtime(true);
    const reports: string[] = [];
    const heartbeat = new WorkerHeartbeat();
    const loop = startWorkerLoop(
      value,
      createLogger((l) => reports.push(l)),
      heartbeat,
      1000,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      reports.map((line) => {
        const { msg, job, errorClass } = JSON.parse(line);
        return { msg, job, errorClass };
      }),
    ).toEqual(Array(2).fill({ msg: 'worker_job_failed', job: 'outbox', errorClass: 'Error' }));
    // A failing job does not stop the tick from finishing, so the worker still counts as alive.
    expect(heartbeat.ageMs()).toBeLessThan(1000);
    expect(reports.join('')).not.toContain('boom');
    expect(calls.filter((c) => c === 'drain')).toHaveLength(2);
    expect(calls.filter((c) => c === 'exports')).toHaveLength(2);
    await loop.stop();
  });
});
