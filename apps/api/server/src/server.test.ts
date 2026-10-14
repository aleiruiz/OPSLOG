import { afterEach, describe, expect, it, vi } from 'vitest';
import descriptor from '../../../../infra/runtime/staging.json' with { type: 'json' };
import type { RuntimeDescriptor } from '../../../../infra/runtime/src/index.js';
import { readConfig } from './config.js';
import { startServer, type RunningServer } from './server.js';
import { startWorkerLoop } from './worker-loop.js';

const env = {
  OPSLOG_ENV: 'staging',
  OPSLOG_PUBLIC_ORIGIN: 'http://localhost:8081',
  OPSLOG_BFF_SECRET: 'b'.repeat(32),
  OPSLOG_GRANT_SECRET: 'g'.repeat(32),
  PORT: '0',
  HOST: '127.0.0.1',
};
const staging = descriptor as RuntimeDescriptor;

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
    expect(lines.filter((line) => line.startsWith('worker_tick_failed'))).toEqual([]);
  });

  it('bootstraps the first company on start and logs it without personal data', async () => {
    const lines: string[] = [];
    const boot = {
      OPSLOG_BOOTSTRAP_COMPANY: 'Demo SA',
      OPSLOG_BOOTSTRAP_ADMIN_SUB: 'sub-secret-1',
    };
    const withBoot = { ...env, ...boot };
    running = await startServer(withBoot, readConfig(withBoot), staging, (l) => lines.push(l));
    expect(lines.filter((l) => l.startsWith('bootstrap_created'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('sub-secret-1');
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
    expect(lines.some((l) => l.startsWith('bootstrap_created'))).toBe(true);
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
    return {
      calls,
      value: {
        drainOutbox: async () => {
          calls.push('drain');
          if (fail) throw new Error('boom');
          return 0;
        },
        runScans: async () => {
          calls.push('scans');
          return {};
        },
        runAuditRelay: async () => {
          calls.push('relay');
          return 0;
        },
        periodic: { start: () => calls.push('start'), stop: () => calls.push('stop') },
      } as never,
    };
  };

  it('runs every stage each tick and stops the timers', async () => {
    vi.useFakeTimers();
    const { calls, value } = runtime(false);
    const loop = startWorkerLoop(value, () => undefined, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(['start', 'drain', 'scans', 'relay']);
    await loop.stop();
    expect(calls.at(-1)).toBe('stop');
  });

  it('reports a failing tick by class name only and keeps ticking', async () => {
    vi.useFakeTimers();
    const { calls, value } = runtime(true);
    const reports: string[] = [];
    const loop = startWorkerLoop(value, (m) => reports.push(m), 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reports).toEqual(['worker_tick_failed Error', 'worker_tick_failed Error']);
    expect(calls.filter((c) => c === 'drain')).toHaveLength(2);
    await loop.stop();
  });
});
