import { expect } from 'vitest';
import type { PlatformResponse } from '../../../apps/api/composition/src/index.js';
import { corr, type Session, type World } from './world.js';

const ok = <T>(result: PlatformResponse<T> | { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok || (result as { value?: T }).value === undefined)
    throw new Error(
      `expected success, got ${JSON.stringify((result as { error?: unknown }).error)}`,
    );
  return (result as { value: T }).value;
};
const failure = (result: { ok: boolean; error?: { code: string; status: number } }) => {
  expect(result.ok).toBe(false);
  return result.error as { code: string; status: number };
};

export interface Company {
  readonly tenantId: string;
  readonly admin: Session;
  readonly viewer: Session;
  readonly editor: Session;
  readonly auditor: Session;
}

/** A company with the roles the views care about: who may see costs and incidents, and who manages config. */
export async function viewsCompany(w: World, name: string, tag: string): Promise<Company> {
  const handle = await w.tenant(name, `subject-admin-${tag}`);
  return {
    tenantId: handle.tenantId,
    admin: handle.admin,
    viewer: await w.member(handle.admin, 'viewer', `subject-viewer-${tag}`),
    editor: await w.member(handle.admin, 'editor', `subject-editor-${tag}`),
    auditor: await w.member(handle.admin, 'auditor', `subject-auditor-${tag}`),
  };
}

/** Views and columns never cross companies: another tenant sees nothing and gets a plain 404. */
export async function tenantIsolation(w: World, a: Company, b: Company): Promise<void> {
  const api = w.platform.savedViews.api;
  const mine = ok(
    await api.create(a.admin.token, corr(), 'vehicles', {
      name: 'Activos',
      shared: true,
      filters: { status: 'active' },
    }),
  );
  ok(
    await api.saveColumns(a.admin.token, corr(), 'vehicles', [
      'economicNumber',
      'plate',
      'actions',
    ]),
  );
  expect(ok(await api.list(b.admin.token, corr(), 'vehicles')).items).toEqual([]);
  expect(ok(await api.columns(b.admin.token, corr(), 'vehicles')).columns).toBeNull();
  expect(
    failure(await api.update(b.admin.token, corr(), mine.id, { version: 1, name: 'Robada' }))
      .status,
  ).toBe(404);
  expect(failure(await api.remove(b.admin.token, corr(), mine.id)).status).toBe(404);
  // The same name in another company is not a duplicate.
  const theirs = ok(await api.create(b.admin.token, corr(), 'vehicles', { name: 'Activos' }));
  expect(theirs.id).not.toBe(mine.id);
  expect(
    ok(await api.list(a.admin.token, corr(), 'vehicles')).items.map((view) => view.id),
  ).toEqual([mine.id]);
}

/** Visibility, revalidation by the reader's grants and editing rules. */
export async function permissionsAndRevalidation(w: World, c: Company): Promise<void> {
  const api = w.platform.savedViews.api;
  const shared = ok(
    await api.create(c.admin.token, corr(), 'maintenance', {
      name: 'Costosas',
      shared: true,
      filters: { status: 'assigned', costFrom: '1000' },
      columns: ['order', 'cost'],
    }),
  );
  const asAdmin = ok(await api.list(c.admin.token, corr(), 'maintenance')).items[0]!;
  expect(asAdmin.filters).toEqual({ status: 'assigned', costFrom: '1000' });
  expect(asAdmin.dropped).toEqual([]);
  // What is not on the allowlist is refused when saving, never stored.
  expect(
    failure(
      await api.create(c.admin.token, corr(), 'maintenance', {
        name: 'Mala',
        filters: { unknown: 'x' },
      }),
    ).status,
  ).toBe(400);

  // A reader without view_costs gets the view without the cost filter and column, and is told so.
  const asViewer = ok(await api.list(c.viewer.token, corr(), 'maintenance')).items[0]!;
  expect(asViewer.filters).toEqual({ status: 'assigned' });
  expect(asViewer.columns).toEqual(['order']);
  expect(
    asViewer.dropped
      .filter((drop) => drop.reason === 'permission')
      .map((drop) => drop.key)
      .sort(),
  ).toEqual(['cost', 'costFrom']);
  expect(asViewer.mine).toBe(false);
  expect(asViewer.canEdit).toBe(false);
  expect(JSON.stringify(asViewer)).not.toContain(c.admin.identityId);

  // Not the owner and not a manager: the shared view cannot be changed or deleted.
  expect(
    failure(await api.update(c.viewer.token, corr(), shared.id, { version: 1, name: 'x' })).status,
  ).toBe(403);
  expect(failure(await api.remove(c.editor.token, corr(), shared.id)).status).toBe(403);

  // A private view is a 404 for everyone else, whatever their grants.
  const priv = ok(await api.create(c.viewer.token, corr(), 'maintenance', { name: 'Privada' }));
  expect(
    failure(await api.update(c.admin.token, corr(), priv.id, { version: 1, name: 'x' })).status,
  ).toBe(404);
  expect(
    ok(await api.list(c.admin.token, corr(), 'maintenance')).items.map((view) => view.name),
  ).toEqual(['Costosas']);

  // The module's own permission opens its views.
  expect(failure(await api.list(c.auditor.token, corr(), 'incidents')).status).toBe(403);
  expect(failure(await api.create(c.admin.token, corr(), 'nothing', { name: 'x' })).status).toBe(
    400,
  );
}

/** Names are unique per owner and list, versions guard concurrent edits and 50 views is the limit. */
export async function namesVersionsAndLimit(w: World, c: Company): Promise<void> {
  const api = w.platform.savedViews.api;
  const first = ok(await api.create(c.editor.token, corr(), 'documents', { name: 'Por vencer' }));
  expect(
    failure(await api.create(c.editor.token, corr(), 'documents', { name: ' por  VENCER ' })).code,
  ).toBe('duplicate');
  const renamed = ok(
    await api.update(c.editor.token, corr(), first.id, {
      version: first.version,
      name: 'Vencen pronto',
    }),
  );
  expect(renamed.version).toBe(first.version + 1);
  expect(
    failure(
      await api.update(c.editor.token, corr(), first.id, { version: first.version, name: 'Otra' }),
    ).code,
  ).toBe('stale_version');
  for (let index = 1; index < 50; index += 1)
    ok(await api.create(c.editor.token, corr(), 'documents', { name: `Vista ${index}` }));
  const over = failure(await api.create(c.editor.token, corr(), 'documents', { name: 'Una más' }));
  expect(over.code).toBe('rule_violation');
  // The limit is per user and list: others and other lists are not affected.
  ok(await api.create(c.admin.token, corr(), 'documents', { name: 'Una más' }));
  ok(await api.create(c.editor.token, corr(), 'insurance', { name: 'Una más' }));
  expect((await api.remove(c.editor.token, corr(), first.id)).ok).toBe(true);
  ok(await api.create(c.editor.token, corr(), 'documents', { name: 'Una más' }));
}
