import { type BffUser, type Page } from '../../../../../packages/contracts/src/index.js';
import type { MemberView, RoleName } from '../../../composition/src/index.js';
import { text } from '../body.js';
import {
  route,
  ID,
  SCOPE,
  failure,
  success,
  reply,
  iso,
  body,
  bad,
  LIMITS,
  type Route,
  type RouteContext,
} from './shared.js';

const SORT_FIELDS = ['id', 'roleLabel', 'status'] as const;
type SortField = (typeof SORT_FIELDS)[number];

interface UserCursor {
  readonly t: string;
  readonly o: number;
  readonly s: SortField;
  readonly d: 'asc' | 'desc';
  readonly q: string;
}

function isUserCursor(value: unknown): value is UserCursor {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<UserCursor>;
  return (
    typeof c.t === 'string' &&
    Number.isSafeInteger(c.o) &&
    (c.o as number) >= 0 &&
    SORT_FIELDS.includes(c.s as SortField) &&
    (c.d === 'asc' || c.d === 'desc') &&
    typeof c.q === 'string'
  );
}

function listUsers(ctx: RouteContext, members: readonly MemberView[], tenantId: string) {
  const allowed = new Set(['limit', 'cursor', 'sort', 'direction', 'search']);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const sort = (ctx.query.get('sort') ?? 'id') as SortField;
  const direction = ctx.query.get('direction') ?? 'asc';
  const search = (ctx.query.get('search') ?? '').trim().toLowerCase();
  const cursorRaw = ctx.query.get('cursor');
  if (
    limit === undefined ||
    !SORT_FIELDS.includes(sort) ||
    (direction !== 'asc' && direction !== 'desc') ||
    search.length > 100
  )
    return null;
  let offset = 0;
  if (cursorRaw !== null) {
    // Cursors are signed and bound to tenant and query: another tenant's cursor is just invalid.
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (
      !isUserCursor(opened) ||
      opened.t !== tenantId ||
      opened.s !== sort ||
      opened.d !== direction ||
      opened.q !== search
    )
      return null;
    offset = opened.o;
  }
  const filtered = members.filter(
    (member) =>
      !search ||
      member.id.toLowerCase().includes(search) ||
      member.roleLabel.toLowerCase().includes(search) ||
      member.status === search,
  );
  const sign = direction === 'asc' ? 1 : -1;
  const sorted = [...filtered].sort(
    (a, b) => sign * a[sort].localeCompare(b[sort]) || a.id.localeCompare(b.id),
  );
  const items = sorted.slice(offset, offset + limit);
  const next = offset + limit < sorted.length ? offset + limit : null;
  const page: Page<BffUser> = {
    items,
    nextCursor:
      next === null
        ? null
        : ctx.crypto.signCursor({ t: tenantId, o: next, s: sort, d: direction, q: search }),
    total: sorted.length,
    sort: { field: sort, direction },
  };
  return page;
}

export const USER_ROUTES: readonly Route[] = [
  route('users.list', async (ctx) => {
    const result = await ctx.platform.listMembers(ctx.token as string, ctx.correlationId);
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const page = listUsers(ctx, result.value.members, result.value.tenantId);
    return page ? success(ctx, 'users.list', page) : bad(ctx);
  }),
  route('users.invite', async (ctx) => {
    const input = body(ctx, ['roleId']);
    if (!input) return bad(ctx);
    const roleId = input['roleId'];
    if (typeof roleId !== 'string') return bad(ctx);
    const invited = await ctx.platform.inviteUser(
      ctx.token as string,
      ctx.correlationId,
      roleId as RoleName,
    );
    return reply(ctx, 'users.invite', invited, (value) => ({
      user: { id: value.identityId, roleId, status: 'invited' as const },
      // Delivery by email is not built yet: the administrator who issues the invitation receives it.
      invitationToken: value.invitationToken,
      expiresAt: iso(value.expiresAt),
    }));
  }),
  route(
    'users.deactivate',
    async (ctx) => {
      const input = body(ctx, ['reason']);
      if (!input) return bad(ctx);
      try {
        text(input['reason'], 500);
      } catch {
        return bad(ctx);
      }
      const id = ctx.params['id'] as string;
      const removed = await ctx.platform.removeMember(ctx.token as string, ctx.correlationId, id);
      return reply(ctx, 'users.deactivate', removed, () => ({ id, status: 'inactive' as const }));
    },
    { id: ID },
  ),
  route('roles.list', async (ctx) =>
    reply(
      ctx,
      'roles.list',
      await ctx.platform.listRoles(ctx.token as string, ctx.correlationId),
      (items) => ({
        items,
      }),
    ),
  ),
  route(
    'roles.copy',
    async (ctx) => {
      const input = body(ctx, ['name']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'roles.copy',
        await ctx.platform.copyRole(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['name'],
        ),
        (v) => v,
      );
    },
    { id: ID },
  ),
  route(
    'drafts.load',
    async (ctx) =>
      reply(
        ctx,
        'drafts.load',
        await ctx.platform.loadDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        (draft) => ({ draft: draft && { ...draft, savedAt: iso(draft.savedAt) } }),
      ),
    { scope: SCOPE },
  ),
  route(
    'drafts.save',
    async (ctx) => {
      const input = body(ctx, ['values']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'drafts.save',
        await ctx.platform.saveDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
          input['values'],
        ),
        (draft) => ({ ...draft, savedAt: iso(draft.savedAt) }),
      );
    },
    { scope: SCOPE },
  ),
  route(
    'drafts.discard',
    async (ctx) =>
      reply(
        ctx,
        'drafts.discard',
        await ctx.platform.discardDraft(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['scope'] as string,
        ),
        () => undefined,
      ),
    { scope: SCOPE },
  ),
];
