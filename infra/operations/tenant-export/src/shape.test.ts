import { describe, expect, it } from 'vitest';
import { PII_FIELD_LABEL } from '../../../../packages/domain/employees/src/index.js';
import { IdentityVault } from '../../../../packages/domain/incidents/third-parties/src/pii.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../packages/platform/pii/src/index.js';
import { CATALOG, companyColumn, dispositionOf, type ExportedTable } from './catalog.js';
import { csvChunks, counted, jsonChunks, outputColumns, shapeRows } from './shape.js';
import { TENANT, table } from './test-support/fake-source.js';
import type { Row } from './types.js';

const cipher = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
const spec = (name: string): ExportedTable => {
  const found = dispositionOf(name);
  if (found?.kind !== 'export') throw new Error('not exported');
  return found;
};
const rowsOf = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
};
async function* from(rows: Row[]): AsyncGenerator<Row> {
  for (const row of rows) yield row;
}
const text = async (iterable: AsyncIterable<string>): Promise<string> =>
  (await rowsOf(iterable)).join('');

describe('catalog', () => {
  it('classifies journals by suffix and leaves unknown tables unclassified', () => {
    expect(dispositionOf('opslog_vehicles_migrations')).toEqual({
      kind: 'exclude',
      reason: 'schema_metadata',
    });
    expect(dispositionOf('opslog_made_up')).toBeUndefined();
    expect(dispositionOf('opslog_vehicles')).toMatchObject({ kind: 'export', scope: 'company' });
  });

  it('finds the company column', () => {
    expect(companyColumn(['company_id', 'id'])).toBe('company_id');
    expect(companyColumn(['tenant_id'])).toBe('tenant_id');
    expect(companyColumn(['id'])).toBeUndefined();
  });

  it('seals employees with the labels the employee module uses', () => {
    const sealed = (CATALOG['opslog_employees'] as ExportedTable).sealed ?? [];
    expect(sealed.map((s) => s.field).sort()).toEqual(Object.values(PII_FIELD_LABEL).sort());
    expect(sealed.every((s) => s.entityType === 'employee' && s.entityId.join() === 'id')).toBe(
      true,
    );
  });

  it('never exports a session, a token or a webhook secret', () => {
    for (const name of [
      'opslog_identity_sessions',
      'opslog_control_sessions',
      'opslog_identity_invitations',
      'opslog_identity_recoveries',
    ])
      expect(dispositionOf(name)?.kind).toBe('exclude');
    expect(spec('opslog_webhook_endpoints').omit).toEqual(['secret_sealed', 'previous_sealed']);
  });
});

describe('shapeRows', () => {
  const employees = table(
    'opslog_employees',
    [
      'company_id',
      'id',
      'first_name',
      'national_id_enc',
      'national_id_idx',
      'phone_enc',
      'email_enc',
      'email_idx',
      'license_number_enc',
      'license_number_idx',
    ],
    ['company_id', 'id'],
    [],
  );

  it('opens sealed columns under their clear names and drops blind indexes', async () => {
    const seal = (field: string, value: string) =>
      cipher.seal({ tenantId: TENANT, entityType: 'employee', entityId: 'e1', field }, value);
    const row: Row = {
      company_id: TENANT,
      id: 'e1',
      first_name: 'Ana',
      national_id_enc: await seal('national_id', 'CURP123'),
      national_id_idx: 'a'.repeat(64),
      phone_enc: await seal('phone', '555-0100'),
      email_enc: null,
      email_idx: null,
      license_number_enc: await seal('license_number', 'LIC-9'),
      license_number_idx: 'b'.repeat(64),
    };
    const [shaped] = await rowsOf(
      shapeRows(employees.meta, spec('opslog_employees'), from([row]), cipher, TENANT),
    );
    expect(shaped).toEqual({
      company_id: TENANT,
      id: 'e1',
      first_name: 'Ana',
      national_id: 'CURP123',
      phone: '555-0100',
      email: null,
      license_number: 'LIC-9',
    });
    expect(outputColumns(employees.meta, spec('opslog_employees'))).toEqual(
      Object.keys(shaped as Row),
    );
  });

  it('opens third-party identity sealed by the incident module vault', async () => {
    const vault = new IdentityVault(cipher);
    const meta = table(
      'opslog_incident_third_parties',
      [
        'company_id',
        'incident_id',
        'id',
        'name_enc',
        'contact_enc',
        'plates_enc',
        'policy_number_enc',
      ],
      [],
      [],
    ).meta;
    const row: Row = {
      company_id: TENANT,
      incident_id: 'inc1',
      id: 'tp1',
      name_enc: await vault.seal(TENANT, 'inc1', 'tp1', 'name', 'Juan Perez'),
      contact_enc: await vault.seal(TENANT, 'inc1', 'tp1', 'contact', 'juan@example.test'),
      plates_enc: await vault.seal(TENANT, 'inc1', 'tp1', 'plates', 'ABC-123'),
      policy_number_enc: null,
    };
    const [shaped] = await rowsOf(
      shapeRows(meta, spec('opslog_incident_third_parties'), from([row]), cipher, TENANT),
    );
    expect(shaped).toMatchObject({
      name: 'Juan Perez',
      contact: 'juan@example.test',
      plates: 'ABC-123',
      policy_number: null,
    });
  });

  it('stops with a fixed code when a value cannot be opened, without echoing it', async () => {
    const other = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
    const sealed = await other.seal(
      { tenantId: TENANT, entityType: 'employee', entityId: 'e1', field: 'phone' },
      'SECRET-PHONE',
    );
    const run = rowsOf(
      shapeRows(
        employees.meta,
        spec('opslog_employees'),
        from([{ company_id: TENANT, id: 'e1', phone_enc: sealed }]),
        cipher,
        TENANT,
      ),
    );
    await expect(run).rejects.toMatchObject({
      code: 'pii_open_failed',
      message: 'tenant export failed: pii_open_failed',
    });
  });
});

describe('serializers', () => {
  it('writes a JSON array one row per line, valid when empty or not', async () => {
    expect(JSON.parse(await text(jsonChunks(from([])))) as unknown).toEqual([]);
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: null },
    ];
    const out = await text(jsonChunks(from(rows)));
    expect(JSON.parse(out) as unknown).toEqual(rows);
    expect(out.split('\n').length - 1).toBe(rows.length + 2);
  });

  it('writes RFC 4180 CSV with BOM, quoting and formula neutralization', async () => {
    const out = await text(
      csvChunks(
        ['id', 'note', 'n', 'flag', 'obj'],
        from([
          { id: 'a', note: '=SUM(1)', n: 3, flag: true, obj: { k: 'v,w' } },
          { id: 'b', note: 'say "hi"\nnow', n: null, flag: false, obj: null },
        ]),
      ),
    );
    expect(out.startsWith('﻿id,note,n,flag,obj\r\n')).toBe(true);
    expect(out).toContain('a,\'=SUM(1),3,true,"{""k"":""v,w""}"\r\n');
    expect(out).toContain('b,"say ""hi""\nnow",,false,\r\n');
  });

  it('counts the rows that pass', async () => {
    const tracked = counted(from([{ a: 1 }, { a: 2 }]));
    await rowsOf(tracked.rows);
    expect(tracked.count()).toBe(2);
  });
});
