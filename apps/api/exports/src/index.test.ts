import { describe, expect, it } from 'vitest';
import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { FULL, harness } from '../../../../packages/domain/exports/src/test-support.js';
import { ExportError } from '../../../../packages/domain/exports/src/index.js';
import { ReportError } from '../../../../packages/domain/reports/src/index.js';
import { ExportsApi, apiFailure } from './index.js';

function api(permissions: readonly string[] = FULL, subject = 'u1', tenantId = 'A') {
  const h = harness();
  h.grants.set('B:u9', new Set(FULL));
  return {
    h,
    api: new ExportsApi({
      service: h.service,
      authorize: async (token) => {
        if (token === 'bad') throw new AuthError('unauthorized');
        return { tenantId, subject, sessionId: 'session-1', permissions };
      },
    }),
  };
}

describe('ExportsApi', () => {
  it('creates, lists, gets and downloads the own export', async () => {
    const { api: exportsApi } = api();
    const made = await exportsApi.create('t', 'c', {
      reportId: 'drivers',
      format: 'csv',
      columns: ['name', 'status'],
      filters: {},
      sort: 'name',
      direction: 'desc',
      idempotencyKey: 'key-0000001',
    });
    if (!made.ok) throw new Error('expected ok');
    expect(made.value.replayed).toBe(false);
    const id = made.value.job.id;
    const again = await exportsApi.create('t', 'c', {
      reportId: 'drivers',
      format: 'csv',
      columns: ['name', 'status'],
      sort: 'name',
      direction: 'desc',
      idempotencyKey: 'key-0000001',
    });
    expect(again.ok && again.value.replayed).toBe(true);
    const list = await exportsApi.list('t', 'c', { limit: 10 });
    expect(list.ok && list.value.total).toBe(1);
    expect((await exportsApi.get('t', 'c', id)).ok).toBe(true);
    const file = await exportsApi.download('t', 'c', id);
    expect(file.ok && file.value.contentType).toBe('text/csv; charset=utf-8');
  });

  it('creates with only the required fields', async () => {
    const { api: exportsApi } = api();
    const made = await exportsApi.create('t', 'c', { reportId: 'areas', format: 'xlsx' });
    expect(made.ok).toBe(true);
  });

  it('refuses without the export permission, another person, an unknown job and a bad session', async () => {
    const { api: reader } = api(['view']);
    const denied = await reader.create('t', 'c', { reportId: 'drivers', format: 'csv' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
    const { api: owner } = api();
    const made = await owner.create('t', 'c', { reportId: 'drivers', format: 'csv' });
    if (!made.ok) throw new Error('expected ok');
    const { api: other } = api(FULL, 'u9');
    expect(await other.get('t', 'c', made.value.job.id)).toMatchObject({
      error: { code: 'not_found', status: 404 },
    });
    expect(await owner.get('t', 'c', 'missing')).toMatchObject({ error: { status: 404 } });
    expect(await owner.get('bad', 'c', 'x')).toMatchObject({ error: { status: 401 } });
  });
});

describe('apiFailure', () => {
  it('maps domain errors to fixed codes and never echoes a message', () => {
    expect(apiFailure(new ExportError('expired'))).toMatchObject({
      error: { code: 'gone', status: 410 },
    });
    expect(apiFailure(new ExportError('too_many_open'))).toMatchObject({
      error: { code: 'rate_limited', status: 429 },
    });
    expect(apiFailure(new ExportError('not_ready'))).toMatchObject({ error: { status: 409 } });
    expect(apiFailure(new ExportError('idempotency_conflict'))).toMatchObject({
      error: { code: 'idempotency_conflict', status: 409 },
    });
    expect(apiFailure(new ReportError('too_many_rows'))).toMatchObject({
      error: { code: 'rule_violation', status: 422, rule: 'too_many_rows' },
    });
    expect(apiFailure(new ReportError('invalid_input', 'columns'))).toMatchObject({
      error: { code: 'invalid_input', field: 'columns' },
    });
    expect(apiFailure(new AuthError('expired'))).toMatchObject({ error: { status: 401 } });
    expect(apiFailure(new AuthError('forbidden'))).toMatchObject({ error: { status: 403 } });
    expect(apiFailure(new AuthError('invalid_input'))).toMatchObject({ error: { status: 400 } });
    expect(apiFailure(new AuthError('not_found'))).toMatchObject({ error: { status: 500 } });
    const internal = apiFailure(new Error('mysql password=secret'));
    expect(JSON.stringify(internal)).not.toContain('secret');
    expect(internal).toMatchObject({ error: { code: 'internal_error', status: 500 } });
  });
});
