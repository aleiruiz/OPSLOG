import {
  BFF_DOCUMENT_OWNER_TYPES,
  BFF_DOCUMENT_STATUSES,
  type BffDocument,
  type BffDocumentOwnerType,
  type BffDocumentRevision,
  type BffDocumentStatus,
  type Page,
} from '../../../../../packages/contracts/src/index.js';
import type { DocumentView, SessionDetails } from '../../../composition/src/index.js';
import {
  route,
  ID,
  failure,
  success,
  reply,
  body,
  bad,
  LIMITS,
  isOffsetCursor,
  type Route,
  type RouteContext,
} from './shared.js';

const DOCUMENT_TYPE_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const DOCUMENT_VALIDITY_KEYS = ['issuedOn', 'expiresOn', 'documentNumber'] as const;

const documentBody = (view: DocumentView): BffDocument => ({ ...view });

/** Strict query of the document listing: unknown or repeated keys, bad values and foreign cursors are all a 400. */
function documentQuery(ctx: RouteContext, tenantId: string) {
  const allowed = new Set([
    'limit',
    'cursor',
    'ownerType',
    'ownerId',
    'typeCode',
    'status',
    'includeArchived',
  ]);
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  const ownerType = ctx.query.get('ownerType');
  const ownerId = ctx.query.get('ownerId');
  const typeCode = ctx.query.get('typeCode');
  const status = ctx.query.get('status');
  const archived = ctx.query.get('includeArchived');
  if (
    limit === undefined ||
    (ownerType !== null && !(BFF_DOCUMENT_OWNER_TYPES as readonly string[]).includes(ownerType)) ||
    (ownerId !== null && (ownerType === null || !ID.test(ownerId))) ||
    (typeCode !== null && !DOCUMENT_TYPE_CODE.test(typeCode)) ||
    (status !== null && !(BFF_DOCUMENT_STATUSES as readonly string[]).includes(status)) ||
    (archived !== null && archived !== 'true' && archived !== 'false')
  )
    return null;
  // The cursor is signed and bound to the tenant and to the filters it was issued for.
  const filter = JSON.stringify([ownerType, ownerId, typeCode, status, archived === 'true', limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return {
    filter,
    limit,
    offset,
    query: {
      limit,
      offset,
      includeArchived: archived === 'true',
      ...(ownerType === null ? {} : { ownerType: ownerType as BffDocumentOwnerType }),
      ...(ownerId === null ? {} : { ownerId }),
      ...(typeCode === null ? {} : { typeCode }),
      ...(status === null ? {} : { status: status as BffDocumentStatus }),
    },
  };
}

/** Strict query of the document history: only `limit` and a signed cursor bound to the tenant and the document. */
function documentHistoryQuery(ctx: RouteContext, tenantId: string, documentId: string) {
  const keys = [...ctx.query.keys()];
  if (keys.some((key) => key !== 'limit' && key !== 'cursor') || new Set(keys).size !== keys.length)
    return null;
  const limitRaw = ctx.query.get('limit');
  const limit = limitRaw === null ? 25 : LIMITS.find((value) => String(value) === limitRaw);
  if (limit === undefined) return null;
  const filter = JSON.stringify(['document', documentId, limit]);
  let offset = 0;
  const cursorRaw = ctx.query.get('cursor');
  if (cursorRaw !== null) {
    const opened = ctx.crypto.openCursor(cursorRaw);
    if (!isOffsetCursor(opened) || opened.t !== tenantId || opened.q !== filter) return null;
    offset = opened.o;
  }
  return { filter, limit, offset, query: { limit, offset } };
}

export const DOCUMENT_ROUTES: readonly Route[] = [
  route('documents.list', async (ctx) => {
    const parsed = documentQuery(ctx, (ctx.session as SessionDetails).tenantId);
    if (!parsed) return bad(ctx);
    const result = await ctx.platform.documents.list(
      ctx.token as string,
      ctx.correlationId,
      parsed.query,
    );
    if (!result.ok || !result.value) return failure(ctx, result.error);
    const { items, total, tenantId } = result.value;
    const next = parsed.offset + parsed.limit;
    const page: Page<BffDocument> = {
      items: items.map(documentBody),
      nextCursor:
        next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
      total,
      sort: { field: 'expiresOn', direction: 'asc' },
    };
    return success(ctx, 'documents.list', page);
  }),
  route('documents.create', async (ctx) => {
    const input = body(
      ctx,
      ['ownerType', 'ownerId', 'typeCode', 'title', 'notes', ...DOCUMENT_VALIDITY_KEYS],
      ['ownerType', 'ownerId', 'typeCode', 'title'],
    );
    if (!input) return bad(ctx);
    return reply(
      ctx,
      'documents.create',
      await ctx.platform.documents.create(ctx.token as string, ctx.correlationId, input),
      documentBody,
    );
  }),
  route(
    'documents.get',
    async (ctx) =>
      reply(
        ctx,
        'documents.get',
        await ctx.platform.documents.get(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
        ),
        documentBody,
      ),
    { id: ID },
  ),
  route(
    'documents.update',
    async (ctx) => {
      const input = body(ctx, ['version', 'title', 'notes'], ['version']);
      if (!input) return bad(ctx);
      const { version, ...patch } = input;
      return reply(
        ctx,
        'documents.update',
        await ctx.platform.documents.update(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          patch,
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.renew',
    async (ctx) => {
      const input = body(ctx, ['version', ...DOCUMENT_VALIDITY_KEYS], ['version']);
      if (!input) return bad(ctx);
      const { version, ...renewal } = input;
      return reply(
        ctx,
        'documents.renew',
        await ctx.platform.documents.renew(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          version,
          renewal,
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.archive',
    async (ctx) => {
      const input = body(ctx, ['version']);
      if (!input) return bad(ctx);
      return reply(
        ctx,
        'documents.archive',
        await ctx.platform.documents.archive(
          ctx.token as string,
          ctx.correlationId,
          ctx.params['id'] as string,
          input['version'],
        ),
        documentBody,
      );
    },
    { id: ID },
  ),
  route(
    'documents.history',
    async (ctx) => {
      const id = ctx.params['id'] as string;
      const parsed = documentHistoryQuery(ctx, (ctx.session as SessionDetails).tenantId, id);
      if (!parsed) return bad(ctx);
      const result = await ctx.platform.documents.history(
        ctx.token as string,
        ctx.correlationId,
        id,
        parsed.query,
      );
      if (!result.ok || !result.value) return failure(ctx, result.error);
      const { items, total, tenantId } = result.value;
      const next = parsed.offset + parsed.limit;
      const page: Page<BffDocumentRevision> = {
        items,
        nextCursor:
          next < total ? ctx.crypto.signCursor({ t: tenantId, o: next, q: parsed.filter }) : null,
        total,
        sort: { field: 'revision', direction: 'desc' },
      };
      return success(ctx, 'documents.history', page);
    },
    { id: ID },
  ),
];
