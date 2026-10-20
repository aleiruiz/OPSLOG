import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../bff/src/routes.js';
import {
  ROUTE_SEGMENTS,
  createLogger,
} from '../../../../packages/platform/observability/src/index.js';
import type { BffHandler } from '../../bff/src/index.js';
import { withRequestLog } from './request-log.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const setup = (handler: BffHandler) => {
  const lines: string[] = [];
  let clock = 1_000;
  const wrapped = withRequestLog(
    handler,
    createLogger(
      (line) => lines.push(line),
      {},
      () => NOW,
    ),
    () => (clock += 25),
  );
  return { lines, wrapped, events: () => lines.map((l) => JSON.parse(l)) };
};
const reply =
  (status: number, headers: Record<string, string> = {}): BffHandler =>
  async () => ({ status, headers, body: '' });

describe('withRequestLog', () => {
  it('logs the static route, status, duration and correlation id of a request', async () => {
    const { wrapped, events } = setup(
      reply(200, { 'x-correlation-id': '6f1c0a52-8f87-4f3a-9d1e-0123456789ab' }),
    );
    await wrapped({
      method: 'GET',
      url: '/api/employees/emp-77?email=ana@example.com',
      headers: { cookie: 'session=secret-token' },
      body: '',
    } as never);
    expect(events()).toEqual([
      {
        ts: NOW.toISOString(),
        level: 'info',
        msg: 'http_request',
        correlationId: '6f1c0a52-8f87-4f3a-9d1e-0123456789ab',
        route: 'GET /api/employees/:param',
        status: 200,
        durationMs: 25,
      },
    ]);
  });

  it('logs a server error at error level, without a correlation id when the response has none', async () => {
    const { wrapped, events } = setup(reply(503));
    await wrapped({ method: 'POST', url: '/api/x', headers: {}, body: '' } as never);
    expect(events()[0]).toMatchObject({ level: 'error', status: 503 });
    expect(events()[0]).not.toHaveProperty('correlationId');
  });

  it('does not log the probes', async () => {
    const { wrapped, lines } = setup(reply(200));
    await wrapped({ method: 'GET', url: '/healthz', headers: {}, body: '' } as never);
    await wrapped({ method: 'GET', url: '/readyz', headers: {}, body: '' } as never);
    expect(lines).toEqual([]);
  });

  it('logs the class of an exception and rethrows it', async () => {
    const { wrapped, events } = setup(async () => {
      throw new TypeError('contains ana@example.com');
    });
    await expect(
      wrapped({ method: 'GET', url: '/api/a', headers: {}, body: '' } as never),
    ).rejects.toThrow(TypeError);
    expect(events()[0]).toMatchObject({ msg: 'http_request_failed', errorClass: 'TypeError' });
    expect(JSON.stringify(events())).not.toContain('ana@');
    const { wrapped: other, events: otherEvents } = setup(async () => {
      throw 'not an error object';
    });
    await expect(
      other({ method: 'GET', url: '/api/a', headers: {}, body: '' } as never),
    ).rejects.toBe('not an error object');
    expect(otherEvents()[0]).toMatchObject({ errorClass: 'Error' });
  });
});

describe('ROUTE_SEGMENTS', () => {
  it('covers every static path segment of the BFF routes', () => {
    const missing = ROUTES.flatMap((route) => route.path).filter(
      (segment) => !segment.startsWith(':') && !ROUTE_SEGMENTS.has(segment),
    );
    expect(missing).toEqual([]);
  });
});
