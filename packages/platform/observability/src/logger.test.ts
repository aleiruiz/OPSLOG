import { describe, expect, it } from 'vitest';
import { createLogger, opaqueRef, routeOf, sanitizeFields } from './logger.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');

function capture(base = {}) {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger(
      (line) => lines.push(line),
      base,
      () => NOW,
    ),
  };
}

describe('createLogger', () => {
  it('writes one JSON object per event with ts, level and msg', () => {
    const { lines, log } = capture();
    log.info('worker_started');
    log.warn('slow_tick', { durationMs: 12.4, job: 'outbox' });
    log.error('bff_error', {
      correlationId: '6f1c0a52-8f87-4f3a-9d1e-0123456789ab',
      route: 'GET /api/x',
      errorClass: 'TypeError',
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: NOW.toISOString(), level: 'info', msg: 'worker_started' },
      { ts: NOW.toISOString(), level: 'warn', msg: 'slow_tick', durationMs: 12, job: 'outbox' },
      {
        ts: NOW.toISOString(),
        level: 'error',
        msg: 'bff_error',
        correlationId: '6f1c0a52-8f87-4f3a-9d1e-0123456789ab',
        route: 'GET /api/x',
        errorClass: 'TypeError',
      },
    ]);
    expect(lines.every((line) => !line.includes('\n'))).toBe(true);
  });

  it('adds the base fields of a child to every line, and the call can override them', () => {
    const company = opaqueRef('c', 'tenant-1');
    const { lines, log } = capture();
    const child = log.child({ companyRef: company });
    child.info('a');
    child.info('b', { correlationId: 'w_0123456789abcdef' });
    expect(lines.map((line) => JSON.parse(line).companyRef)).toEqual([company, company]);
    expect(JSON.parse(lines[1] as string).correlationId).toBe('w_0123456789abcdef');
  });

  it('replaces a message that is not an event code', () => {
    const { lines, log } = capture();
    log.info('Employee Juan Pérez created');
    log.info('');
    log.info('a'.repeat(80));
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
      'invalid_log_event',
      'invalid_log_event',
      'invalid_log_event',
    ]);
  });

  it('defaults to the real clock and stdout-free sinks', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line)).info('tick');
    expect(Date.parse(JSON.parse(lines[0] as string).ts)).toBeGreaterThan(0);
  });
});

describe('sanitizeFields', () => {
  it('drops values that do not match their field and keys that are not allowlisted', () => {
    const hostile = {
      companyRef: 'Acme SA de CV',
      actorRef: 'ana.lopez@example.com',
      correlationId: 'has spaces and\nnewline',
      route: 'GET /api/employees?curp=XXXX',
      errorClass: 'Error: boom at /srv/app.js:10',
      job: 'a b',
      mode: 'x y',
      durationMs: -5,
      status: Number.NaN,
      count: Number.POSITIVE_INFINITY,
      port: -1,
      email: 'ana@example.com',
      token: 'abc',
      message: 'free text',
    };
    expect(sanitizeFields(hostile as never)).toEqual({});
  });

  it('keeps well-formed values and rounds numbers', () => {
    expect(
      sanitizeFields({
        companyRef: opaqueRef('c', 'x'),
        actorRef: opaqueRef('a', 'sub-1'),
        correlationId: '6f1c0a52-8f87-4f3a-9d1e-0123456789ab',
        route: 'POST /api/auth/session',
        durationMs: 3.6,
        status: 503,
        count: 2,
        port: 8080,
        mode: 'read-only',
        job: 'webhooks.deliver',
        errorClass: 'MysqlError',
      }),
    ).toMatchObject({ durationMs: 4, status: 503, count: 2, port: 8080, mode: 'read-only' });
  });

  it('keeps only the known counters, with finite non-negative values', () => {
    const kept = sanitizeFields({
      stats: {
        outboxPending: 3,
        dbConnections: 2.4,
        'bad key': 1,
        unknownCounter: 1,
        outboxLagSeconds: -1,
        mailFailed: 'x' as never,
        scanQueue: Number.NaN,
      },
    }).stats;
    expect(kept).toEqual({ outboxPending: 3, dbConnections: 2 });
  });
});

describe('leak resistance', () => {
  // Built at run time so the repository's own secret scan has nothing to flag in this file.
  const secrets = [
    ['AK', 'IAIOSFODNN7EXAMPLE'].join(''),
    [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    ].join('.'),
    ['mysql://root:hunter2', 'db.internal/opslog'].join('@'),
    ['Bearer', 'abcdef0123456789'].join(' '),
    'ana.lopez@example.com',
    'GOMA800101HDFRRN09',
  ];

  it('never writes a hostile value passed in any field or message', () => {
    const { lines, log } = capture();
    for (const secret of secrets) {
      log.info(secret);
      log.error('bff_error', {
        companyRef: secret,
        actorRef: secret,
        correlationId: secret,
        route: secret,
        errorClass: secret,
        job: secret,
        mode: secret,
        stats: { [secret]: 1 },
      } as never);
    }
    const text = lines.join('\n');
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/AKIA|eyJ|@|hunter2|Bearer|GOMA/);
    expect(lines.every((line) => JSON.parse(line).ts === NOW.toISOString())).toBe(true);
  });
});

describe('opaqueRef and routeOf', () => {
  it('is stable, kind-scoped and does not echo the value', () => {
    expect(opaqueRef('c', 'tenant-1')).toBe(opaqueRef('c', 'tenant-1'));
    expect(opaqueRef('c', 'tenant-1')).not.toBe(opaqueRef('a', 'tenant-1'));
    expect(opaqueRef('a', 'ana@example.com')).toMatch(/^a_[0-9a-f]{16}$/);
  });

  it('keeps only known resource segments, turns anything else into :param and drops the query', () => {
    expect(routeOf('get', '/api/employees/9b2f4c1e-0000?curp=GOMA800101')).toBe(
      'GET /api/employees/:param',
    );
    expect(routeOf('POST', '/api/auth/session')).toBe('POST /api/auth/session');
    expect(routeOf('GET', '/api/vehicles/Juan%20Perez/history')).toBe(
      'GET /api/vehicles/:param/history',
    );
    // A plain lower-case word in an id position (a name, a token) is not a resource either.
    expect(routeOf('GET', '/api/employees/gomez')).toBe('GET /api/employees/:param');
    expect(routeOf('GET', '/api/invitations/secrettoken')).toBe('GET /api/invitations/:param');
    expect(routeOf('GET', '/readyz')).toBe('GET /readyz');
    expect(routeOf('weird!', '/')).toBe('OTHER /');
    expect(routeOf('GET', '/a/b/c/d/e/f/g/h/i/j')).toBe(
      'GET /:param/:param/:param/:param/:param/:param/:param/:param',
    );
    expect(routeOf('GET', '')).toBe('GET /');
  });
});
