import { companyColumn, type RowScope } from '../catalog.js';
import type { Cell, ExportSource, Row, ServerInfo, TableMeta } from '../types.js';

export const TENANT = 'tenant-export-a';
export const OTHER_TENANT = 'tenant-export-b';

export interface FakeTable {
  readonly meta: TableMeta;
  readonly rows: readonly Row[];
}

export const table = (
  name: string,
  columns: readonly string[],
  primaryKey: readonly string[],
  rows: readonly Row[],
): FakeTable => ({ meta: { name, columns, primaryKey }, rows });

/** An in-memory `ExportSource`: rows filtered by the company column the way the SQL source does. */
export class FakeSource implements ExportSource {
  public closed = false;
  public constructor(
    private readonly data: readonly FakeTable[],
    private readonly company: { id: string; name: string } | null = {
      id: TENANT,
      name: 'Empresa Sintetica A',
    },
    private readonly server: ServerInfo = {
      version: '8.4.0',
      serverUuid: '00000000-0000-4000-8000-000000000001',
      snapshotAt: '2026-10-19T12:00:00.000Z',
    },
  ) {}

  public async info(): Promise<ServerInfo> {
    return this.server;
  }
  public async tables(): Promise<readonly TableMeta[]> {
    return this.data.map((t) => t.meta).sort((a, b) => a.name.localeCompare(b.name));
  }
  public async singleCompany() {
    return this.company ?? undefined;
  }
  private select(meta: TableMeta, scope: RowScope, tenantId: string): Row[] {
    const found = this.data.find((t) => t.meta.name === meta.name);
    const rows = [...(found?.rows ?? [])];
    if (scope === 'tenant_record') return rows.filter((r) => r['id'] === tenantId);
    if (scope === 'identity_of_company') return rows;
    const column = companyColumn(meta.columns);
    return rows.filter((r) => r[column as string] === tenantId);
  }
  public async count(meta: TableMeta, scope: RowScope, tenantId: string): Promise<number> {
    return this.select(meta, scope, tenantId).length;
  }
  public async *rows(meta: TableMeta, scope: RowScope, tenantId: string): AsyncIterable<Row> {
    for (const row of this.select(meta, scope, tenantId)) yield { ...row };
  }
  public async close(): Promise<void> {
    this.closed = true;
  }
}

export const cell = (value: Cell): Cell => value;
