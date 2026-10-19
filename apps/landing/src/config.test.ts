import { describe, expect, it } from 'vitest';
import { readLandingConfig } from './config.js';

describe('readLandingConfig', () => {
  it('uses defaults', () => {
    expect(readLandingConfig({}, '/app/public')).toEqual({
      host: '0.0.0.0',
      port: 8090,
      publicDir: '/app/public',
      leadsFile: '/data/leads.jsonl',
    });
  });

  it('reads every option', () => {
    expect(
      readLandingConfig(
        {
          HOST: '127.0.0.1',
          PORT: '0',
          LANDING_PUBLIC_DIR: '/srv',
          LANDING_LEADS_FILE: '/tmp/l.jsonl',
          LANDING_ADMIN_PASSWORD: 'p'.repeat(16),
          LANDING_NOTIFY_URL: 'https://hooks.example.com/x',
          LANDING_CONTACT_EMAIL: 'ventas@example.mx',
        },
        '/app/public',
      ),
    ).toEqual({
      host: '127.0.0.1',
      port: 0,
      publicDir: '/srv',
      leadsFile: '/tmp/l.jsonl',
      adminPassword: 'p'.repeat(16),
      notifyUrl: 'https://hooks.example.com/x',
      contactEmail: 'ventas@example.mx',
    });
  });

  it.each([
    [{ PORT: 'x' }, 'PORT'],
    [{ LANDING_ADMIN_PASSWORD: 'short' }, 'LANDING_ADMIN_PASSWORD'],
    [{ LANDING_NOTIFY_URL: 'http://hooks.example.com' }, 'LANDING_NOTIFY_URL'],
    [{ LANDING_NOTIFY_URL: 'not a url' }, 'LANDING_NOTIFY_URL'],
    [{ LANDING_CONTACT_EMAIL: 'nope' }, 'LANDING_CONTACT_EMAIL'],
  ])('rejects %o naming the variable', (env, name) => {
    expect(() => readLandingConfig(env, '/p')).toThrow(name);
  });
});
